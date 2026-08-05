#!/usr/bin/env python3
"""Build the HSC Business Studies SAQ organiser.

Reads the syllabus taxonomy and the per-paper extraction files, merges and
de-duplicates the questions, then writes a single self-contained HTML page
with the question data inlined.

    python3 scripts/build-saq.py --extracted <dir> --taxonomy <file>
"""

import argparse
import base64
import hashlib
import json
import os
import re
import sys
from collections import Counter, OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_HTML = os.path.join(ROOT, "study", "hsc-business-studies-saq.html")
OUT_JSON = os.path.join(ROOT, "study", "data", "questions.json")
IMG_DIR = os.path.join(ROOT, "study", "img")

TOPIC_ORDER = ["operations", "marketing", "finance", "hr"]


def norm_text(s):
    """Normalise question wording for duplicate detection."""
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def short_label(label, collides):
    """Chip-sized version of a syllabus point label.

    Most labels read "Heading — detail, detail". The heading alone is enough,
    except where several points in a topic share one (Legal —, External
    sources —), in which case the first clause of the detail disambiguates.
    """
    base, _, rest = label.partition(" — ")
    if not collides or not rest:
        return base
    detail = re.split(r"[,(]", rest)[0].strip()
    return f"{base} — {detail}" if detail else base


def load_taxonomy(path):
    with open(path) as fh:
        tax = json.load(fh)

    # A heading is ambiguous when two points in the same topic share it.
    heads = Counter()
    for topic, tdata in tax.items():
        for points in tdata["sections"].values():
            for p in points:
                heads[(topic, p["label"].partition(" — ")[0])] += 1

    valid = {}
    for topic, tdata in tax.items():
        for section, points in tdata["sections"].items():
            for p in points:
                head = p["label"].partition(" — ")[0]
                p["short"] = short_label(p["label"], heads[(topic, head)] > 1)
                valid[p["id"]] = {
                    "topic": topic,
                    "section": section,
                    "label": p["label"],
                    "short": p["short"],
                }
    return tax, valid


def load_questions(extracted_dir, valid_ids):
    docs = []
    for name in sorted(os.listdir(extracted_dir)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(extracted_dir, name)
        try:
            with open(path) as fh:
                docs.append((name, json.load(fh)))
        except json.JSONDecodeError as exc:
            print(f"  ! skipping malformed {name}: {exc}", file=sys.stderr)
    return docs


def detect_rules(img_path):
    """Does this crop already show the paper's own ruled answer lines?

    Guessing from the image height was wrong — a tall crop is often a stimulus
    graph with no writing space at all. Instead look for the lines: rows of
    mostly-dark pixels spanning the width, repeating down the page. Works for
    dotted rules too, which is what most of these papers print.
    """
    try:
        from PIL import Image
    except ImportError:
        return False
    try:
        im = Image.open(img_path).convert("L")
    except Exception:
        return False

    w, h = im.size
    if w < 80 or h < 80:
        return False
    px = im.load()
    step = max(1, w // 300)          # sample columns for speed
    cols = list(range(0, w, step))
    ncols = len(cols)

    def dark_fraction(y):
        return sum(1 for x in cols if px[x, y] < 170) / ncols

    # Candidate rows reach across the width. The threshold is low because most
    # of these papers print dotted rules, which are only part-dark.
    rows = [y for y in range(h) if dark_fraction(y) > 0.22]
    if len(rows) < 4:
        return False

    # Group adjacent rows into runs, and keep only thin ones: an answer rule is
    # a couple of pixels tall, whereas a row of text is ten or more.
    runs, start, prev = [], rows[0], rows[0]
    for y in rows[1:] + [None]:
        if y is None or y - prev > 2:
            runs.append((start, prev))
            start = y
        prev = y
    lines = [(a + b) // 2 for a, b in runs if (b - a + 1) <= 5]
    if len(lines) < 4:
        return False

    gaps = [b - a for a, b in zip(lines, lines[1:])]
    gaps.sort()
    median = gaps[len(gaps) // 2]
    if not (14 <= median <= 130):
        return False

    # Answer rules repeat at a steady pitch; box borders and table rows do not.
    even = sum(1 for g in gaps if abs(g - median) <= max(4, median * 0.25))
    if even < max(3, int(len(gaps) * 0.6)):
        return False

    # And the space between them is blank — that is where you write.
    blanks = 0
    for a, b in zip(lines, lines[1:]):
        if b - a < 8:
            continue
        mid = range(a + 3, b - 2)
        if not mid:
            continue
        if max(dark_fraction(y) for y in mid) < 0.12:
            blanks += 1
    return blanks >= 3


def load_crops(path, valid_ids):
    """Screenshots cropped from a scanned paper, catalogued by reading them.

    These are the real thing — an image of the question as printed — so they
    take priority over any retyped version of the same question.
    """
    if not path or not os.path.exists(path):
        return []
    with open(path) as fh:
        records = json.load(fh)
    if isinstance(records, dict):
        records = records.get("records", [])

    out = []
    for r in records:
        text = (r.get("text") or "").strip()
        if not text:
            continue
        points = [p for p in (r.get("syllabusPoints") or []) if p in valid_ids]
        if not points:
            continue
        kind = r.get("kind") or "short-answer"
        out.append({
            "number": (r.get("number") or "").strip(),
            "text": text,
            "marks": r.get("marks") if isinstance(r.get("marks"), int) else None,
            "type": "multiple-choice" if kind == "multiple-choice" else kind,
            "section": None,
            "stimulus": r.get("stimulus") or None,
            "topics": sorted({valid_ids[p]["topic"] for p in points}),
            "syllabusPoints": points,
            "image": r.get("image"),
            "imageHasRules": detect_rules(os.path.join(IMG_DIR, r["image"])) if r.get("image") else False,
            "verb": None,
            "legible": r.get("legible", True),
        })
    return out


def closest_crop(key, crop_keys):
    """Match a retyped question to the same question captured as a screenshot.

    Wording recovered from a scan never matches the text PDF character for
    character, so an exact key misses and the question prints twice — once as
    an image and once as text.
    """
    import difflib
    best, score = None, 0.0
    for ck in crop_keys:
        r = difflib.SequenceMatcher(None, key[:160], ck[:160]).ratio()
        if r > score:
            best, score = ck, r
    return best if score >= 0.78 else None


def build(extracted_dir, taxonomy_path, fragment_path=None, crops_path=None):
    tax, valid_ids = load_taxonomy(taxonomy_path)
    docs = load_questions(extracted_dir, valid_ids)
    crops = load_crops(crops_path, valid_ids)

    questions = []
    seen = {}
    dropped_ids = Counter()
    dupes = 0

    # Crops go in first so a screenshot always wins over the retyped version.
    crop_keys = []
    for c in crops:
        key = norm_text(c["text"])[:220]
        rec = OrderedDict()
        rec["id"] = hashlib.sha1(("crop:" + (c["image"] or key)).encode()).hexdigest()[:10]
        rec["number"] = c["number"]
        rec["text"] = c["text"]
        rec["marks"] = c["marks"]
        rec["verb"] = None
        rec["type"] = c["type"]
        rec["section"] = None
        rec["stimulus"] = c["stimulus"]
        rec["topics"] = c["topics"]
        rec["syllabusPoints"] = c["syllabusPoints"]
        rec["sources"] = ["2021 Finance Practice HSC Questions"]
        rec["kind"] = "Question bank (scanned)"
        rec["year"] = None
        rec["image"] = c["image"]
        rec["imageHasRules"] = c["imageHasRules"]
        questions.append(rec)
        seen[key] = rec
        crop_keys.append(key)

    for name, doc in docs:
        src_title = doc.get("title") or doc.get("slug") or name
        src_kind = doc.get("source") or ""
        year = doc.get("year")
        for q in doc.get("questions", []):
            text = (q.get("text") or "").strip()
            if len(text) < 8:
                continue

            points = []
            for pid in q.get("syllabusPoints") or []:
                if pid in valid_ids:
                    if pid not in points:
                        points.append(pid)
                else:
                    dropped_ids[pid] += 1

            topics = [t for t in (q.get("topics") or []) if t in TOPIC_ORDER]
            # Backfill topics from the syllabus points, and vice versa.
            for pid in points:
                t = valid_ids[pid]["topic"]
                if t not in topics:
                    topics.append(t)
            if not topics and not points:
                continue

            key = norm_text(text)[:220]
            if key not in seen:
                near = closest_crop(key, crop_keys)
                if near:
                    key = near
            if key in seen:
                prev = seen[key]
                # Same question appears in several papers: keep one card, list
                # every paper it came from, and union the syllabus tags.
                tag = f"{src_title}{' ' + str(year) if year and str(year) not in src_title else ''}"
                if tag not in prev["sources"]:
                    prev["sources"].append(tag)
                for pid in points:
                    if pid not in prev["syllabusPoints"]:
                        prev["syllabusPoints"].append(pid)
                for t in topics:
                    if t not in prev["topics"]:
                        prev["topics"].append(t)
                if not prev.get("stimulus") and q.get("stimulus"):
                    prev["stimulus"] = q["stimulus"]
                if prev.get("image") and prev["sources"][0] != src_title:
                    # A retyped copy confirms the crop's wording; keep the image.
                    pass
                dupes += 1
                continue

            marks = q.get("marks")
            if isinstance(marks, str) and marks.isdigit():
                marks = int(marks)
            if not isinstance(marks, int):
                marks = None

            rec = OrderedDict()
            rec["id"] = hashlib.sha1(key.encode()).hexdigest()[:10]
            rec["number"] = (q.get("number") or "").strip()
            rec["text"] = text
            rec["marks"] = marks
            rec["verb"] = (q.get("verb") or "").strip().lower() or None
            rec["type"] = q.get("type") or "short-answer"
            rec["section"] = q.get("section") or None
            rec["stimulus"] = (q.get("stimulus") or None)
            rec["topics"] = topics
            rec["syllabusPoints"] = points
            rec["sources"] = [src_title]
            rec["kind"] = src_kind
            rec["year"] = year
            questions.append(rec)
            seen[key] = rec

    # Sort: highest-value questions first within a point, then by recency.
    questions.sort(key=lambda r: (-(r["marks"] or 0), -(r["year"] or 0), r["text"][:40]))

    counts = Counter()
    for q in questions:
        for pid in q["syllabusPoints"]:
            counts[pid] += 1

    payload = {
        "taxonomy": tax,
        "questions": questions,
        "counts": dict(counts),
        "sources": sorted({s for q in questions for s in q["sources"]}),
    }

    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w") as fh:
        json.dump(payload, fh, indent=1)

    html = render(payload)
    os.makedirs(os.path.dirname(OUT_HTML), exist_ok=True)
    with open(OUT_HTML, "w") as fh:
        fh.write(html)

    if fragment_path:
        embedded = inline_images(payload, IMG_DIR)
        frag = to_fragment(render(payload, embedded))
        with open(fragment_path, "w") as fh:
            fh.write(frag)
        print(f"wrote {fragment_path} ({len(embedded)} images inlined, {len(frag)/1e6:.1f} MB)")

    uncovered = [pid for pid in valid_ids if counts.get(pid, 0) == 0]
    shots = sum(1 for q in questions if q.get("image"))
    print(f"papers        : {len(docs)}")
    print(f"screenshots    : {shots}")
    print(f"questions      : {len(questions)} ({dupes} cross-paper duplicates merged)")
    print(f"syllabus points: {len(valid_ids) - len(uncovered)}/{len(valid_ids)} covered")
    if dropped_ids:
        print(f"dropped bad ids: {dict(dropped_ids)}")
    if uncovered:
        print("uncovered      : " + ", ".join(sorted(uncovered)))
    print(f"wrote {OUT_HTML}")
    print(f"wrote {OUT_JSON}")
    return payload


def render(payload, images=None):
    data = json.dumps(payload, separators=(",", ":"))
    html = HTML_TEMPLATE.replace("/*__DATA__*/null", data)
    return html.replace("/*__IMAGES__*/{}", json.dumps(images or {}, separators=(",", ":")))


def inline_images(payload, img_dir):
    """Base64 the crops so a published page carries them with it."""
    out = {}
    for name in sorted({q["image"] for q in payload["questions"] if q.get("image")}):
        path = os.path.join(img_dir, name)
        if not os.path.exists(path):
            continue
        with open(path, "rb") as fh:
            out[name] = "data:image/png;base64," + base64.b64encode(fh.read()).decode()
    return out


def to_fragment(full_html):
    """Strip the document skeleton for publishing as an Artifact.

    Artifacts supply their own <!doctype>/<html>/<head>/<body>, so the file has
    to be title + style + body content only.
    """
    title = re.search(r"<title>.*?</title>", full_html, re.S).group(0)
    style = re.search(r"<style>.*?</style>", full_html, re.S).group(0)
    body = re.search(r"<body>(.*)</body>", full_html, re.S).group(1)
    return f"{title}\n{style}\n{body.strip()}\n"


HTML_TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HSC Business Studies — SAQ by Syllabus Point</title>
<style>
/* Colour carries exactly one meaning here: which business function you are in.
   The four hues below are the only saturated colour on the page, and the
   interface borrows the hue of whichever topic is open for its own selected
   states — so the chrome always tells you where you are without a fifth
   competing accent. Neutrals are biased slightly blue to sit under them. */
:root{
  --bg:#f5f6f9; --panel:#fff; --ink:#14171d; --muted:#596273; --line:#e1e4eb;
  --chip:#eceff4; --done:#15803d; --done-soft:#e7f6ec;
  --ops:#0f766e; --ops-soft:#ddf0ed;
  --mkt:#a4530a; --mkt-soft:#fbeddc;
  --fin:#1d4ed8; --fin-soft:#e4ebfd;
  --hr:#8b2fd6;  --hr-soft:#f1e6fd;
  --accent:var(--ink); --accent-soft:var(--chip);
  --shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.08);
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  /* Questions are set in a serif, the way they are printed on the real paper. */
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0e1115; --panel:#161a20; --ink:#e7eaef; --muted:#949dac; --line:#272d36;
    --chip:#222831; --done:#4ade80; --done-soft:#14301f;
    --ops:#5eead4; --ops-soft:#0e2f2a;
    --mkt:#fbbf24; --mkt-soft:#33270a;
    --fin:#93b4ff; --fin-soft:#18213c;
    --hr:#d8b4fe;  --hr-soft:#28183c;
    --shadow:none;
  }
}
:root[data-theme="dark"]{
  --bg:#0e1115; --panel:#161a20; --ink:#e7eaef; --muted:#949dac; --line:#272d36;
  --chip:#222831; --done:#4ade80; --done-soft:#14301f;
  --ops:#5eead4; --ops-soft:#0e2f2a;
  --mkt:#fbbf24; --mkt-soft:#33270a;
  --fin:#93b4ff; --fin-soft:#18213c;
  --hr:#d8b4fe;  --hr-soft:#28183c;
  --shadow:none;
}
:root[data-theme="light"]{
  --bg:#f5f6f9; --panel:#fff; --ink:#14171d; --muted:#596273; --line:#e1e4eb;
  --chip:#eceff4; --done:#15803d; --done-soft:#e7f6ec;
  --ops:#0f766e; --ops-soft:#ddf0ed;
  --mkt:#a4530a; --mkt-soft:#fbeddc;
  --fin:#1d4ed8; --fin-soft:#e4ebfd;
  --hr:#8b2fd6;  --hr-soft:#f1e6fd;
  --shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.08);
}
/* Set by the topic tabs; must follow the theme blocks so it wins. */
:root[data-topic="operations"]{--accent:var(--ops);--accent-soft:var(--ops-soft)}
:root[data-topic="marketing"]{ --accent:var(--mkt);--accent-soft:var(--mkt-soft)}
:root[data-topic="finance"]{   --accent:var(--fin);--accent-soft:var(--fin-soft)}
:root[data-topic="hr"]{        --accent:var(--hr); --accent-soft:var(--hr-soft)}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg); color:var(--ink); font:15px/1.55 var(--sans);
  -webkit-font-smoothing:antialiased;
}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important;scroll-behavior:auto!important}}

header.top{
  position:sticky; top:0; z-index:20; background:var(--panel); border-bottom:1px solid var(--line);
}
.top-inner{max-width:1400px;margin:0 auto;padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.brand{font-weight:650;letter-spacing:-.01em;margin-right:4px;white-space:nowrap}
.brand small{display:block;font-weight:400;font-size:11.5px;color:var(--muted)}
.tabs{display:flex;gap:6px;flex-wrap:wrap}
.tab{
  border:1px solid var(--line); background:transparent; color:var(--ink); cursor:pointer;
  padding:7px 13px; border-radius:999px; font-size:13.5px; font-weight:550; display:flex; gap:7px; align-items:center;
}
.tab:hover{background:var(--chip)}
.tab .n{font-size:11px;color:var(--muted);font-weight:500}
.tab[aria-selected="true"]{background:var(--accent-soft);border-color:var(--accent);color:var(--accent)}
.tab[aria-selected="true"] .n{color:var(--accent)}
.dot{width:8px;height:8px;border-radius:50%;flex:none}
.spacer{flex:1}
.search{
  border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:8px;
  padding:7px 11px;font-size:13.5px;min-width:220px;
}
.search:focus{outline:2px solid var(--accent);outline-offset:-1px}
.iconbtn{
  border:1px solid var(--line);background:transparent;color:var(--muted);cursor:pointer;
  border-radius:8px;padding:7px 10px;font-size:13px;
}
.iconbtn:hover{background:var(--chip);color:var(--ink)}

.layout{max-width:1400px;margin:0 auto;padding:16px;display:grid;grid-template-columns:340px 1fr;gap:16px;align-items:start}
@media (max-width:940px){ .layout{grid-template-columns:1fr} }

aside{
  background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);
  position:sticky;top:64px;max-height:calc(100vh - 84px);overflow-y:auto;
}
@media (max-width:940px){ aside{position:static;max-height:none} }
.aside-head{padding:12px 14px 8px;border-bottom:1px solid var(--line)}
.aside-head h2{margin:0;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.allbtn{
  display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--ink);cursor:pointer;
  padding:10px 14px;font-size:14px;font-weight:600;border-bottom:1px solid var(--line);
}
.allbtn:hover{background:var(--chip)}
.allbtn.active{background:var(--accent-soft);color:var(--accent)}
.sec{border-bottom:1px solid var(--line)}
.sec:last-child{border-bottom:0}
.sec > summary{
  cursor:pointer;padding:10px 14px;font-size:12.5px;font-weight:650;letter-spacing:.02em;
  color:var(--muted);text-transform:uppercase;list-style:none;display:flex;gap:8px;align-items:center;
}
.sec > summary::-webkit-details-marker{display:none}
.sec > summary::before{content:"▸";font-size:10px;transition:transform .12s;color:var(--muted)}
.sec[open] > summary::before{transform:rotate(90deg)}
.sec > summary:hover{background:var(--chip)}
.pt{
  display:flex;gap:8px;align-items:flex-start;width:100%;text-align:left;border:0;background:transparent;
  color:var(--ink);cursor:pointer;padding:8px 14px 8px 30px;font-size:13.5px;line-height:1.4;border-left:3px solid transparent;
}
.pt:hover{background:var(--chip)}
.pt.active{background:var(--accent-soft);border-left-color:var(--accent);color:var(--accent);font-weight:600}
.pt.empty{color:var(--muted);opacity:.55}
.pt .cnt{margin-left:auto;flex:none;font-size:11px;color:var(--muted);background:var(--chip);border-radius:999px;padding:1px 7px;font-variant-numeric:tabular-nums}
.pt.active .cnt{background:var(--panel);color:var(--accent)}
.pt .bar{flex:none;width:34px;height:4px;border-radius:2px;background:var(--chip);overflow:hidden;margin-top:7px}
.pt .bar i{display:block;height:100%;background:var(--done)}

main{min-width:0}
.crumb{font-size:12.5px;color:var(--muted);margin:2px 0 10px}
.crumb b{color:var(--ink);font-weight:600}
.pointhead{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:12px;box-shadow:var(--shadow)}
.pointhead h1{margin:0 0 6px;font-size:19px;line-height:1.3;letter-spacing:-.01em}
.pointhead p{margin:0;color:var(--muted);font-size:13px}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0 4px}
.filters select,.filters label{font-size:12.5px}
.filters select{
  border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:8px;padding:6px 9px;
}
.filters label{display:flex;gap:6px;align-items:center;color:var(--muted);cursor:pointer;user-select:none}

.q{
  background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:10px;
  box-shadow:var(--shadow);
}
.q.is-done{border-color:var(--done);background:var(--done-soft)}
.q-top{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:8px}
.q-num{font-weight:650;font-size:13px;font-variant-numeric:tabular-nums}
.q-src{font-size:12px;color:var(--muted)}
.q-marks{
  margin-left:auto;flex:none;font-size:12px;font-weight:650;background:var(--chip);border-radius:999px;padding:2px 10px;
  font-variant-numeric:tabular-nums;
}
/* The question always renders on white, in both themes — it is a page from an
   exam paper, and a scan and a typeset extract have to sit side by side. */
.paper{
  background:#fff;color:#12151a;border:1px solid #d7dbe2;border-radius:6px;
  padding:18px 20px;margin:0;overflow-x:auto;
}
.paper img{display:block;width:100%;max-width:840px;height:auto;margin:0 auto}
.paper.typeset{font-family:var(--serif)}
.ex-row{display:flex;gap:14px;align-items:baseline}
.ex-num{flex:none;min-width:46px;font-weight:600;font-variant-numeric:tabular-nums}
.ex-text{flex:1;font-size:16px;line-height:1.55;white-space:pre-wrap}
.ex-marks{flex:none;min-width:20px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums}
.ex-stim{
  margin:12px 0 0 60px;padding:10px 12px;background:#f3f5f8;border:1px solid #e2e6ec;
  border-radius:4px;font-size:13.5px;line-height:1.5;white-space:pre-wrap;
}
.ex-rules{margin:14px 0 0 60px;display:flex;flex-direction:column;gap:13px}
.ex-rules i{display:block;border-bottom:1px dotted #98a2b0}
.chip.prov{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em}
.chip.prov.scan{background:var(--accent-soft);color:var(--accent)}
.q-stim{
  margin-top:10px;padding:10px 12px;border-left:3px solid var(--accent);background:var(--accent-soft);
  border-radius:0 8px 8px 0;font-size:13.5px;line-height:1.55;white-space:pre-wrap;
  font-family:var(--serif);max-width:80ch;
}
.q-stim b{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:4px}
.q-foot{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
.chip{font-size:11.5px;background:var(--chip);color:var(--muted);border-radius:999px;padding:2px 9px}
.chip.tag{cursor:pointer;border-left:3px solid var(--tc,var(--line));padding-left:8px}
.chip.tag b{color:var(--tc);font-weight:650}
.chip.tag:hover{background:var(--accent-soft);color:var(--accent)}
.donebtn{
  margin-left:auto;border:1px solid var(--line);background:transparent;color:var(--muted);cursor:pointer;
  border-radius:8px;padding:5px 11px;font-size:12.5px;font-weight:550;
}
.donebtn:hover{background:var(--chip);color:var(--ink)}
.q.is-done .donebtn{border-color:var(--done);color:var(--done)}
.empty-state{
  background:var(--panel);border:1px dashed var(--line);border-radius:12px;padding:34px 20px;text-align:center;color:var(--muted);
}
.count-line{font-size:12.5px;color:var(--muted);margin:0 0 10px}
mark{background:#fde68a;color:#111;border-radius:2px;padding:0 1px}
@media (prefers-color-scheme:dark){ mark{background:#7c5e00;color:#fff} }
:root[data-theme="dark"] mark{background:#7c5e00;color:#fff}
footer{max-width:1400px;margin:0 auto;padding:8px 16px 40px;color:var(--muted);font-size:12px}
@media print{
  header.top,aside,.filters,.donebtn,footer{display:none!important}
  .layout{display:block;padding:0}
  .q{break-inside:avoid;box-shadow:none;border-color:#ccc}
}
</style>
</head>
<body>

<header class="top">
  <div class="top-inner">
    <div class="brand">HSC Business Studies<small>Short-answer questions by syllabus point</small></div>
    <div class="tabs" id="tabs" role="tablist"></div>
    <div class="spacer"></div>
    <input class="search" id="search" type="search" placeholder="Search all questions…" autocomplete="off">
    <button class="iconbtn" id="themebtn" title="Toggle light / dark">Theme</button>
    <button class="iconbtn" id="printbtn" title="Print the questions currently shown">Print</button>
  </div>
</header>

<div class="layout">
  <aside>
    <div class="aside-head"><h2 id="asideTitle">Syllabus</h2></div>
    <button class="allbtn" id="allbtn">All questions in this topic</button>
    <div id="tree"></div>
  </aside>

  <main>
    <div class="crumb" id="crumb"></div>
    <div class="pointhead">
      <h1 id="ptitle">—</h1>
      <p id="psub"></p>
    </div>
    <div class="filters">
      <select id="fSource"><option value="">All papers</option></select>
      <select id="fMarks">
        <option value="">Any marks</option>
        <option value="1-3">1–3 marks</option>
        <option value="4-5">4–5 marks</option>
        <option value="6-9">6–9 marks</option>
        <option value="10+">10+ marks</option>
      </select>
      <select id="fVerb"><option value="">Any directive verb</option></select>
      <select id="fType">
        <option value="">All question types</option>
        <option value="short-answer">Short answer only</option>
        <option value="extended-response">Extended response only</option>
        <option value="multiple-choice">Multiple choice only</option>
      </select>
      <label><input type="checkbox" id="fHideDone"> Hide completed</label>
      <label><input type="checkbox" id="fStim"> Stimulus only</label>
    </div>
    <p class="count-line" id="countline"></p>
    <div id="list"></div>
  </main>
</div>

<footer id="foot"></footer>

<script>
const DATA = /*__DATA__*/null;
const IMAGES = /*__IMAGES__*/{};
const TOPIC_ORDER = ["operations","marketing","finance","hr"];
const TOPIC_COLOR = {operations:"var(--ops)",marketing:"var(--mkt)",finance:"var(--fin)",hr:"var(--hr)"};
const SHORT = {operations:"Operations",marketing:"Marketing",finance:"Finance",hr:"HR"};

// Flat lookup: syllabus id -> {topic, section, label}
const POINT = {};
for (const t of TOPIC_ORDER){
  const sections = DATA.taxonomy[t].sections;
  for (const sec in sections) for (const p of sections[sec])
    POINT[p.id] = {topic:t, section:sec, label:p.label, short:p.short || p.label.split(" — ")[0]};
}

const state = {
  topic: "hr",
  point: null,          // null = whole topic
  q: "",
  source: "", marks: "", verb: "", type: "", hideDone: false, stimOnly: false,
};

// ---- completion tracking -------------------------------------------------
const KEY = "hsc-bst-saq-done-v1";
let done = new Set();
try { done = new Set(JSON.parse(localStorage.getItem(KEY) || "[]")); } catch(e){}
const saveDone = () => { try { localStorage.setItem(KEY, JSON.stringify([...done])); } catch(e){} };

// ---- helpers -------------------------------------------------------------
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const inTopic = q => q.topics.includes(state.topic);

function highlight(text){
  const html = esc(text);
  if (!state.q) return html;
  const terms = state.q.split(/\s+/).filter(t => t.length > 1).map(t => t.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"));
  if (!terms.length) return html;
  return html.replace(new RegExp("("+terms.join("|")+")","gi"), "<mark>$1</mark>");
}

function marksBucket(m, bucket){
  if (!bucket) return true;
  if (m == null) return false;
  if (bucket === "1-3")  return m <= 3;
  if (bucket === "4-5")  return m >= 4 && m <= 5;
  if (bucket === "6-9")  return m >= 6 && m <= 9;
  if (bucket === "10+")  return m >= 10;
  return true;
}

/** Questions for the current topic + point, before the dropdown filters. */
function scoped(){
  return DATA.questions.filter(q => {
    if (state.q){
      // Search runs across every topic so nothing is hidden behind a tab.
      const hay = (q.text + " " + (q.stimulus||"") + " " + q.sources.join(" ")).toLowerCase();
      if (!state.q.toLowerCase().split(/\s+/).every(t => hay.includes(t))) return false;
      return true;
    }
    if (!inTopic(q)) return false;
    if (state.point && !q.syllabusPoints.includes(state.point)) return false;
    return true;
  });
}

function filtered(){
  return scoped().filter(q => {
    if (state.source && !q.sources.includes(state.source)) return false;
    if (!marksBucket(q.marks, state.marks)) return false;
    if (state.verb && q.verb !== state.verb) return false;
    if (state.type && q.type !== state.type) return false;
    if (state.hideDone && done.has(q.id)) return false;
    if (state.stimOnly && !q.stimulus) return false;
    return true;
  });
}

// ---- rendering -----------------------------------------------------------
function renderTabs(){
  const el = document.getElementById("tabs");
  el.innerHTML = TOPIC_ORDER.map(t => {
    const n = DATA.questions.filter(q => q.topics.includes(t)).length;
    return `<button class="tab" role="tab" data-topic="${t}" aria-selected="${t===state.topic && !state.q}">
      <span class="dot" style="background:${TOPIC_COLOR[t]}"></span>${SHORT[t]}<span class="n">${n}</span></button>`;
  }).join("");
  el.querySelectorAll(".tab").forEach(b => b.onclick = () => {
    state.topic = b.dataset.topic; state.point = null; state.q = "";
    document.getElementById("search").value = "";
    render();
  });
}

function renderTree(){
  const sections = DATA.taxonomy[state.topic].sections;
  const parts = [];
  for (const sec in sections){
    const rows = sections[sec].map(p => {
      const all = DATA.questions.filter(q => q.syllabusPoints.includes(p.id));
      const n = all.length;
      const d = all.filter(q => done.has(q.id)).length;
      const pct = n ? Math.round(100*d/n) : 0;
      return `<button class="pt ${state.point===p.id?"active":""} ${n?"":"empty"}" data-point="${p.id}" title="${esc(p.label)}">
        <span>${esc(p.label)}</span>
        ${n ? `<span class="bar" title="${d} of ${n} done"><i style="width:${pct}%"></i></span>` : ""}
        <span class="cnt">${n}</span></button>`;
    }).join("");
    const secTotal = sections[sec].reduce((a,p) => a + (DATA.counts[p.id]||0), 0);
    const open = !state.point || sections[sec].some(p => p.id === state.point);
    parts.push(`<details class="sec" ${open?"open":""}><summary>${esc(sec)} <span class="cnt" style="margin-left:auto">${secTotal}</span></summary>${rows}</details>`);
  }
  const tree = document.getElementById("tree");
  tree.innerHTML = parts.join("");
  tree.querySelectorAll(".pt").forEach(b => b.onclick = () => {
    state.point = b.dataset.point; state.q = ""; document.getElementById("search").value = "";
    render();
  });
  document.getElementById("asideTitle").textContent = DATA.taxonomy[state.topic].label + " syllabus";
  const allb = document.getElementById("allbtn");
  allb.classList.toggle("active", !state.point && !state.q);
  allb.onclick = () => { state.point = null; state.q = ""; document.getElementById("search").value=""; render(); };
}

function renderFilterOptions(){
  const pool = scoped();
  const fill = (id, values, label) => {
    const sel = document.getElementById(id);
    const cur = sel.value;
    const opts = [...new Set(values.filter(Boolean))].sort();
    sel.innerHTML = `<option value="">${label}</option>` + opts.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
    sel.value = opts.includes(cur) ? cur : "";
    if (sel.value !== cur){ if (id==="fSource") state.source=""; if (id==="fVerb") state.verb=""; }
  };
  fill("fSource", pool.flatMap(q => q.sources), "All papers");
  fill("fVerb", pool.map(q => q.verb), "Any directive verb");
}

/** The question as it sits on the paper: the real crop where we have one,
 *  otherwise the wording typeset the same way, with answer lines sized to the
 *  marks. Both render on white — it is paper either way. */
function paperBlock(q){
  if (q.image){
    const src = IMAGES[q.image] || ("img/" + q.image);
    return `<figure class="paper"><img loading="lazy" src="${src}"
      alt="Screenshot of question ${esc(q.number)} as printed in the exam paper"></figure>`;
  }
  // Extended responses are written on separate paper, so no ruled space.
  const extended = q.type === "extended-response" || (q.marks || 0) >= 15;
  const lines = extended ? 0 : Math.min(14, Math.max(2, Math.round((q.marks || 2) * 1.6)));
  return `<div class="paper typeset">
    <div class="ex-row">
      <span class="ex-num">${esc(q.number || "")}</span>
      <span class="ex-text">${highlight(q.text)}</span>
      ${q.marks!=null ? `<span class="ex-marks">${q.marks}</span>` : ""}
    </div>
    ${q.stimulus ? `<div class="ex-stim">${highlight(q.stimulus)}</div>` : ""}
    ${lines ? `<div class="ex-rules">${"<i></i>".repeat(lines)}</div>` : ""}
  </div>`;
}

function card(q){
  const isDone = done.has(q.id);
  // Tags are ordered so the topic you are currently reading comes first.
  const pts = q.syllabusPoints.filter(p => POINT[p])
    .sort((a,b) => (POINT[a].topic===state.topic?0:1) - (POINT[b].topic===state.topic?0:1));
  const tags = pts.map(p => {
    const t = POINT[p].topic;
    const cross = t !== state.topic && !state.q;
    return `<span class="chip tag" data-goto="${p}" style="--tc:${TOPIC_COLOR[t]}"
      title="${esc(SHORT[t])} › ${esc(POINT[p].label)} — click to jump">${cross?`<b>${esc(SHORT[t])}</b> `:""}${esc(POINT[p].short)}</span>`;
  }).join("");
  return `<article class="q ${isDone?"is-done":""}" data-id="${q.id}">
    <div class="q-top">
      <span class="q-num">${esc(q.number || "Question")}</span>
      <span class="q-src">${esc(q.sources.join(" · "))}</span>
      ${q.marks!=null ? `<span class="q-marks">${q.marks} mark${q.marks===1?"":"s"}</span>` : ""}
    </div>
    ${paperBlock(q)}
    <div class="q-foot">
      <span class="chip prov ${q.image?"scan":""}">${q.image ? "screenshot from the paper" : "retyped — no scan of this paper"}</span>
      ${q.type==="extended-response" ? `<span class="chip">extended response</span>` : ""}
      ${q.type==="multiple-choice" ? `<span class="chip">multiple choice</span>` : ""}
      ${tags}
      <button class="donebtn">${isDone ? "✓ Done" : "Mark done"}</button>
    </div>
  </article>`;
}

function renderList(){
  const qs = filtered();
  const list = document.getElementById("list");
  const doneN = qs.filter(q => done.has(q.id)).length;

  document.getElementById("countline").textContent =
    qs.length ? `${qs.length} question${qs.length===1?"":"s"} · ${doneN} completed` : "";

  if (!qs.length){
    list.innerHTML = `<div class="empty-state">${state.q
      ? `No question matches “${esc(state.q)}”.`
      : `No question in the papers covers this syllabus point yet.<br>Try the parent section, or a neighbouring point.`}</div>`;
    return;
  }
  list.innerHTML = qs.map(card).join("");

  list.querySelectorAll(".q").forEach(el => {
    const id = el.dataset.id;
    el.querySelector(".donebtn").onclick = () => {
      done.has(id) ? done.delete(id) : done.add(id);
      saveDone(); renderTree(); renderList();
    };
    el.querySelectorAll("[data-goto]").forEach(t => t.onclick = () => {
      const p = t.dataset.goto;
      state.topic = POINT[p].topic; state.point = p; state.q = "";
      document.getElementById("search").value = "";
      render(); window.scrollTo({top:0,behavior:"smooth"});
    });
  });
}

function renderHead(){
  const crumb = document.getElementById("crumb");
  const title = document.getElementById("ptitle");
  const sub   = document.getElementById("psub");

  if (state.q){
    crumb.innerHTML = `Search`;
    title.textContent = `“${state.q}”`;
    sub.textContent = "Searching every topic. Clear the box to go back to the syllabus.";
  } else if (state.point){
    const p = POINT[state.point];
    crumb.innerHTML = `<b>${esc(DATA.taxonomy[p.topic].label)}</b> › ${esc(p.section)}`;
    title.textContent = p.label;
    const all = DATA.questions.filter(q => q.syllabusPoints.includes(state.point));
    const marks = all.map(q => q.marks).filter(m => m!=null);
    sub.textContent = all.length
      ? `${all.length} question${all.length===1?"":"s"} across ${new Set(all.flatMap(q=>q.sources)).size} paper${new Set(all.flatMap(q=>q.sources)).size===1?"":"s"}`
        + (marks.length ? ` · ${Math.min(...marks)}–${Math.max(...marks)} marks` : "")
      : "No questions found for this point.";
  } else {
    crumb.innerHTML = `<b>${esc(DATA.taxonomy[state.topic].label)}</b>`;
    title.textContent = "All " + DATA.taxonomy[state.topic].label + " questions";
    sub.textContent = "Pick a syllabus point on the left to narrow this down.";
  }
}

function render(){
  document.documentElement.setAttribute("data-topic", state.topic);
  renderTabs(); renderTree(); renderHead(); renderFilterOptions(); renderList();
}

// ---- wiring --------------------------------------------------------------
const search = document.getElementById("search");
let t;
search.oninput = () => { clearTimeout(t); t = setTimeout(() => { state.q = search.value.trim(); render(); }, 130); };
search.onkeydown = e => { if (e.key === "Escape"){ search.value=""; state.q=""; render(); } };

const bind = (id, key) => document.getElementById(id).onchange = e => {
  state[key] = e.target.type === "checkbox" ? e.target.checked : e.target.value; renderList();
};
bind("fSource","source"); bind("fMarks","marks"); bind("fVerb","verb"); bind("fType","type");
bind("fHideDone","hideDone"); bind("fStim","stimOnly");

document.getElementById("printbtn").onclick = () => window.print();
document.getElementById("themebtn").onclick = () => {
  const cur = document.documentElement.getAttribute("data-theme")
    || (matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("hsc-bst-theme", next); } catch(e){}
};
try { const th = localStorage.getItem("hsc-bst-theme"); if (th) document.documentElement.setAttribute("data-theme", th); } catch(e){}

document.getElementById("foot").textContent =
  `${DATA.questions.length} questions from ${DATA.sources.length} papers · classified against the NSW HSC Business Studies syllabus · progress is saved in this browser`;

render();
</script>
</body>
</html>
"""


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--extracted", required=True, help="directory of per-paper extraction JSON")
    ap.add_argument("--taxonomy", required=True, help="syllabus taxonomy JSON")
    ap.add_argument("--fragment", help="also write a head+body fragment for publishing as an Artifact")
    ap.add_argument("--crops", help="catalogued screenshot records to merge in")
    args = ap.parse_args()
    build(args.extracted, args.taxonomy, args.fragment, args.crops)
