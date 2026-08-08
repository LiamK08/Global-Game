# HSC Business Studies study material

Past-paper short-answer questions indexed against the NSW HSC Business Studies
syllabus, as a browsable page and as printable practice booklets.

| | |
|---|---|
| `hsc-business-studies-saq.html` | the study page — self-contained, opens straight from disk |
| `booklets/` | printable booklets, Word and PDF, plus A3 booklet impositions |
| `data/syllabus.json` | the syllabus taxonomy: 95 dot points across the four topics |
| `data/questions.json` | the merged question set everything is built from |
| `data/crops.json` | the catalogued screenshots from the scanned finance bank |
| `img/` | those screenshots |

## Rebuilding

```sh
pip install pypdf pdfplumber pypdfium2 Pillow
npm install docx playwright && npx playwright install chromium
```

The page and the question set:

```sh
python3 scripts/build-saq.py \
  --extracted <dir of per-paper extraction json> \
  --taxonomy study/data/syllabus.json \
  --crops study/data/crops.json
```

The booklets, which read `study/data/questions.json`:

```sh
node scripts/build-saq-docs.cjs     # full syllabus booklet per topic, Word
node scripts/build-saq-pdf.cjs      # the same as PDF
node scripts/build-saq-focus.cjs    # exam-focus booklets, Word + PDF
```

A3 saddle-stitch imposition. Print double-sided, flip on the **short** edge,
fold each group of sheets on its own and stack them:

```sh
python3 scripts/impose-a3.py in.pdf out.pdf study/booklets/_notes-page-a4.pdf --signature 5
```

`--signature` caps how many sheets fold together; anything past about eight
will not close in a home stapler and the inner pages creep past the edge.
Omit it for a single fold.

## Replacing retyped stimulus with the real thing

Where a question depends on a table, a balance sheet or a graph, the booklets
currently print a retyped summary. That is much worse than the printed
article — a balance sheet becomes one run-on sentence of numbers.

`scripts/crop-stimulus.py` fixes this wherever the source paper is available
locally. It finds a region by the text either side of it and renders that slice
at 200 dpi:

```sh
# one region
python3 scripts/crop-stimulus.py paper.pdf out.png \
  --from "Question 21" --to "(a)"

# every stimulus in a paper
python3 scripts/crop-stimulus.py paper.pdf study/img/ \
  --paper "2022 HSC Business Studies"
```

This was never run against the real papers: they live in Google Drive, which
the environment the material was built in could not reach. Run it locally,
where the PDFs are just files, then point the question's `image` field at the
crop and rebuild.

228 questions carry a retyped stimulus; 102 of those are numeric or tabular,
and those are the ones worth cropping first. The papers carrying the most are
the 2021 finance practice bank, Knox 2023, the Independent trial 2024 and
Newington 2024.

## Where the questions came from

NESA HSC papers 2019–2023, school trial papers 2023–24, and four topic question
banks — 23 documents. A question appearing in more than one paper is merged
into a single entry listing every paper it came from. Dot points with no
coverage are shown rather than hidden, so gaps in the past-paper record are
visible instead of being mistaken for finished revision.
