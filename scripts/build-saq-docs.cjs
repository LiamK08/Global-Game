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

/** Answer space, in ruled lines, for a question of this size. */
function linesFor(q) {
  if (q.type === "multiple-choice") return 1;
  const m = q.marks || 2;
  if (m >= 15) return 46;          // business report — roughly two pages
  if (m >= 10) return 30;
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

  const bucket = q => q.type === "multiple-choice" ? 2 : q.type === "extended-response" ? 1 : 0;
  let n = 0;
  for (const p of orderedPoints) {
    const qs = (primary.get(p.id) || []).sort((a, b) =>
      bucket(a) - bucket(b) || (a.marks || 0) - (b.marks || 0));
    primary.set(p.id, qs);
    for (const q of qs) {
      numberOf.set(q.id, ++n);
      for (const other of q.syllabusPoints) {
        if (other === p.id || !rank.has(other)) continue;
        if (!alsoAt.has(other)) alsoAt.set(other, []);
        alsoAt.get(other).push(numberOf.get(q.id));
      }
    }
  }
  return { tax, mine, orderedPoints, primary, alsoAt, numberOf, total: n };
}

function buildTopic(topic) {
  const { key, accent } = topic;
  const tax = DATA.taxonomy[key];
  const mine = DATA.questions.filter(q => q.topics.includes(key));

  const { orderedPoints, primary, alsoAt, numberOf, total: n } = plan(topic);

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
        new TextRun({ text: p.short, size: 18, color: count ? INK : MUTED, font: "Aptos" }),
        new TextRun({ children: [new PositionalTab({
          alignment: PositionalTabAlignment.RIGHT, relativeTo: "margin",
          leader: PositionalTabLeader.DOT })] }),
        new TextRun({ text: count ? String(count) : "—", size: 18, color: count ? accent : MUTED, bold: !!count, font: "Aptos" }),
      ],
    }));
  }
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // ---- body
  lastSection = null;
  let sectionNo = 0;
  for (const p of orderedPoints) {
    const qs = primary.get(p.id) || [];
    const also = alsoAt.get(p.id) || [];
    if (!qs.length && !also.length) continue;

    if (p.section !== lastSection) {
      lastSection = p.section;
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
        children: [new TextRun({ text: p.section, bold: true, size: 34, color: INK, font: "Aptos" })],
      }));
    }

    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 360, after: 60 },
      keepNext: true,
      children: [new TextRun({ text: p.label, bold: true, size: 24, color: accent, font: "Aptos" })],
    }));

    if (!qs.length) {
      children.push(new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun({
          text: also.length
            ? `No question of its own. Covered inside question${also.length > 1 ? "s" : ""} ${[...new Set(also.map(a => a.n))].join(", ")}.`
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
          text: `Also tested by question${also.length > 1 ? "s" : ""} ${[...new Set(also.map(a => a.n))].sort((a, b) => a - b).join(", ")}.`,
          italics: true, size: 18, color: MUTED, font: "Aptos" })],
      }));
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

module.exports = { plan, TOPICS, linesFor, imageMeta };

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
