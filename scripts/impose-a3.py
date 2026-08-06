#!/usr/bin/env python3
"""Impose an A4 PDF two-up onto A3 landscape for saddle-stitch booklet printing.

Print the result double-sided on A3, flipping on the SHORT edge, then fold the
stack in half — the pages land in reading order.

    python3 scripts/impose-a3.py in.pdf out.pdf
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

    Padded to a multiple of four; None means a blank. Sheet 1 front carries the
    last page beside the first, because that pair ends up outermost once folded.
    """
    padded = (n_pages + 3) // 4 * 4
    pad = lambda p: p if p <= n_pages else None
    order = []
    for i in range(padded // 4):
        order.append((pad(padded - 2 * i), pad(1 + 2 * i)))          # front
        order.append((pad(2 + 2 * i), pad(padded - 1 - 2 * i)))      # back
    return order


def impose(src_path, out_path):
    reader = pypdf.PdfReader(src_path)
    writer = pypdf.PdfWriter()
    n = len(reader.pages)

    for left, right in booklet_order(n):
        sheet = PageObject.create_blank_page(width=A3_W, height=A3_H)
        for slot, num in ((0, left), (1, right)):
            if num is None:
                continue
            page = reader.pages[num - 1]
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
    print(f"{src_path}: {n} A4 pages -> {sheets} A3 sides "
          f"({sheets // 2} sheet{'s' if sheets // 2 != 1 else ''} of paper)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    impose(sys.argv[1], sys.argv[2])
