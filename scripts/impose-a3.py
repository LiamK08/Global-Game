#!/usr/bin/env python3
"""Impose an A4 PDF two-up onto A3 landscape for saddle-stitch booklet printing.

Print the result double-sided on A3, flipping on the SHORT edge, then fold the
stack in half — the pages land in reading order.

    python3 scripts/impose-a3.py in.pdf out.pdf [notes-page.pdf]
"""
import sys

import pypdf
from pypdf import PageObject, Transformation
from pypdf.generic import RectangleObject

A4_W, A4_H = 595.276, 841.890          # points
A3_W, A3_H = A4_H * 2, A4_W * 2 / 2    # A3 landscape is exactly two A4 portraits
A3_W, A3_H = 1190.551, 841.890


def booklet_order(n_pages):
    """Sheet-side order for saddle stitch, as (left, right) 1-based page numbers.

    n_pages must already be a multiple of four. Sheet 1 front carries the last
    page beside the first, because that pair ends up outermost once folded.
    """
    order = []
    for i in range(n_pages // 4):
        order.append((n_pages - 2 * i, 1 + 2 * i))          # front
        order.append((2 + 2 * i, n_pages - 1 - 2 * i))      # back
    return order


def impose(src_path, out_path, pad_path=None):
    reader = pypdf.PdfReader(src_path)
    writer = pypdf.PdfWriter()
    pages = list(reader.pages)
    n_real = len(pages)

    # Pad up to a multiple of four. Using a ruled notes page rather than a blank
    # keeps real content on both halves of the outer sheet, so the last page
    # sits beside the first once the stack is folded.
    short = (-n_real) % 4
    if short:
        filler = pypdf.PdfReader(pad_path).pages[0] if pad_path else None
        for _ in range(short):
            if filler is not None:
                pages.append(filler)
            else:
                box = pages[0].mediabox
                pages.append(PageObject.create_blank_page(
                    width=float(box.width), height=float(box.height)))
    n = len(pages)

    for left, right in booklet_order(n):
        sheet = PageObject.create_blank_page(width=A3_W, height=A3_H)
        for slot, num in ((0, left), (1, right)):
            if num is None:
                continue
            page = pages[num - 1]
            box = page.mediabox
            pw, ph = float(box.width), float(box.height)
            # Centre each source page inside its half of the sheet, scaling only
            # if the source is not already A4.
            scale = min(A4_W / pw, A3_H / ph, 1.0)
            tx = slot * A4_W + (A4_W - pw * scale) / 2
            ty = (A3_H - ph * scale) / 2
            sheet.merge_transformed_page(
                page, Transformation().scale(scale, scale).translate(tx, ty))
        sheet.mediabox = RectangleObject((0, 0, A3_W, A3_H))
        writer.add_page(sheet)

    with open(out_path, "wb") as fh:
        writer.write(fh)
    sheets = len(writer.pages)
    print(f"{src_path}: {n_real} A4 pages"
          f"{f' + {short} notes' if short else ''} -> {sheets} A3 sides "
          f"({sheets // 2} sheet{'s' if sheets // 2 != 1 else ''} of paper); "
          f"outer sheet = page {n} beside page 1")


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    impose(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) == 4 else None)
