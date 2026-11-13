"""Scores Sam's 170 Nov 12 saves against the agent-harnesses lens.

Exemplars come from his Oct 26 saves, not the Nov 12 ones, so the scoring
is not circular: every Oct 26 save whose archive findings carry a harness
topic. Each save is scored on its post text, the text the reader sees in the
feed (worker/src/lens.ts labels posts by their text). Raw and
background-centered scoring are both reported; the background is the mean
unit vector of the replay's captured posts (embeddings.npy from
lens-centering.py).

Gold is the archive lead's disposition of the 170 saves
(curated/saves-nov12/notes.md: kept or skipped, against what bears on Sam's
model and tool setup) and the topics on the kept saves' findings.

Usage: venv/bin/python scripts/lens-score-saves.py <raw-oct dir> <raw-nov dir> <oct findings.json>
         <nov findings.json> <nov notes.md> <embeddings.npy> <out.json>
"""
import json, re, sys, os
import numpy as np
from fastembed import TextEmbedding

raw_oct, raw_nov, oct_findings, nov_findings, nov_notes, bg_path, out_path = sys.argv[1:8]

CHARTER = (
    "Agent harnesses: how Claude Code, Codex, T3 Code and other coding-agent harnesses are set up and run, "
    "including subagents and orchestration, model routing and effort, MCP tools, skills and instruction files, "
    "memory, sessions and long-running agents."
)
HARNESS_TOPICS = {
    "orchestration", "model-routing", "harness-choice", "subagents", "t3-code", "codex", "skills", "mcp",
    "mcp-context-cost", "tool-loading", "memory-second-brain", "threads-sessions", "long-running-agents",
    "instructions-files", "caching-compaction", "context-management", "computer-use", "effort-levels", "grokbot", "hooks",
}
MARK = re.compile(r"^\[[A-Z0-9 ]+\]")


def post_text(path):
    lines = open(path, encoding="utf-8").read().splitlines()
    try:
        start = lines.index("[POST TEXT]") + 1
    except ValueError:
        return ""
    out = []
    for line in lines[start:]:
        if MARK.match(line):
            break
        out.append(line)
    return "\n".join(out).strip()


# The thin-post rule of src/lens-text.ts: under 15 words, not counting links
# and @mentions, or links making up more than half the post. Such a post is
# embedded with its first linked page's title and first prose paragraph. The
# Worker takes those from the knowledge store's bundle; here they come from
# the same archive's raw file ("## LINKED <url> [kind] <title>" sections).
URL = re.compile(r"https?://\S+")
THIN_WORDS = 15


def is_thin(text):
    words = [w for w in re.sub(r"@\w+", " ", URL.sub(" ", text)).split() if re.search(r"[^\W_]", w)]
    return len(words) < THIN_WORDS or len("".join(URL.findall(text))) * 2 > len(text.strip())


MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")


def first_paragraph(text):
    """firstParagraph of src/lens-text.ts: only the first 20,000 characters;
    a markdown link keeps its text, but its letters do not count as prose."""
    for block in re.split(r"\n\s*\n", (text or "")[:20_000]):
        tidy = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", re.sub(r"<[^>]+>", " ", block))
        if len(re.findall(r"[^\W\d_]", URL.sub("", MD_LINK.sub(" ", tidy)))) < 40:
            continue
        return re.sub(r"\s+", " ", MD_LINK.sub(r"\1", tidy)).strip()[:600]
    return None


def linked_context(path):
    lines = open(path, encoding="utf-8").read().splitlines()
    for i, line in enumerate(lines):
        m = re.match(r"^## LINKED (\S+)(.*)$", line)
        if not m or not m.group(1).startswith("http"):
            continue
        title = re.sub(r"\[[^\]]*\]|\([^)]*\)", " ", m.group(2)).strip()
        body = []
        for nxt in lines[i + 1 :]:
            if nxt.startswith("## LINKED "):
                break
            if nxt.startswith("(file ") or "Retrieved UTC:" in nxt:
                continue
            t = re.match(r"^Title:\s*(.+)$", nxt)
            if t and not title:
                title = t.group(1).strip()
                continue
            body.append(nxt)
        paragraph = first_paragraph("\n".join(body))
        if title or paragraph:
            return title or None, paragraph
    return None


def blocks(path):
    """The raw file's [MARKER] sections, as (marker, rest of header line, text)."""
    out, cur = [], None
    for line in open(path, encoding="utf-8").read().splitlines():
        m = re.match(r"^\[([A-Z0-9 ]+)\](.*)$", line)
        if m:
            cur = [m.group(1), m.group(2).strip(), []]
            out.append(cur)
        elif line.startswith("## LINKED "):
            cur = None
        elif cur is not None:
            cur[2].append(line)
    return [(k, rest, "\n".join(t).strip()) for k, rest, t in out]


def parent_text(path, save_id):
    """The post the save replies to: [PARENT POST TEXT] (another author), else
    the author's own thread post just before the save (the newest one with a
    smaller id), as the bundle's thread gives the Worker."""
    bs = blocks(path)
    for k, _, t in bs:
        if k == "PARENT POST TEXT" and t:
            return t
    earlier = []
    for i, (k, _, t) in enumerate(bs):
        if k == "THREAD POST URL":
            m = re.search(r"status/(\d+)", t)
            text = bs[i + 2][2] if i + 2 < len(bs) and bs[i + 2][0] == "THREAD POST TEXT" else ""
            if m and int(m.group(1)) < int(save_id) and text:
                earlier.append((int(m.group(1)), text))
    return max(earlier)[1] if earlier else None


def image_texts(path):
    """The text in the save's own images ([IMAGE TEXT n]), in order."""
    return [t for k, _, t in blocks(path) if re.fullmatch(r"IMAGE TEXT \d+", k) and t]


PART_MAX, TITLE_MAX, COMPOSED_MAX = 600, 200, 2_000
FULL = ("parent", "images", "link")


def with_context(path, text, save_id, parts):
    """composeText of src/lens-text.ts: for a thin post, the parent, the
    images' text and the link's title and paragraph, each trimmed and cut to
    600 characters (a title to 200), the whole cut to 2,000."""
    if not is_thin(text):
        return text
    cut = lambda s, n: (s or "").strip()[:n]
    out = [text]
    if "parent" in parts:
        out.append(cut(parent_text(path, save_id), PART_MAX))
    if "images" in parts:
        out.append(cut("\n".join(image_texts(path)), PART_MAX))
    if "link" in parts:
        ctx = linked_context(path)
        if ctx:
            title, para = ctx
            out += [cut(title, TITLE_MAX), cut(para, PART_MAX)]
    return "\n\n".join(p for p in out if p and p.strip())[:COMPOSED_MAX]


def with_link(path, text, save_id=None):
    return with_context(path, text, save_id, ("link",))


def topics_by_save(path):
    by = {}
    for e in json.load(open(path)):
        m = re.search(r"status/(\d+)", e.get("source_url") or "")
        if m:
            by.setdefault(m.group(1), set()).update(e.get("topics", []))
    return by


oct_topics = topics_by_save(oct_findings)
nov_topics = topics_by_save(nov_findings)
exemplars = {}
exemplars_linked = {}
exemplars_full = {}
for f in os.listdir(raw_oct):
    sid = f.split(".")[0]
    if oct_topics.get(sid, set()) & HARNESS_TOPICS:
        t = post_text(os.path.join(raw_oct, f))
        if t:
            exemplars[sid] = t
            exemplars_linked[sid] = with_link(os.path.join(raw_oct, f), t)
            exemplars_full[sid] = with_context(os.path.join(raw_oct, f), t, sid, FULL)

disp = {}
for line in open(nov_notes, encoding="utf-8"):
    m = re.match(r"^\d{3}\. (\d+) @(\S+) \((kept|skipped)", line)
    if m:
        disp[m.group(1)] = {"handle": m.group(2), "kept": m.group(3) == "kept"}
saves = {}
saves_linked = {}
saves_full = {}
for f in os.listdir(raw_nov):
    sid = f.split(".")[0]
    if sid in disp:
        saves[sid] = post_text(os.path.join(raw_nov, f))
        saves_linked[sid] = with_link(os.path.join(raw_nov, f), saves[sid])
        saves_full[sid] = with_context(os.path.join(raw_nov, f), saves[sid], sid, FULL)

model = TextEmbedding("BAAI/bge-base-en-v1.5", threads=2)
unit = lambda m: m / np.linalg.norm(m, axis=-1, keepdims=True)
ex_ids = list(exemplars)
sv_ids = [s for s in saves if saves[s]]
EX = unit(np.array(list(model.embed([exemplars[i] for i in ex_ids], batch_size=32))))
SV = unit(np.array(list(model.embed([saves[i] for i in sv_ids], batch_size=32))))
EXL = unit(np.array(list(model.embed([exemplars_linked[i] for i in ex_ids], batch_size=32))))
SVL = unit(np.array(list(model.embed([saves_linked[i] for i in sv_ids], batch_size=32))))
EXF = unit(np.array(list(model.embed([exemplars_full[i] for i in ex_ids], batch_size=32))))
SVF = unit(np.array(list(model.embed([saves_full[i] for i in sv_ids], batch_size=32))))
bg = unit(np.load(bg_path)).mean(axis=0)
thin = [s for s in sv_ids if saves_linked[s] != saves[s]]

kept = np.array([disp[s]["kept"] for s in sv_ids])
harness = np.array([disp[s]["kept"] and bool(nov_topics.get(s, set()) & HARNESS_TOPICS) for s in sv_ids])


def auc(scores, labels):
    pos, neg = scores[labels], scores[~labels]
    return float((pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean())


def rates(flag, gold):
    n = int(flag.sum())
    hit = int((flag & gold).sum())
    return {"labeled": n, "precision": round(hit / n, 3) if n else None, "recall": round(hit / int(gold.sum()), 3)}


report = {
    "charter": CHARTER,
    "exemplars": {"count": len(ex_ids), "source": "Oct 26 saves whose findings carry a harness topic", "ids": ex_ids},
    "saves": {"scored": len(sv_ids), "without_post_text": [s for s in saves if not saves[s]], "kept": int(kept.sum()), "kept_with_harness_topic": int(harness.sum()),
              "thin_with_link_context": len(thin), "thin_exemplars_with_link_context": sum(exemplars_linked[i] != exemplars[i] for i in ex_ids),
              "thin_with_any_context": sum(saves_full[s] != saves[s] for s in sv_ids), "thin_exemplars_with_any_context": sum(exemplars_full[i] != exemplars[i] for i in ex_ids)},
}
for name, ex, sv in [("raw", EX, SV), ("centered", unit(EX - bg), unit(SV - bg)), ("centered_with_links", unit(EXL - bg), unit(SVL - bg)), ("centered_with_context", unit(EXF - bg), unit(SVF - bg))]:
    c = unit(ex.mean(axis=0))
    ec = np.sort(ex @ c)
    open_at, glance_at = float(np.median(ec)), float(ec[int(np.floor(0.1 * (len(ec) - 1)))])
    t = sv @ c
    opened, near = t >= open_at, t >= glance_at
    order = np.argsort(-t)
    report[name] = {
        "open_at": round(open_at, 3), "glance_at": round(glance_at, 3),
        "spread": {k: round(float(np.quantile(t, q)), 3) for k, q in [("p10", 0.1), ("p50", 0.5), ("p90", 0.9)]},
        "auc_kept_vs_skipped": round(auc(t, kept), 3),
        "auc_harness_vs_rest": round(auc(t, harness), 3),
        "open": {"vs_kept": rates(opened, kept), "vs_harness": rates(opened, harness)},
        "near": {"vs_kept": rates(near, kept), "vs_harness": rates(near, harness)},
        "top15": [{"id": sv_ids[k], "taste": round(float(t[k]), 3), "kept": bool(kept[k]), "harness": bool(harness[k]), "handle": disp[sv_ids[k]]["handle"], "text": saves[sv_ids[k]][:110].replace("\n", " ")} for k in order[:15]],
        "open_but_skipped": [{"id": sv_ids[k], "taste": round(float(t[k]), 3), "handle": disp[sv_ids[k]]["handle"], "text": saves[sv_ids[k]][:110].replace("\n", " ")} for k in order if opened[k] and not kept[k]],
        "harness_missed": [{"id": sv_ids[k], "taste": round(float(t[k]), 3), "handle": disp[sv_ids[k]]["handle"], "text": saves[sv_ids[k]][:110].replace("\n", " ")} for k in order if harness[k] and not near[k]],
    }
json.dump(report, open(out_path, "w"), indent=1)
print(json.dumps({k: (v if k in ("saves",) else {kk: vv for kk, vv in v.items() if kk not in ("top15", "open_but_skipped", "harness_missed", "ids")}) if isinstance(v, dict) else v for k, v in report.items()}, indent=1))
