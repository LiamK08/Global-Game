#!/usr/bin/env node
/**
 * Build the "exam focus" booklet: short-answer questions only, covering just
 * the syllabus points flagged for revision, in one document across all four
 * topics. Writes a Word file and a PDF from the same plan.
 *
 *   node scripts/build-saq-focus.cjs [--out <dir>]
 */
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, ImageRun, PageBreak, Header, Footer,
  AlignmentType, BorderStyle, HeadingLevel, PageNumber, ShadingType,
  PositionalTab, PositionalTabAlignment, PositionalTabLeader,
  convertInchesToTwip,
} = require("docx");
const { chromium } = require("playwright");
const { imageMeta } = require("./build-saq-docs.cjs");

const ROOT = path.dirname(__dirname);
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, "study/data/questions.json"), "utf8"));
const IMG_DIR = path.join(ROOT, "study/img");
/** Let Playwright find its own browser; only override for a pinned sandbox build. */
function launchOptions() {
  const pinned = process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  return fs.existsSync(pinned) ? { executablePath: pinned } : {};
}
const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i > -1 ? process.argv[i + 1] : path.join(ROOT, "study/booklets");
})();

const INK = "14171D", MUTED = "5D6673", RULE = "B9C0CA";

/** The points flagged for revision, in the order they were given. */
const FOCUS = [
  { topic: "operations", label: "Operations", accent: "0F766E", groups: [
    { name: "Inventory management", points: ["ops-str-inventory"] },
    { name: "Global factors", points: ["ops-str-global"] },
    { name: "Corporate social responsibility", points: ["ops-inf-csr"] },
  ] },
  { topic: "finance", label: "Finance", accent: "1D4ED8", groups: [
    { name: "Planning and implementing", points: ["fin-proc-planning"] },
    { name: "Ethical issues of financial statements", points: ["fin-proc-ethical", "fin-proc-limitations"] },
    { name: "Profitability and working capital management", points: ["fin-str-profitability", "fin-str-workingcapital"] },
    { name: "Equity financing", points: ["fin-inf-equity"] },
    { name: "Global financial management strategies", points: ["fin-str-global"] },
  ] },
  { topic: "marketing", label: "Marketing", accent: "A4530A", groups: [
    { name: "Consumer laws", points: ["mkt-inf-consumerlaws"] },
    { name: "Identifying target markets", points: ["mkt-proc-target"] },
    { name: "Developing marketing strategies", points: ["mkt-proc-strategies"] },
    { name: "Implementation, monitoring and controlling", points: ["mkt-proc-implement"] },
    { name: "Market segmentation", points: ["mkt-str-segmentation"] },
    { name: "Promotion mix", points: ["mkt-str-promotion"] },
    { name: "Distribution channels", points: ["mkt-str-place"] },
  ] },
  { topic: "hr", label: "Human Resources", accent: "8B2FD6", groups: [
    { name: "Strategic role of human resource management", points: ["hr-role-strategic"] },
    { name: "Outsourcing", points: ["hr-role-outsourcing"] },
    { name: "Processes of human resource management",
      points: ["hr-proc-acquisition", "hr-proc-development", "hr-proc-maintenance", "hr-proc-separation"] },
    { name: "Leadership style", points: ["hr-str-leadership"] },
    { name: "Indicators", points: ["hr-eff-indicators"] },
  ] },
];

const A4_DOCX = { width: 11906, height: 16838 };   // twips

/** Short answer only: no multiple choice, no 20-mark extended responses. */
const isShortAnswer = q => q.type === "short-answer" && (q.marks || 0) < 15;

function linesFor(q) {
  const m = q.marks || 2;
  if (m >= 10) return 26;
  return Math.max(4, m * 2 + 2);
}

/**
 * Decide once where each question prints and what number it carries, so the
 * Word file and the PDF agree. A question testing two flagged points is
 * printed under the first and cross-referenced from the other.
 */
function plan(sections) {
  const placed = new Map();   // "topic/group" -> [questions]
  const alsoAt = new Map();   // "topic/group" -> [numbers]
  const numberOf = new Map();
  const taken = new Set();
  const key = (t, g) => `${t}/${g}`;

  for (const sec of sections) {
    for (const g of sec.groups) {
      const pts = new Set(g.points);
      const qs = DATA.questions.filter(q =>
        q.topics.includes(sec.topic) && isShortAnswer(q) &&
        q.syllabusPoints.some(p => pts.has(p)) && !taken.has(q.id));
      qs.sort((a, b) => (a.marks || 0) - (b.marks || 0));
      qs.forEach(q => taken.add(q.id));
      placed.set(key(sec.topic, g.name), qs);
    }
  }

  let n = 0;
  for (const sec of sections)
    for (const g of sec.groups)
      for (const q of placed.get(key(sec.topic, g.name))) numberOf.set(q.id, ++n);

  // Now that everything has a number, point each group at the questions that
  // test it but print elsewhere.
  for (const sec of sections) {
    for (const g of sec.groups) {
      const pts = new Set(g.points);
      const mine = new Set(placed.get(key(sec.topic, g.name)).map(q => q.id));
      const refs = DATA.questions
        .filter(q => isShortAnswer(q) && numberOf.has(q.id) && !mine.has(q.id) &&
                     q.syllabusPoints.some(p => pts.has(p)))
        .map(q => numberOf.get(q.id))
        .sort((a, b) => a - b);
      if (refs.length) alsoAt.set(key(sec.topic, g.name), [...new Set(refs)]);
    }
  }
  return { placed, alsoAt, numberOf, total: n, key, sections };
}

// ------------------------------------------------------------------- PDF

const esc = s => String(s == null ? "" : s)
  .replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const uriCache = new Map();
function dataUri(name) {
  if (!uriCache.has(name)) {
    const m = imageMeta(name);
    uriCache.set(name, m && { uri: "data:image/png;base64," + m.buf.toString("base64"), ...m });
  }
  return uriCache.get(name);
}

function focusHtml({ placed, alsoAt, numberOf, total, key, sections }, title, sub) {
  const rows = [];
  for (const sec of sections) {
    rows.push(`<div class="csec" style="--a:#${sec.accent}">${esc(sec.label)}</div>`);
    for (const g of sec.groups) {
      const c = placed.get(key(sec.topic, g.name)).length;
      const x = (alsoAt.get(key(sec.topic, g.name)) || []).length;
      const tally = c ? String(c) : x ? `↗${x}` : "—";
      rows.push(`<div class="crow ${c ? "" : x ? "xref" : "none"}"><span>${esc(g.name)}</span><span class="dots"></span><b>${tally}</b></div>`);
    }
  }

  let body = "";
  for (const sec of sections) {
    body += `<section class="part" style="--a:#${sec.accent}">
      <div class="eyebrow">Topic</div><h1>${esc(sec.label)}</h1></section>`;
    for (const g of sec.groups) {
      const qs = placed.get(key(sec.topic, g.name));
      const refs = alsoAt.get(key(sec.topic, g.name)) || [];
      body += `<div class="grp" style="--a:#${sec.accent}"><h2>${esc(g.name)}</h2>`;
      if (!qs.length) {
        body += `<p class="empty">${refs.length
          ? `No question of its own here. Tested inside question${refs.length > 1 ? "s" : ""} ${refs.join(", ")}.`
          : "No short-answer question in these papers examines this point."}</p></div>`;
        continue;
      }
      for (const q of qs) {
        const img = q.image ? dataUri(q.image) : null;
        const lines = img && q.imageHasRules ? 2 : linesFor(q);
        body += `<article class="q">
          <div class="qhead">
            <span class="qn">${numberOf.get(q.id)}.</span>
            <span class="qlabel">${esc(q.number || "Question")}</span>
            <span class="qsrc">${esc(q.sources.join(" · "))}</span>
            <span class="qmarks">${q.marks != null ? q.marks + " mark" + (q.marks === 1 ? "" : "s") : ""}</span>
          </div>
          ${img ? `<img class="scan" src="${img.uri}" alt="Question ${esc(q.number)} as printed in the exam paper">`
                : `<p class="qtext">${esc(q.text)}</p>` +
                  (q.stimulus ? `<div class="stim"><b>Stimulus</b>${esc(q.stimulus)}</div>` : "")}
          <div class="rules">${"<i></i>".repeat(lines)}</div>
        </article>`;
      }
      if (refs.length) body += `<p class="also">Also tested by question${refs.length > 1 ? "s" : ""} ${refs.join(", ")}.</p>`;
      body += `</div>`;
    }
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
@page { size: A4; margin: 16mm 15mm 14mm; }
*{box-sizing:border-box} html,body{margin:0;padding:0}
body{font:11pt/1.5 "Aptos","Segoe UI",Helvetica,Arial,sans-serif;color:#14171d;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.cover{min-height:238mm;display:flex;flex-direction:column;justify-content:center;page-break-after:always}
.cover .eyebrow{font-size:9.5pt;letter-spacing:.22em;text-transform:uppercase;color:#5d6673;font-weight:600}
.cover h1{font-size:44pt;line-height:1.02;margin:6pt 0 0;color:#14171d;letter-spacing:-.02em}
.cover .sub{font-family:Cambria,Georgia,serif;font-size:15pt;margin:10pt 0 0;padding-bottom:12pt;border-bottom:2.5pt solid #14171d}
.cover .stat{margin:14pt 0 3pt;font-size:11pt}
.cover .prov{color:#5d6673;font-size:10pt;margin:0 0 20pt}
.cover h3{font-size:9.5pt;text-transform:uppercase;letter-spacing:.12em;margin:0 0 6pt}
.cover ul{margin:0;padding-left:14pt} .cover li{margin:0 0 5pt;font-size:10pt}
.toc{page-break-after:always}
.toc h3{font-size:9.5pt;text-transform:uppercase;letter-spacing:.12em;margin:0 0 10pt}
.csec{font-weight:700;font-size:11.5pt;margin:14pt 0 5pt;color:var(--a);border-bottom:1pt solid var(--a);padding-bottom:2pt}
.crow{display:flex;align-items:baseline;gap:4pt;font-size:9.5pt;margin:0 0 2pt;padding-left:10pt}
.crow .dots{flex:1;border-bottom:1px dotted #b9c0ca;transform:translateY(-3px)}
.crow b{font-variant-numeric:tabular-nums}
.crow.none{color:#8d95a2}.crow.none b{color:#8d95a2;font-weight:400}
.crow.xref b{font-weight:400;font-size:8.5pt;color:#5d6673}
.part{break-before:page}
.part .eyebrow{font-size:9pt;letter-spacing:.2em;text-transform:uppercase;color:var(--a);font-weight:700}
h1{font-size:24pt;margin:2pt 0 4pt;padding-bottom:6pt;border-bottom:1.6pt solid var(--a);letter-spacing:-.01em}
h2{font-size:12.5pt;color:var(--a);margin:18pt 0 2pt;break-after:avoid;break-inside:avoid}
.q{break-inside:avoid;margin:0 0 4pt;padding-top:9pt}
.qhead{display:flex;align-items:baseline;gap:6pt;font-size:9.5pt;break-after:avoid}
.qn{font-weight:700;color:var(--a)} .qlabel{font-weight:700} .qsrc{color:#5d6673}
.qmarks{margin-left:auto;font-weight:700;color:var(--a);white-space:nowrap}
.qtext{font-family:Cambria,Georgia,serif;font-size:11.5pt;line-height:1.45;margin:4pt 0 6pt;white-space:pre-wrap;break-after:avoid}
.stim{font-family:Cambria,Georgia,serif;font-size:9.5pt;line-height:1.4;background:#f2f4f7;border-top:2pt solid var(--a);padding:7pt 9pt;margin:0 0 7pt;white-space:pre-wrap}
.stim b{display:block;font-family:"Aptos",sans-serif;font-size:8pt;text-transform:uppercase;letter-spacing:.1em;color:#5d6673;margin-bottom:3pt}
img.scan{display:block;width:100%;max-width:165mm;height:auto;margin:4pt auto 7pt;break-inside:avoid}
.rules i{display:block;border-bottom:.75pt solid #b9c0ca;height:8.2mm}
.empty,.also{font-size:9.5pt;color:#5d6673;font-style:italic;margin:5pt 0 2pt}
</style></head><body>
<div class="cover">
  <div class="eyebrow">HSC Business Studies</div>
  <h1>${esc(title)}</h1>
  <div class="sub">${esc(sub)}</div>
  <div class="stat"><b>${total} short-answer questions</b> across ${sections.reduce((a, s) => a + s.groups.length, 0)} syllabus points${sections.length > 1 ? ` in ${sections.length} topics` : ""}</div>
  <div class="prov">Drawn from NESA HSC 2019–2023, school trial papers 2023–24, and topic question banks.</div>
  <h3>How to use this booklet</h3>
  <ul>
    <li>Short answer only — no multiple choice, and no 20-mark extended responses.</li>
    <li>Ruled space follows each question, sized to its mark value.</li>
    <li>A question testing two of these points is printed once and cross-referenced from the other.</li>
  </ul>
</div>
<div class="toc"><h3>Contents</h3>${rows.join("")}</div>
${body}
</body></html>`;
}

// ------------------------------------------------------------------ Word

const ruleP = () => new Paragraph({
  spacing: { before: 0, after: 0, line: 400, lineRule: "exact" },
  border: { bottom: { style: BorderStyle.SINGLE, size: 4, space: 1, color: RULE } },
});

function focusDocx({ placed, alsoAt, numberOf, total, key, sections }, title, sub) {
  const children = [];

  children.push(
    new Paragraph({ spacing: { before: 2600, after: 0 }, children: [new TextRun({
      text: "HSC BUSINESS STUDIES", bold: true, size: 19, color: MUTED, allCaps: true,
      characterSpacing: 60, font: "Aptos" })] }),
    new Paragraph({ spacing: { before: 120 }, children: [new TextRun({
      text: title, bold: true, size: 68, color: INK, font: "Aptos" })] }),
    new Paragraph({
      spacing: { before: 200, after: 260 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: INK, space: 8 } },
      children: [new TextRun({ text: sub, size: 25, color: INK, font: "Cambria" })],
    }),
    new Paragraph({ spacing: { after: 80 }, children: [new TextRun({
      text: `${total} short-answer questions across ${sections.reduce((a, s) => a + s.groups.length, 0)} syllabus points`
            + (sections.length > 1 ? ` in ${sections.length} topics` : ""),
      size: 20, color: INK, font: "Aptos" })] }),
    new Paragraph({ spacing: { after: 300 }, children: [new TextRun({
      text: "Drawn from NESA HSC 2019–2023, school trial papers 2023–24, and topic question banks.",
      size: 19, color: MUTED, font: "Aptos" })] }),
    ...[
      "Short answer only — no multiple choice, and no 20-mark extended responses.",
      "Ruled space follows each question, sized to its mark value.",
      "A question testing two of these points is printed once and cross-referenced from the other.",
    ].map(t => new Paragraph({ spacing: { after: 70 }, bullet: { level: 0 },
      children: [new TextRun({ text: t, size: 19, color: INK, font: "Aptos" })] })),
    new Paragraph({ children: [new PageBreak()] }),
  );

  // Contents
  children.push(new Paragraph({ spacing: { after: 100 }, children: [new TextRun({
    text: "CONTENTS", bold: true, size: 15, color: MUTED, allCaps: true, characterSpacing: 24, font: "Aptos" })] }));
  for (const sec of sections) {
    children.push(new Paragraph({
      spacing: { before: 220, after: 40 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: sec.accent, space: 4 } },
      children: [new TextRun({ text: sec.label, bold: true, size: 21, color: sec.accent, font: "Aptos" })],
    }));
    for (const g of sec.groups) {
      const c = placed.get(key(sec.topic, g.name)).length;
      const x = (alsoAt.get(key(sec.topic, g.name)) || []).length;
      children.push(new Paragraph({
        spacing: { after: 20 }, indent: { left: convertInchesToTwip(0.22) },
        children: [
          new TextRun({ text: g.name, size: 18, color: c ? INK : MUTED, font: "Aptos" }),
          new TextRun({ children: [new PositionalTab({
            alignment: PositionalTabAlignment.RIGHT, relativeTo: "margin", leader: PositionalTabLeader.DOT })] }),
          new TextRun({ text: c ? String(c) : x ? `↗${x}` : "—",
            size: c ? 18 : 16, bold: !!c, color: c ? sec.accent : MUTED, font: "Aptos" }),
        ],
      }));
    }
  }

  for (const sec of sections) {
    children.push(new Paragraph({
      pageBreakBefore: true, spacing: { before: 0, after: 40 },
      children: [new TextRun({ text: "TOPIC", bold: true, size: 16, color: sec.accent,
        allCaps: true, characterSpacing: 50, font: "Aptos" })],
    }));
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1, spacing: { before: 0, after: 200 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: sec.accent, space: 8 } },
      children: [new TextRun({ text: sec.label, bold: true, size: 38, color: INK, font: "Aptos" })],
    }));

    for (const g of sec.groups) {
      const qs = placed.get(key(sec.topic, g.name));
      const refs = alsoAt.get(key(sec.topic, g.name)) || [];
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_2, spacing: { before: 360, after: 60 }, keepNext: true,
        children: [new TextRun({ text: g.name, bold: true, size: 24, color: sec.accent, font: "Aptos" })],
      }));

      if (!qs.length) {
        children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({
          text: refs.length
            ? `No question of its own here. Tested inside question${refs.length > 1 ? "s" : ""} ${refs.join(", ")}.`
            : "No short-answer question in these papers examines this point.",
          italics: true, size: 19, color: MUTED, font: "Aptos" })] }));
        continue;
      }

      for (const q of qs) {
        children.push(new Paragraph({
          spacing: { before: 320, after: 100 }, keepNext: true,
          children: [
            new TextRun({ text: `${numberOf.get(q.id)}. `, bold: true, size: 21, color: sec.accent, font: "Aptos" }),
            new TextRun({ text: `${q.number || "Question"}`, bold: true, size: 21, color: INK, font: "Aptos" }),
            new TextRun({ text: `   ${q.sources.join(" · ")}`, size: 17, color: MUTED, font: "Aptos" }),
            new TextRun({ children: [new PositionalTab({
              alignment: PositionalTabAlignment.RIGHT, relativeTo: "margin", leader: PositionalTabLeader.NONE })] }),
            new TextRun({ text: q.marks != null ? `${q.marks} mark${q.marks === 1 ? "" : "s"}` : "",
              bold: true, size: 17, color: sec.accent, font: "Aptos" }),
          ],
        }));

        const meta = q.image ? imageMeta(q.image) : null;
        if (meta) {
          const scale = Math.min(1, (6.4 * 96) / meta.w, (8.2 * 96) / meta.h);
          children.push(new Paragraph({ spacing: { before: 60, after: 120 }, children: [new ImageRun({
            type: "png", data: meta.buf,
            transformation: { width: Math.round(meta.w * scale), height: Math.round(meta.h * scale) } })] }));
        } else {
          children.push(new Paragraph({ spacing: { before: 40, after: 120 }, keepNext: true,
            children: [new TextRun({ text: q.text, size: 22, color: INK, font: "Cambria" })] }));
          if (q.stimulus) {
            children.push(new Paragraph({
              spacing: { before: 60, after: 160 },
              indent: { left: convertInchesToTwip(0.25), right: convertInchesToTwip(0.25) },
              shading: { type: ShadingType.CLEAR, fill: "F2F4F7" },
              // top/bottom only: docx-js emits pBdr children in an order the
              // schema rejects once left or right is involved.
              border: {
                top: { style: BorderStyle.SINGLE, size: 6, color: sec.accent, space: 8 },
                bottom: { style: BorderStyle.SINGLE, size: 2, color: "DFE3E9", space: 8 },
              },
              children: [
                new TextRun({ text: "Stimulus   ", bold: true, size: 15, color: MUTED, allCaps: true, font: "Aptos" }),
                new TextRun({ text: q.stimulus, size: 19, color: INK, font: "Cambria" }),
              ],
            }));
          }
        }
        const lines = meta && q.imageHasRules ? 2 : linesFor(q);
        for (let i = 0; i < lines; i++) children.push(ruleP());
      }

      if (refs.length) {
        children.push(new Paragraph({ spacing: { before: 260, after: 120 }, children: [new TextRun({
          text: `Also tested by question${refs.length > 1 ? "s" : ""} ${refs.join(", ")}.`,
          italics: true, size: 18, color: MUTED, font: "Aptos" })] }));
      }
    }
  }

  return new Document({
    creator: "HSC Business Studies practice booklets",
    title: `HSC Business Studies — ${title}`,
    description: "Short-answer past-paper questions on selected syllabus points, with answer space.",
    styles: { default: { document: { run: { font: "Aptos", size: 21, color: INK } } } },
    sections: [{
      properties: { page: {
        size: A4_DOCX,
        margin: {
          top: convertInchesToTwip(0.85), bottom: convertInchesToTwip(0.7),
          left: convertInchesToTwip(0.9), right: convertInchesToTwip(0.9),
          header: convertInchesToTwip(0.4), footer: convertInchesToTwip(0.35),
        },
      } },
      headers: { default: new Header({ children: [new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "DDE1E7", space: 6 } },
        children: [new TextRun({ text: `HSC Business Studies · ${title}`, size: 16, color: MUTED, font: "Aptos" })],
      })] }) },
      footers: { default: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ children: ["Page ", PageNumber.CURRENT], size: 16, color: MUTED, font: "Aptos" })],
      })] }) },
      children,
    }],
  });
}

async function emit(browser, sections, slug, title, sub) {
  const p = plan(sections);
  const docx = path.join(OUT, `${slug}.docx`);
  fs.writeFileSync(docx, await Packer.toBuffer(focusDocx(p, title, sub)));

  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.setContent(focusHtml(p, title, sub), { waitUntil: "load" });
  await page.emulateMedia({ media: "print" });
  const pdf = path.join(OUT, `${slug}.pdf`);
  await page.pdf({
    path: pdf, format: "A4", printBackground: true,
    margin: { top: "16mm", bottom: "14mm", left: "15mm", right: "15mm" },
    displayHeaderFooter: true,
    headerTemplate: `<div style="font:8pt 'Aptos',sans-serif;color:#8d95a2;width:100%;padding:0 15mm;">HSC Business Studies · ${title}</div>`,
    footerTemplate: `<div style="font:8pt 'Aptos',sans-serif;color:#8d95a2;width:100%;padding:0 15mm;text-align:right;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
  });
  await page.close();
  if (errs.length) console.error(`  ! ${slug}: ${errs.join("; ")}`);
  return { slug, total: p.total, pdf };
}

const NOTES_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Notes</title><style>
@page { size: A4; margin: 16mm 15mm 14mm; }
*{box-sizing:border-box} html,body{margin:0;padding:0}
body{font:11pt/1.5 "Aptos","Segoe UI",Helvetica,Arial,sans-serif;color:#14171d;-webkit-print-color-adjust:exact;print-color-adjust:exact}
h2{font-size:12.5pt;color:#5d6673;margin:0 0 10pt;text-transform:uppercase;letter-spacing:.12em;font-size:9.5pt}
.rules i{display:block;border-bottom:.75pt solid #b9c0ca;height:8.2mm}
</style></head><body><h2>Notes</h2><div class="rules">${"<i></i>".repeat(30)}</div></body></html>`;

async function emitNotesPage(browser, file) {
  const page = await browser.newPage();
  await page.setContent(NOTES_HTML, { waitUntil: "load" });
  await page.emulateMedia({ media: "print" });
  await page.pdf({ path: file, format: "A4", printBackground: true,
    margin: { top: "16mm", bottom: "14mm", left: "15mm", right: "15mm" } });
  await page.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(launchOptions());
  await emitNotesPage(browser, path.join(OUT, "_notes-page-a4.pdf"));

  const made = [];
  for (const sec of FOCUS) {
    made.push(await emit(browser, [sec], `HSC-BS-Exam-Focus-${sec.label.replace(/ /g, "-")}`,
      `${sec.label} — exam focus`, "Short-answer practice on the points you flagged"));
  }
  made.push(await emit(browser, FOCUS, "HSC-BS-Exam-Focus-All-Topics",
    "Exam focus", "Short-answer practice on the points you flagged, all four topics"));

  await browser.close();
  for (const m of made) console.log(`${m.slug.padEnd(44)} ${String(m.total).padStart(3)} questions`);
  console.log("wrote", OUT);
})();
