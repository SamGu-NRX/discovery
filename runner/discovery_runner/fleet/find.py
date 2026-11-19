"""`find`: which T3 thread was that? Searches titles, Sam's messages and agents' answers, archived threads
included, straight from T3's database.

A thread id pasted in the question wins outright. Otherwise the question's words, minus the ones every such
question shares ("where", "thread", "T3") and conversational filler, are looked up one by one: in thread
titles, and in T3's trigram message index. Long words are cut to a stem first ("scheduling" finds
"schedule"), because the index matches substrings; three-letter words must match as whole words, because
"ali" is also inside "quality". Scoring is BM25 over threads: a word found in few threads counts for more,
a long thread gets no credit just for being long, a title hit counts twice, and Sam's own messages twice an
agent's. No model is called.
"""
import math
import re

from . import probe

STOP = set("""
a about above after again all also am an and any are as at be because been before being but by can could did do
does doing done for from had has have having he her here him his how i if in into is it its just like me might
more most my no not now of on once only or other our out over own same she should so some such than that the
their them then there these they this those through to too under until up very was we were what when where which
while who whom why will with would you your yours
thread threads chat chats t3 code codex claude find look lookup search where which whats what's previously
earlier before talk talked talking discuss discussed discussing remember thing stuff point link give tell show
know think want wanted need please pls btw also one ones last latest maybe probably actually really
especially essentially basically whatever okay ok yeah yes get got make made let lets i'll i'm i've it's there's
don't didn't doesn't can't wanna gonna may time ago new info saying try use used using way lot lots kind sort
first sure right well side specifically referring following within past least
""".split())
UUID_PART = re.compile(r"\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b[0-9a-f]{8}\b")
URL_NOISE = {"https", "http", "file", "www", "html", "users", "samgu", "index"}
SUFFIXES = ("ations", "ation", "ings", "ing", "ers", "ies", "ied", "ed", "es", "er", "s")


def stem(w: str) -> str:
    for suf in SUFFIXES:
        if len(w) - len(suf) >= 5 and w.endswith(suf):
            return w[:-len(suf)]
    return w


def terms(question: str) -> list[str]:
    """Quoted phrases, pasted URLs (as exact phrases), pairs of adjacent content words, then single stems."""
    q = question.replace("\u201c", '"').replace("\u201d", '"')
    out = [p.lower() for p in re.findall(r'"([^"]{3,80})"', q)]
    rest = re.sub(r'"[^"]*"', " | ", q.lower())
    for url in re.findall(r"\b(?:https?|file)://(\S+)", rest):
        url = url.rstrip(").,")
        out.append(url[:80])
        out += [seg for seg in re.split(r"[/:?=#&.]+", url)
                if len(seg) >= 4 and seg not in URL_NOISE and seg not in out and not seg.isdigit()]
    rest = re.sub(r"\S+://\S+", " | ", rest)
    singles, pairs, prev = [], [], None
    for w in re.findall(r"[a-z0-9][a-z0-9'_-]*|[^\sa-z0-9]", rest):
        w = w.strip("'-_")
        content = len(w) >= 3 and w not in STOP and not w.isdigit() and not UUID_PART.fullmatch(w) and w[0].isalnum()
        if not content:
            prev = None
            continue
        if prev:
            pairs.append(f"{prev} {w}")
        prev = w
        singles.append(stem(w))
    for t in pairs + singles:
        if t not in out:
            out.append(t)
    return out


def thread_ids(con, question: str) -> list[str]:
    """Threads whose id (or its first 8 hex digits, as Sam often pastes it) appears in the question."""
    out = []
    for m in UUID_PART.findall(question.lower()):
        for (tid,) in con.execute(f"SELECT thread_id FROM {probe.THREADS} WHERE thread_id = ? OR thread_id LIKE ?"
                                  " LIMIT 2", (m, f"{m}-%")):
            if tid not in out:
                out.append(tid)
    return out


TEXT = "json_extract(m.payload_json, '$.text')"


def _fts(term: str) -> str:
    return '"' + term.replace('"', '""') + '"'


def search(con, question: str, k=3, before=None, exclude=(), per_term_rows=4000) -> list[dict]:
    pinned = [t for t in thread_ids(con, question) if t not in exclude]
    ts = terms(question)
    if not ts and not pinned:
        return []
    n_threads = con.execute(f"SELECT count(*) FROM {probe.THREADS} WHERE deleted_at IS NULL").fetchone()[0]
    title_hit, tf, df = {}, {}, {}
    for t in ts:
        threads = set()
        for (tid, title) in con.execute(f"SELECT thread_id, title FROM {probe.THREADS} WHERE deleted_at IS NULL AND"
                                         " lower(title) LIKE ?", (f"%{t}%",)):
            if len(t) <= 3 and not re.search(rf"\b{re.escape(t)}\b", title or "", re.I):
                continue
            title_hit.setdefault(tid, set()).add(t)
            threads.add(tid)
        whole = re.compile(rf"\b{re.escape(t)}\b", re.I) if len(t) <= 3 else None
        for tid, by, text in con.execute(
                f"SELECT m.thread_id, json_extract(m.payload_json, '$.createdBy'),"
                f" {TEXT if whole else 'NULL'}"
                f" FROM {probe.MESSAGE_SEARCH} s"
                f" JOIN {probe.MESSAGES} m ON m.rowid = s.rowid WHERE {probe.MESSAGE_SEARCH} MATCH ?"
                " AND m.role IN ('user', 'assistant') LIMIT ?", (_fts(t), per_term_rows)):
            if whole and not whole.search(text or ""):
                continue
            tf.setdefault(tid, {})
            tf[tid][t] = tf[tid].get(t, 0) + (2 if by == "user" else 1)
            threads.add(tid)
        df[t] = len(threads)
    idf = {t: math.log(1 + (n_threads - d + 0.5) / (d + 0.5)) for t, d in df.items() if d}
    # Presence first: rare words matched anywhere in the thread pick the candidates.
    coverage = {}
    for tid in set(tf) | set(title_hit):
        matched = set(tf.get(tid, {})) | title_hit.get(tid, set())
        coverage[tid] = sum(idf[t] for t in matched)
    pool = pinned + [tid for tid, _ in sorted(coverage.items(), key=lambda kv: -kv[1])[:300] if tid not in pinned]
    if not pool:
        return []
    marks = ",".join("?" * len(pool))
    meta = {r["thread_id"]: dict(r) for r in con.execute(
        f"SELECT thread_id, title, created_at, updated_at, archived_at, deleted_at FROM {probe.THREADS}"
        f" WHERE thread_id IN ({marks})", pool)}
    size = dict(con.execute(f"SELECT thread_id, count(*) FROM {probe.MESSAGES} WHERE thread_id IN ({marks})"
                            " GROUP BY thread_id", pool).fetchall())
    avg = (sum(size.values()) / len(size)) if size else 1
    k1, b = 1.2, 0.75
    out = []
    for tid in pool:
        m = meta.get(tid)
        if not m or m["deleted_at"] or tid in exclude or (before and m["created_at"] >= before):
            continue
        norm = k1 * (1 - b + b * size.get(tid, 1) / avg)
        score = 0.0
        for t, w in idf.items():
            f = tf.get(tid, {}).get(t, 0)
            score += w * (2.0 * (t in title_hit.get(tid, ())) + f * (k1 + 1) / (f + norm))
        if tid in pinned:
            score = 1e9
        out.append({"thread_id": tid, "title": m["title"], "score": round(score, 3),
                    "matched": sorted(set(tf.get(tid, {})) | title_hit.get(tid, set())),
                    "updated_at": m["updated_at"], "archived": m["archived_at"] is not None})
    out.sort(key=lambda r: (-r["score"], -_ts(r["updated_at"])))
    return out[:k]


def _ts(s):
    import datetime as dt
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def evaluate(con, cases, k=3) -> dict:
    """Score `search` on labeled cases: each has question, asked_in_thread, asked_at and answers."""
    rows = []
    for c in cases:
        got = search(con, c["question"], k=k, before=c["asked_at"], exclude={c["asked_in_thread"]})
        ids = [g["thread_id"] for g in got]
        rows.append({"id": c["id"], "hit": any(a in ids for a in c["answers"]), "top": [g["title"] for g in got],
                     "want": c.get("answer_titles")})
    return {"answered": sum(r["hit"] for r in rows), "total": len(rows), "cases": rows}
