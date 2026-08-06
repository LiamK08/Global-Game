#!/usr/bin/env node
/**
 * Build one printable practice booklet per Business Studies topic.
 *
 * Each booklet walks the syllabus in order, and under every dot point places
 * the past-paper questions that test it, with ruled answer space sized to the
 * mark value so it can be completed by hand or with a stylus.
 *
 *   node scripts/build-saq-docs.js [--out <dir>]
 */
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, ImageRun, PageBreak, Header, Footer,
  AlignmentType, BorderStyle, HeadingLevel, PageNumber, ShadingType,
  PositionalTab, PositionalTabAlignment, PositionalTabLeader, LevelFormat,
  convertInchesToTwip,
} = require("docx");

const ROOT = path.dirname(__dirname);
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, "study/data/questions.json"), "utf8"));
const IMG_DIR = path.join(ROOT, "study/img");

const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i > -1 ? process.argv[i + 1] : path.join(ROOT, "study/booklets");
})();

const TOPICS = [
  { key: "operations", file: "Operations",     accent: "0F766E" },
  { key: "marketing",  file: "Marketing",      accent: "A4530A" },
  { key: "finance",    file: "Finance",        accent: "1D4ED8" },
  { key: "hr",         file: "Human-Resources", accent: "8B2FD6" },
];

const INK = "14171D";
const MUTED = "5D6673";
const RULE = "B9C0CA";

// ---------------------------------------------------------------- helpers

/** Extended responses (business reports, 20-mark essays) are written on
 *  separate paper, so they are listed without answer space. */
const isExtended = q => q.type === "extended-response" || (q.marks || 0) >= 15;

/** Answer space, in ruled lines, for a question of this size. */
function linesFor(q) {
  if (q.type === "multiple-choice") return 1;
  const m = q.marks || 2;
  if (m >= 10) return 26;
  return Math.max(4, m * 2 + 2);   // 2 marks -> 6 lines, 4 marks -> 10
}

/**
 * A crop that already shows the paper's own ruled lines does not need more.
 * Short crops are just the question stem, so those still get answer space.
 */
function imageMeta(name) {
  const file = path.join(IMG_DIR, name);
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  // PNG: width/height are big-endian uint32 at offsets 16 and 20.
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  return { buf, w, h };
}

const rule = (extra = {}) => new Paragraph({
  spacing: { before: 0, after: 0, line: 400, lineRule: "exact" },
  border: { bottom: { style: BorderStyle.SINGLE, size: 4, space: 1, color: RULE } },
  ...extra,
});

const spacer = (after = 120) => new Paragraph({ text: "", spacing: { after } });

function label(text, opts = {}) {
  return new Paragraph({
    spacing: { before: opts.before ?? 240, after: opts.after ?? 60 },
    keepNext: true,
    children: [new TextRun({
      text, bold: true, size: 15, color: opts.color || MUTED,
      allCaps: true, characterSpacing: 24, font: "Aptos",
    })],
  });
}

// ------------------------------------------------------------ question block

function questionBlock(q, accent, idx) {
  const out = [];
  const src = q.sources.join(" · ");
  const marks = q.marks != null ? `${q.marks} mark${q.marks === 1 ? "" : "s"}`
    : q.type === "multiple-choice" ? "multiple choice" : "";

  // Header: source on the left, marks pushed to the right margin.
  out.push(new Paragraph({
    spacing: { before: 320, after: 100 },
    keepNext: true,
    children: [
      new TextRun({ text: `${idx}. `, bold: true, size: 21, color: accent, font: "Aptos" }),
      new TextRun({ text: `${q.number || "Question"}`, bold: true, size: 21, color: INK, font: "Aptos" }),
      new TextRun({ text: `   ${src}`, size: 17, color: MUTED, font: "Aptos" }),
      new TextRun({
        children: [new PositionalTab({
          alignment: PositionalTabAlignment.RIGHT,
          relativeTo: "margin",
          leader: PositionalTabLeader.NONE,
        })],
      }),
      new TextRun({ text: marks, bold: true, size: 17, color: accent, font: "Aptos" }),
    ],
  }));

  const meta = q.image ? imageMeta(q.image) : null;

  if (meta) {
    // Scale the crop to the 6.5" text column, capped so tall scans still fit.
    const maxW = 6.4 * 96;
    const scale = Math.min(1, maxW / meta.w, (8.2 * 96) / meta.h);
    out.push(new Paragraph({
      spacing: { before: 60, after: 120 },
      children: [new ImageRun({
        type: "png", data: meta.buf,
        transformation: { width: Math.round(meta.w * scale), height: Math.round(meta.h * scale) },
      })],
    }));
  } else {
    out.push(new Paragraph({
      spacing: { before: 40, after: 120 },
      keepNext: true,
      children: [new TextRun({ text: q.text, size: 22, color: INK, font: "Cambria" })],
    }));
    if (q.stimulus) {
      out.push(new Paragraph({
        spacing: { before: 60, after: 160 },
        indent: { left: convertInchesToTwip(0.25), right: convertInchesToTwip(0.25) },
        shading: { type: ShadingType.CLEAR, fill: "F2F4F7" },
        // Only top and bottom: docx-js emits w:pBdr children as top, bottom,
        // left, right, but the schema wants top, left, bottom, right — so any
        // rule set including left or right produces an invalid document.
        border: {
          top: { style: BorderStyle.SINGLE, size: 6, color: accent, space: 8 },
          bottom: { style: BorderStyle.SINGLE, size: 2, color: "DFE3E9", space: 8 },
        },
        children: [
          new TextRun({ text: "Stimulus   ", bold: true, size: 15, color: MUTED, allCaps: true, font: "Aptos" }),
          new TextRun({ text: q.stimulus, size: 19, color: INK, font: "Cambria" }),
        ],
      }));
    }
  }

  // Answer space. Only skip it when the crop genuinely shows the paper's own
  // ruled lines — a tall crop is just as often a stimulus graph.
  let lines = linesFor(q);
  if (meta && q.imageHasRules) lines = q.type === "multiple-choice" ? 1 : 2;

  if (q.type === "multiple-choice") {
    out.push(new Paragraph({
      spacing: { before: 120, after: 60 },
      children: [new TextRun({ text: "Answer:  ", bold: true, size: 19, color: MUTED, font: "Aptos" }),
                 new TextRun({ text: " ".repeat(14), underline: {} })],
    }));
  } else {
    for (let i = 0; i < lines; i++) out.push(rule());
  }
  return out;
}

// ------------------------------------------------------------------ booklet

/**
 * Work out, once per topic, which dot point each question is printed under,
 * what number it gets, and where it is cross-referenced from. Both the Word
 * booklet and the PDF render from this, so their numbering always agrees.
 */
function plan(topic) {
  const { key } = topic;
  const tax = DATA.taxonomy[key];
  const mine = DATA.questions.filter(q => q.topics.includes(key));

  const orderedPoints = [];
  for (const [section, points] of Object.entries(tax.sections))
    for (const p of points) orderedPoints.push({ ...p, section });
  const rank = new Map(orderedPoints.map((p, i) => [p.id, i]));

  const primary = new Map(), alsoAt = new Map(), numberOf = new Map();
  for (const q of mine) {
    const own = q.syllabusPoints.filter(p => rank.has(p)).sort((a, b) => rank.get(a) - rank.get(b));
    if (!own.length) continue;
    if (!primary.has(own[0])) primary.set(own[0], []);
    primary.get(own[0]).push(q);
  }

  // Extended responses are answered on separate paper, so they are pulled out
  // of the dot points and gathered at the end of the part they belong to.
  const extendedBySection = new Map();
  for (const p of orderedPoints) {
    const keep = [], ext = [];
    for (const q of primary.get(p.id) || []) (isExtended(q) ? ext : keep).push(q);
    primary.set(p.id, keep);
    if (ext.length) {
      if (!extendedBySection.has(p.section)) extendedBySection.set(p.section, []);
      extendedBySection.get(p.section).push(...ext);
    }
  }

  const sections = [...new Set(orderedPoints.map(p => p.section))];
  const bucket = q => q.type === "multiple-choice" ? 1 : 0;

  // Number straight through the booklet: each part's dot points first, then
  // that part's extended responses.
  let n = 0;
  const noteAlso = (q, homeId) => {
    for (const other of q.syllabusPoints) {
      if (other === homeId || !rank.has(other)) continue;
      if (!alsoAt.has(other)) alsoAt.set(other, []);
      alsoAt.get(other).push(numberOf.get(q.id));
    }
  };

  for (const section of sections) {
    for (const p of orderedPoints.filter(x => x.section === section)) {
      const qs = (primary.get(p.id) || []).sort((a, b) =>
        bucket(a) - bucket(b) || (a.marks || 0) - (b.marks || 0));
      primary.set(p.id, qs);
      for (const q of qs) { numberOf.set(q.id, ++n); noteAlso(q, p.id); }
    }
    const ext = (extendedBySection.get(section) || []).sort((a, b) => (b.marks || 0) - (a.marks || 0));
    extendedBySection.set(section, ext);
    for (const q of ext) {
      numberOf.set(q.id, ++n);
      // Cross-reference every dot point it touches, since it now sits outside them.
      for (const other of q.syllabusPoints) {
        if (!rank.has(other)) continue;
        if (!alsoAt.has(other)) alsoAt.set(other, []);
        alsoAt.get(other).push(n);
      }
    }
  }
  return { tax, mine, orderedPoints, sections, primary, extendedBySection, alsoAt, numberOf, total: n };
}

function buildTopic(topic) {
  const { key, accent } = topic;
  const tax = DATA.taxonomy[key];
  const mine = DATA.questions.filter(q => q.topics.includes(key));

  const { orderedPoints, sections, primary, extendedBySection, alsoAt, numberOf, total: n } = plan(topic);

  const shots = mine.filter(q => q.image).length;
  const children = [];

  // ---- cover
  children.push(
    new Paragraph({ spacing: { before: 2600, after: 0 }, children: [new TextRun({
      text: "HSC BUSINESS STUDIES", bold: true, size: 19, color: MUTED, allCaps: true,
      characterSpacing: 60, font: "Aptos" })] }),
    new Paragraph({ spacing: { before: 120, after: 0 }, children: [new TextRun({
      text: tax.label, bold: true, size: 76, color: accent, font: "Aptos" })] }),
    new Paragraph({
      spacing: { before: 200, after: 260 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: accent, space: 8 } },
      children: [new TextRun({ text: "Practice questions by syllabus point", size: 26, color: INK, font: "Cambria" })],
    }),
    new Paragraph({ spacing: { after: 80 }, children: [new TextRun({
      text: `${n} questions · ${shots} shown as screenshots of the printed paper · ${orderedPoints.filter(p => (primary.get(p.id) || []).length).length} of ${orderedPoints.length} syllabus points covered`,
      size: 20, color: INK, font: "Aptos" })] }),
    new Paragraph({ spacing: { after: 300 }, children: [new TextRun({
      text: `Drawn from ${DATA.sources.length} papers: NESA HSC 2019–2023, school trial papers 2023–24, and topic question banks.`,
      size: 19, color: MUTED, font: "Aptos" })] }),
    label("How to use this booklet", { color: accent }),
    ...[
      "Questions sit under the syllabus dot point they actually test, in syllabus order.",
      "Ruled space follows each question, sized to its mark value — write straight onto the page, on paper or with a stylus.",
      "A question testing more than one dot point is printed once and cross-referenced from the others.",
      "Where a scan of the original page exists it is shown as-is, so you see the real layout and mark boxes.",
    ].map(t => new Paragraph({
      spacing: { after: 70 }, bullet: { level: 0 },
      children: [new TextRun({ text: t, size: 19, color: INK, font: "Aptos" })],
    })),
    new Paragraph({ children: [new PageBreak()] }),
  );

  // ---- contents
  children.push(label("Contents", { before: 0, color: accent }));
  let lastSection = null;
  for (const p of orderedPoints) {
    const count = (primary.get(p.id) || []).length;
    const xref = new Set(alsoAt.get(p.id) || []).size;
    if (p.section !== lastSection) {
      lastSection = p.section;
      children.push(new Paragraph({
        spacing: { before: 200, after: 40 },
        children: [new TextRun({ text: p.section, bold: true, size: 20, color: INK, font: "Aptos" })],
      }));
    }
    children.push(new Paragraph({
      spacing: { after: 20 },
      indent: { left: convertInchesToTwip(0.22) },
      children: [
        new TextRun({ text: p.heading, size: 18, color: count ? INK : MUTED, font: "Aptos" }),
        new TextRun({ children: [new PositionalTab({
          alignment: PositionalTabAlignment.RIGHT, relativeTo: "margin",
          leader: PositionalTabLeader.DOT })] }),
        new TextRun({
          text: count ? String(count) : xref ? `\u2197${xref}` : "\u2014",
          size: count ? 18 : 16, color: count ? accent : MUTED, bold: !!count, font: "Aptos" }),
      ],
    }));
  }
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // ---- body
  let sectionNo = 0;
  for (const section of sections) {
    sectionNo++;
    children.push(new Paragraph({
      pageBreakBefore: sectionNo > 1,
      spacing: { before: sectionNo > 1 ? 0 : 120, after: 40 },
      children: [new TextRun({ text: `PART ${sectionNo}`, bold: true, size: 16, color: accent,
        allCaps: true, characterSpacing: 50, font: "Aptos" })],
    }));
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 0, after: 200 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: accent, space: 8 } },
      children: [new TextRun({ text: section, bold: true, size: 34, color: INK, font: "Aptos" })],
    }));

    for (const p of orderedPoints.filter(x => x.section === section)) {
      const qs = primary.get(p.id) || [];
      const also = [...new Set(alsoAt.get(p.id) || [])].sort((a, b) => a - b);
      if (!qs.length && !also.length) continue;

      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 360, after: 60 },
        keepNext: true,
        children: [new TextRun({ text: p.heading, bold: true, size: 24, color: accent, font: "Aptos" })],
      }));

      if (!qs.length) {
        children.push(new Paragraph({
          spacing: { after: 120 },
          children: [new TextRun({
            text: also.length
              ? `No short-answer question of its own. Covered inside question${also.length > 1 ? "s" : ""} ${also.join(", ")}.`
              : "No question in these papers examines this dot point.",
            italics: true, size: 19, color: MUTED, font: "Aptos" })],
        }));
        continue;
      }

      qs.forEach(q => children.push(...questionBlock(q, accent, numberOf.get(q.id))));

      if (also.length) {
        children.push(new Paragraph({
          spacing: { before: 260, after: 120 },
          children: [new TextRun({
            text: `Also tested by question${also.length > 1 ? "s" : ""} ${also.join(", ")}.`,
            italics: true, size: 18, color: MUTED, font: "Aptos" })],
        }));
      }
    }

    // The part's 20-markers, gathered on their own page with no answer space.
    const ext = extendedBySection.get(section) || [];
    if (ext.length) {
      children.push(new Paragraph({
        pageBreakBefore: true,
        spacing: { before: 0, after: 40 },
        children: [new TextRun({ text: `PART ${sectionNo} · EXTENDED RESPONSE`, bold: true, size: 16,
          color: accent, allCaps: true, characterSpacing: 50, font: "Aptos" })],
      }));
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 0, after: 60 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: accent, space: 8 } },
        children: [new TextRun({ text: `${section} — 20-mark questions`, bold: true, size: 30, color: INK, font: "Aptos" })],
      }));
      children.push(new Paragraph({
        spacing: { before: 80, after: 200 },
        children: [new TextRun({
          text: `${ext.length} question${ext.length > 1 ? "s" : ""}. Plan and write these on separate paper.`,
          italics: true, size: 18, color: MUTED, font: "Aptos" })],
      }));

      for (const q of ext) {
        children.push(new Paragraph({
          spacing: { before: 200, after: 60 },
          keepNext: true,
          children: [
            new TextRun({ text: `${numberOf.get(q.id)}. `, bold: true, size: 19, color: accent, font: "Aptos" }),
            new TextRun({ text: `${q.number || "Question"}`, bold: true, size: 19, color: INK, font: "Aptos" }),
            new TextRun({ text: `   ${q.sources.join(" · ")}`, size: 16, color: MUTED, font: "Aptos" }),
            new TextRun({ children: [new PositionalTab({
              alignment: PositionalTabAlignment.RIGHT, relativeTo: "margin",
              leader: PositionalTabLeader.NONE })] }),
            new TextRun({ text: q.marks != null ? `${q.marks} marks` : "extended response",
              bold: true, size: 16, color: accent, font: "Aptos" }),
          ],
        }));

        const meta = q.image ? imageMeta(q.image) : null;
        if (meta) {
          const scale = Math.min(1, (5.3 * 96) / meta.w, (3.7 * 96) / meta.h);
          children.push(new Paragraph({
            spacing: { before: 40, after: 100 },
            children: [new ImageRun({ type: "png", data: meta.buf,
              transformation: { width: Math.round(meta.w * scale), height: Math.round(meta.h * scale) } })],
          }));
        } else {
          children.push(new Paragraph({
            spacing: { before: 30, after: 80 },
            children: [new TextRun({ text: q.text, size: 20, color: INK, font: "Cambria" })],
          }));
          if (q.stimulus) {
            children.push(new Paragraph({
              spacing: { before: 40, after: 100 },
              indent: { left: convertInchesToTwip(0.25), right: convertInchesToTwip(0.25) },
              shading: { type: ShadingType.CLEAR, fill: "F2F4F7" },
              border: {
                top: { style: BorderStyle.SINGLE, size: 6, color: accent, space: 6 },
                bottom: { style: BorderStyle.SINGLE, size: 2, color: "DFE3E9", space: 6 },
              },
              children: [
                new TextRun({ text: "Stimulus   ", bold: true, size: 14, color: MUTED, allCaps: true, font: "Aptos" }),
                new TextRun({ text: q.stimulus, size: 17, color: INK, font: "Cambria" }),
              ],
            }));
          }
        }
      }
    }
  }

  return new Document({
    creator: "HSC Business Studies practice booklets",
    title: `HSC Business Studies — ${tax.label}`,
    description: "Past-paper questions arranged by syllabus point, with answer space.",
    numbering: {
      config: [{
        reference: "bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT }],
      }],
    },
    styles: {
      default: { document: { run: { font: "Aptos", size: 21, color: INK } } },
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },          // US Letter
          margin: {
            top: convertInchesToTwip(0.85), bottom: convertInchesToTwip(0.7),
            left: convertInchesToTwip(0.9), right: convertInchesToTwip(0.9),
            header: convertInchesToTwip(0.4), footer: convertInchesToTwip(0.35),
          },
        },
      },
      headers: {
        default: new Header({ children: [new Paragraph({
          spacing: { after: 0 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "DDE1E7", space: 6 } },
          children: [
            new TextRun({ text: `HSC Business Studies · ${tax.label}`, size: 16, color: MUTED, font: "Aptos" }),
          ],
        })] }),
      },
      footers: {
        default: new Footer({ children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ children: ["Page ", PageNumber.CURRENT], size: 16, color: MUTED, font: "Aptos" })],
        })] }),
      },
      children,
    }],
  });
}

module.exports = { plan, TOPICS, linesFor, imageMeta, isExtended };

// Only build when run directly — build-saq-pdf.cjs imports the plan from here
// so both formats number their questions identically.
if (require.main !== module) return;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const t of TOPICS) {
    const doc = buildTopic(t);
    const buf = await Packer.toBuffer(doc);
    const file = path.join(OUT, `HSC-Business-Studies-${t.file}-SAQ-Booklet.docx`);
    fs.writeFileSync(file, buf);
    const mine = DATA.questions.filter(q => q.topics.includes(t.key));
    console.log(`${t.file.padEnd(16)} ${String(mine.length).padStart(4)} questions  ${String(mine.filter(q => q.image).length).padStart(3)} screenshots  ${(buf.length / 1e6).toFixed(2)} MB`);
  }
  console.log("wrote", OUT);
})();
