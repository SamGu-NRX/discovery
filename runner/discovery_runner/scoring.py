"""Taste scoring: embeddings, the contract's score, candidate selection and threshold calibration.

score(post) = mean of the top-5 cosine similarities to positives (Sam's saves)
            - mean of the top-5 similarities to skipped proposals (0 when there are none)
            + author_prior when the author wrote a saved post or an approved proposal's source.

Embeddings come from the Worker's POST /embed (Workers AI bge-base-en-v1.5) and are cached in
cache/embeddings.sqlite keyed by the SHA-256 of the exact text, so a text is embedded once.
"""
import array
import hashlib
import json
import math
import sqlite3
from urllib.parse import urlparse

from . import config

TOP_K = 5


class EmbeddingCache:
    def __init__(self, worker):
        self.worker = worker
        self.db = sqlite3.connect(config.path("cache", "embeddings.sqlite"))
        self.db.execute("CREATE TABLE IF NOT EXISTS emb (key TEXT PRIMARY KEY, vec BLOB NOT NULL)")

    def vectors(self, texts):
        keys = [hashlib.sha256(t.encode()).hexdigest() for t in texts]
        have = {}
        for i in range(0, len(keys), 500):
            chunk = keys[i:i + 500]
            q = f"SELECT key, vec FROM emb WHERE key IN ({','.join('?' * len(chunk))})"
            for k, blob in self.db.execute(q, chunk):
                a = array.array("f")
                a.frombytes(blob)
                have[k] = list(a)
        missing = [(k, t) for k, t in zip(keys, texts) if k not in have]
        uniq = dict(missing)
        if uniq:
            vecs = self.worker.embed(list(uniq.values()))
            for k, v in zip(uniq, vecs):
                v = normalize(v)
                have[k] = v
                self.db.execute("INSERT OR REPLACE INTO emb VALUES (?, ?)", (k, array.array("f", v).tobytes()))
            self.db.commit()
        return [have[k] for k in keys]


def normalize(v):
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def cos(a, b):
    """Cosine of two unit vectors."""
    return sum(x * y for x, y in zip(a, b))


def top_mean(v, refs, k=TOP_K):
    if not refs:
        return 0.0
    sims = sorted((cos(v, r) for r in refs), reverse=True)[:k]
    return sum(sims) / len(sims)


def score(v, author, positives, skipped, prior_authors, author_prior):
    pos = top_mean(v, positives)
    neg = top_mean(v, skipped)
    prior = author_prior if author and author.lower() in prior_authors else 0.0
    return round(pos - neg + prior, 6), {"pos_top5": round(pos, 6), "skipped_top5": round(neg, 6), "author_prior": prior}


def post_text(post, quoted_text=None):
    """What gets embedded: the post text, the quoted post's text and the link domains (contract, Scoring)."""
    parts = [post.get("text") or ""]
    if quoted_text:
        parts.append("Quoted: " + quoted_text)
    domains = sorted({urlparse(u).netloc.removeprefix("www.") for u in post.get("urls") or [] if u})
    if domains:
        parts.append("Links: " + " ".join(domains))
    return "\n".join(p for p in parts if p).strip()


def session_picks(session_scores, fraction):
    """Post ids in the top `fraction` of their session. A session needs 1/fraction posts for one pick (50 at 2%)."""
    picks = set()
    for scores in session_scores.values():
        k = math.floor(len(scores) * fraction)
        picks.update(pid for pid, _ in sorted(scores.items(), key=lambda kv: -kv[1])[:k])
    return picks


def select_candidates(scored, session_scores, cfg):
    """Unbookmarked posts that rank in their session's top fraction or reach the threshold, best first.

    `scored` is [{id, score, bookmarked, ...}]. Bookmarked posts are skipped because the Worker already
    queued them on ingest. The daily cap is applied by the caller, which reserves budget per creation.
    """
    picks = session_picks(session_scores, cfg["session_top_fraction"])
    out = [p for p in scored if not p.get("bookmarked") and (p["id"] in picks or p["score"] >= cfg["score_threshold"])]
    return sorted(out, key=lambda p: -p["score"])


class SessionStore:
    """Every score the runner has written, by session, so a session's top 2% spans all its pulls."""

    def __init__(self):
        self.db = sqlite3.connect(config.path("state", "scores.sqlite"))
        self.db.execute("CREATE TABLE IF NOT EXISTS s (post_id TEXT PRIMARY KEY, session_id TEXT, score REAL,"
                        " bookmarked INTEGER, post_json TEXT, scored_at TEXT)")

    def add(self, rows):
        self.db.executemany("INSERT OR REPLACE INTO s VALUES (?,?,?,?,?,?)", rows)
        self.db.commit()

    def sessions(self, ids):
        out = {}
        for sid in ids:
            out[sid] = dict(self.db.execute("SELECT post_id, score FROM s WHERE session_id=?", (sid,)))
        return out

    def sightings(self):
        return [json.loads(r[0]) for r in self.db.execute("SELECT post_json FROM s WHERE bookmarked=0")]


def run_score(worker, cfg, log=print):
    """Pull unscored posts, score them, write scores back and create candidates. Returns a summary."""
    from .proposals_index import approved_authors, skipped_texts
    emb = EmbeddingCache(worker)
    pos_items = worker.positives()
    pos_vecs = emb.vectors([p["text"] for p in pos_items if p.get("text")])
    prior_authors = {p["author_handle"].lower() for p in pos_items if p.get("author_handle")}
    prior_authors |= approved_authors(worker)
    skipped_vecs = emb.vectors(skipped_texts(worker))
    store = SessionStore()
    totals = {"scored": 0, "candidates": 0, "capped": 0}
    while True:
        config.check_stop()
        posts = worker.unscored_posts(limit=200)
        if not posts:
            break
        by_id = {p["id"]: p for p in posts}
        texts = [post_text(p, (by_id.get(p.get("quoted_id")) or {}).get("text")) for p in posts]
        vecs = emb.vectors(texts)
        scored, rows, out = [], [], []
        for p, v in zip(posts, vecs):
            s, parts = score(v, p.get("author_handle"), pos_vecs, skipped_vecs, prior_authors, cfg["author_prior"])
            scored.append({**p, "score": s, "parts": parts})
            rows.append((p["id"], p.get("session_id"), s, int(bool(p.get("bookmarked"))), json.dumps(p), config.now_iso()))
            out.append({"id": p["id"], "score": s, "parts": parts})
        worker.post_scores(out)
        store.add(rows)
        totals["scored"] += len(out)
        sessions = store.sessions({p.get("session_id") for p in posts if p.get("session_id")})
        for c in select_candidates(scored, sessions, cfg):
            if not config.take("unbookmarked_candidates", cfg["unbookmarked_candidates_per_day"]):
                totals["capped"] += 1
                continue
            title = f"@{c.get('author_handle')}: {(c.get('text') or '')[:90]}"
            worker.create_candidate("x_post", c["id"], title, f"https://x.com/{c.get('author_handle')}/status/{c['id']}",
                                    c["score"], c["parts"])
            totals["candidates"] += 1
        if len(posts) < 200:
            break
    log(f"score: {totals}")
    return totals


def calibrate(worker, cfg, positives=None, sightings=None, sighting_source="x_posts"):
    """Leave-one-out score of each save against the other saves, against random sightings' scores.

    Returns the numbers and a suggested threshold: the 98th percentile of sighting scores, so about 2%
    of random sightings would pass on taste alone. The caller decides whether to write it to config.
    """
    emb = EmbeddingCache(worker)
    positives = positives if positives is not None else worker.positives()
    sightings = sightings if sightings is not None else SessionStore().sightings()
    pv = emb.vectors([p["text"] for p in positives])
    sv = emb.vectors([post_text(s) for s in sightings])
    authors = [(p.get("author_handle") or "").lower() for p in positives]
    loo = []
    for i, v in enumerate(pv):
        rest = pv[:i] + pv[i + 1:]
        others = set(authors[:i] + authors[i + 1:])
        loo.append(score(v, authors[i], rest, [], others, cfg["author_prior"])[0])
    pos_authors = set(authors)
    rand = [score(v, (s.get("author_handle") or "").lower(), pv, [], pos_authors, cfg["author_prior"])[0]
            for v, s in zip(sv, sightings)]
    if not loo or not rand:
        return {"error": f"need saves and sightings, got {len(loo)} and {len(rand)}"}
    wins = sum((a > b) + 0.5 * (a == b) for a in loo for b in rand)
    rs, ls = sorted(rand), sorted(loo)

    def pct(xs, q):
        return round(xs[min(len(xs) - 1, int(q * len(xs)))], 4)

    thr = pct(rs, 0.98)
    return {
        "measured_at": config.now_iso(), "n_saves": len(loo), "n_sightings": len(rand), "sighting_source": sighting_source,
        "auc_save_loo_vs_sighting": round(wins / (len(loo) * len(rand)), 4),
        "save_loo": {"p10": pct(ls, .1), "p25": pct(ls, .25), "median": pct(ls, .5), "p75": pct(ls, .75)},
        "sightings": {"median": pct(rs, .5), "p90": pct(rs, .9), "p98": thr, "max": rs[-1]},
        "suggested_threshold": thr,
        "saves_at_or_above_suggested": round(sum(x >= thr for x in loo) / len(loo), 4),
        "saves_at_or_above_contract_0.75": round(sum(x >= 0.75 for x in loo) / len(loo), 4),
        "sightings_at_or_above_contract_0.75": round(sum(x >= 0.75 for x in rand) / len(rand), 4),
    }
