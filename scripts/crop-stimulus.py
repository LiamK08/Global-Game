#!/usr/bin/env python3
"""Crop the real stimulus block out of an exam paper as an image.

A retyped summary of a balance sheet is far worse than the balance sheet, so
where the source paper is available the booklets should show the printed
article. This finds a region by the text that starts and ends it, then renders
that slice of the page at print resolution.

    # one region, by the text either side of it
    python3 scripts/crop-stimulus.py paper.pdf out.png --from "Question 21" --to "(a)"

    # every stimulus in a paper, driven by the question set
    python3 scripts/crop-stimulus.py paper.pdf out_dir/ --paper "2022 HSC Business Studies"

Rendering is 200 dpi by default, which is sharp enough to print at A4 without
the scan looking soft.
"""
import argparse
import json
import os
import re
import sys

import pdfplumber
import pypdfium2 as pdfium

DPI = 200
PAD = 6          # points of breathing room around the cropped block


def norm(s):
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def find_span(page, needle):
    """Top y of the first line whose text contains `needle`, else None.

    Words are grouped into lines by their vertical position, because a phrase
    spanning two words never appears in any single word's text.
    """
    target = norm(needle)
    if not target:
        return None
    lines = {}
    for w in page.extract_words(use_text_flow=True):
        key = round(w["top"] / 3)
        lines.setdefault(key, {"top": w["top"], "bottom": w["bottom"], "parts": []})
        lines[key]["parts"].append(w["text"])
        lines[key]["bottom"] = max(lines[key]["bottom"], w["bottom"])
    for key in sorted(lines):
        line = lines[key]
        if target in norm(" ".join(line["parts"])):
            return line
    return None


def crop(pdf_path, out_path, start_text, end_text=None, page_hint=None, dpi=DPI):
    """Render the slice of a page running from `start_text` to `end_text`."""
    with pdfplumber.open(pdf_path) as doc:
        pages = range(len(doc.pages)) if page_hint is None else [page_hint]
        for i in pages:
            page = doc.pages[i]
            start = find_span(page, start_text)
            if not start:
                continue
            top = max(0, start["top"] - PAD)
            bottom = page.height
            if end_text:
                end = find_span(page, end_text)
                # Only trust an end marker that sits below the start.
                if end and end["top"] > start["top"]:
                    bottom = min(page.height, end["top"] - 2)
            width, height = page.width, page.height
            break
        else:
            return None

    doc = pdfium.PdfDocument(pdf_path)
    scale = dpi / 72
    bitmap = doc[i].render(scale=scale)
    img = bitmap.to_pil()
    box = (0, int(top * scale), int(width * scale), int(min(bottom, height) * scale))
    if box[3] - box[1] < 20:
        return None
    img.crop(box).save(out_path)
    return {"page": i + 1, "top": round(top, 1), "bottom": round(bottom, 1), "out": out_path}


def batch(pdf_path, out_dir, paper, questions_path):
    """Crop the stimulus for every question of `paper` that has one."""
    with open(questions_path) as fh:
        data = json.load(fh)
    todo = [q for q in data["questions"]
            if paper in q["sources"] and q.get("stimulus") and not q.get("image")]
    if not todo:
        print(f"no retyped-stimulus questions recorded for {paper!r}")
        return

    os.makedirs(out_dir, exist_ok=True)
    made = 0
    for q in todo:
        # The stimulus sits above the question, so crop from the question
        # header down to the wording itself.
        num = re.sub(r"[^\d]", "", (q["number"] or "").split("(")[0])
        if not num:
            continue
        first_words = " ".join(q["text"].split()[:6])
        out = os.path.join(out_dir, f"{paper.replace(' ', '-')}-q{num}.png")
        if os.path.exists(out):
            continue
        got = crop(pdf_path, out, f"Question {num}", first_words)
        if got:
            made += 1
            print(f"  q{num:<4} page {got['page']:<3} -> {os.path.basename(out)}")
    print(f"{made} stimulus crops written to {out_dir}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("out", help="output PNG, or a directory in --paper mode")
    ap.add_argument("--from", dest="start", help="text at the top of the region")
    ap.add_argument("--to", dest="end", help="text just below the region")
    ap.add_argument("--paper", help="source paper name from questions.json; batch mode")
    ap.add_argument("--questions", default="study/data/questions.json")
    ap.add_argument("--dpi", type=int, default=DPI)
    a = ap.parse_args()

    if a.paper:
        batch(a.pdf, a.out, a.paper, a.questions)
    elif a.start:
        got = crop(a.pdf, a.out, a.start, a.end, dpi=a.dpi)
        print(got or "no match for that start text", file=sys.stderr if not got else sys.stdout)
        sys.exit(0 if got else 1)
    else:
        ap.error("give --from, or --paper for batch mode")
