#!/usr/bin/env node
/**
 * Render each topic booklet to PDF.
 *
 * Uses the same placement plan as the Word builder, so question numbers match
 * between the two formats, then prints through Chromium. (LibreOffice cannot
 * do the conversion here — the image ships libreoffice-core with no writer
 * filter installed.)
 *
 *   node scripts/build-saq-pdf.cjs [--out <dir>]
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { plan, TOPICS, isExtended } = require("./build-saq-docs.cjs");

const ROOT = path.dirname(__dirname);
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

const esc = s => String(s == null ? "" : s)
  .replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const imgCache = new Map();
function dataUri(name) {
  if (imgCache.has(name)) return imgCache.get(name);
  const file = path.join(IMG_DIR, name);
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  const uri = "data:image/png;base64," + buf.toString("base64");
  imgCache.set(name, { uri, w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
  return imgCache.get(name);
}

function linesFor(q) {
  if (q.type === "multiple-choice") return 1;
  const m = q.marks || 2;
  if (m >= 10) return 26;
  return Math.max(4, m * 2 + 2);
}

function questionHtml(q, n) {
  const img = q.image ? dataUri(q.image) : null;
  const marks = q.marks != null ? `${q.marks} mark${q.marks === 1 ? "" : "s"}`
    : q.type === "multiple-choice" ? "multiple choice" : "";

  let lines = linesFor(q);
  if (img && q.imageHasRules) lines = q.type === "multiple-choice" ? 1 : 2;

  const body = img
    ? `<img class="scan" src="${img.uri}" alt="Question ${esc(q.number)} as printed in the exam paper">`
    : `<p class="qtext">${esc(q.text)}</p>` +
      (q.stimulus ? `<div class="stim"><b>Stimulus</b>${esc(q.stimulus)}</div>` : "");

  const space = q.type === "multiple-choice"
    ? `<p class="mcq">Answer: <span class="blank"></span></p>`
    : `<div class="rules">${'<i></i>'.repeat(lines)}</div>`;

  return `<article class="q">
    <div class="qhead">
      <span class="qn">${n}.</span>
      <span class="qlabel">${esc(q.number || "Question")}</span>
      <span class="qsrc">${esc(q.sources.join(" · "))}</span>
      <span class="qmarks">${esc(marks)}</span>
    </div>
    ${body}
    ${space}
  </article>`;
}

function topicHtml(topic) {
  const { tax, mine, orderedPoints, sections, primary, extendedBySection, alsoAt, numberOf, total } = plan(topic);
  const accent = "#" + topic.accent;
  const shots = mine.filter(q => q.image).length;
  const covered = orderedPoints.filter(p => (primary.get(p.id) || []).length).length;

  const contents = (() => {
    let last = null, out = "";
    for (const p of orderedPoints) {
      const c = (primary.get(p.id) || []).length;
      const xref = new Set(alsoAt.get(p.id) || []).size;
      if (p.section !== last) { last = p.section; out += `<div class="csec">${esc(p.section)}</div>`; }
      const tally = c ? String(c) : xref ? `\u2197${xref}` : "\u2014";
      out += `<div class="crow ${c ? "" : xref ? "xref" : "none"}"><span>${esc(p.heading)}</span><span class="dots"></span><b>${tally}</b></div>`;
    }
    return out;
  })();

  let body = "", sectionNo = 0;
  for (const section of sections) {
    sectionNo++;
    body += `<section class="part${sectionNo > 1 ? " brk" : ""}">
      <div class="parteyebrow">Part ${sectionNo}</div>
      <h1>${esc(section)}</h1></section>`;

    for (const p of orderedPoints.filter(x => x.section === section)) {
      const qs = primary.get(p.id) || [];
      const also = [...new Set(alsoAt.get(p.id) || [])].sort((a, b) => a - b);
      if (!qs.length && !also.length) continue;

      body += `<h2>${esc(p.heading)}</h2>`;
      if (!qs.length) {
        body += `<p class="empty">${also.length
          ? `No short-answer question of its own. Covered inside question${also.length > 1 ? "s" : ""} ${also.join(", ")}.`
          : "No question in these papers examines this dot point."}</p>`;
        continue;
      }
      body += qs.map(q => questionHtml(q, numberOf.get(q.id))).join("");
      if (also.length) body += `<p class="also">Also tested by question${also.length > 1 ? "s" : ""} ${also.join(", ")}.</p>`;
    }

    // Every 20-marker for this part, gathered on its own page and listed
    // without answer space — these get written up on separate paper.
    const ext = extendedBySection.get(section) || [];
    if (ext.length) {
      body += `<section class="extpage">
        <div class="parteyebrow">Part ${sectionNo} · extended response</div>
        <h1>${esc(section)} — 20-mark questions</h1>
        <p class="extnote">${ext.length} question${ext.length > 1 ? "s" : ""}. Plan and write these on separate paper.</p>
        ${ext.map(q => {
          const img = q.image ? dataUri(q.image) : null;
          return `<article class="exti">
            <div class="qhead">
              <span class="qn">${numberOf.get(q.id)}.</span>
              <span class="qlabel">${esc(q.number || "Question")}</span>
              <span class="qsrc">${esc(q.sources.join(" · "))}</span>
              <span class="qmarks">${q.marks != null ? q.marks + " marks" : "extended response"}</span>
            </div>
            ${img ? `<img class="scan tight" src="${img.uri}" alt="Question ${esc(q.number)} as printed in the exam paper">`
                  : `<p class="qtext tight">${esc(q.text)}</p>` +
                    (q.stimulus ? `<div class="stim tight"><b>Stimulus</b>${esc(q.stimulus)}</div>` : "")}
          </article>`;
        }).join("")}
      </section>`;
    }
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(tax.label)}</title><style>
@page { size: A4; margin: 16mm 15mm 14mm; }
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font:11pt/1.5 "Aptos","Segoe UI",Helvetica,Arial,sans-serif;color:#14171d;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.cover{min-height:238mm;display:flex;flex-direction:column;justify-content:center;page-break-after:always}
.cover .eyebrow{font-size:9.5pt;letter-spacing:.22em;text-transform:uppercase;color:#5d6673;font-weight:600}
.cover h1{font-size:44pt;line-height:1.02;margin:6pt 0 0;color:${accent};letter-spacing:-.02em}
.cover .sub{font-family:Cambria,Georgia,serif;font-size:15pt;margin:10pt 0 0;padding-bottom:12pt;border-bottom:2.5pt solid ${accent}}
.cover .stat{margin:14pt 0 3pt;font-size:11pt}
.cover .prov{color:#5d6673;font-size:10pt;margin:0 0 20pt}
.cover h3{font-size:9.5pt;text-transform:uppercase;letter-spacing:.12em;color:${accent};margin:0 0 6pt}
.cover ul{margin:0;padding-left:14pt}
.cover li{margin:0 0 5pt;font-size:10pt}
.toc{page-break-after:always}
.toc h3{font-size:9.5pt;text-transform:uppercase;letter-spacing:.12em;color:${accent};margin:0 0 10pt}
.csec{font-weight:700;font-size:11pt;margin:12pt 0 4pt}
.crow{display:flex;align-items:baseline;gap:4pt;font-size:9.5pt;margin:0 0 2pt;padding-left:10pt}
.crow .dots{flex:1;border-bottom:1px dotted #b9c0ca;transform:translateY(-3px)}
.crow b{color:${accent};font-variant-numeric:tabular-nums}
.crow.none{color:#8d95a2}.crow.none b{color:#8d95a2;font-weight:400}
.crow.xref b{font-weight:400;font-size:8.5pt}
.part{break-before:auto}
.part.brk{break-before:page}
.parteyebrow{font-size:9pt;letter-spacing:.2em;text-transform:uppercase;color:${accent};font-weight:700}
h1{font-size:21pt;margin:2pt 0 4pt;padding-bottom:6pt;border-bottom:1.6pt solid ${accent};letter-spacing:-.01em}
h2{font-size:12.5pt;color:${accent};margin:18pt 0 2pt;break-after:avoid;break-inside:avoid}
.q{break-inside:avoid;margin:0 0 4pt;padding-top:9pt}
.qhead{display:flex;align-items:baseline;gap:6pt;font-size:9.5pt;break-after:avoid}
.qn{font-weight:700;color:${accent}}
.qlabel{font-weight:700}
.qsrc{color:#5d6673}
.qmarks{margin-left:auto;font-weight:700;color:${accent};white-space:nowrap}
.qtext{font-family:Cambria,Georgia,serif;font-size:11.5pt;line-height:1.45;margin:4pt 0 6pt;white-space:pre-wrap;break-after:avoid}
.stim{font-family:Cambria,Georgia,serif;font-size:9.5pt;line-height:1.4;background:#f2f4f7;border-top:2pt solid ${accent};
  padding:7pt 9pt;margin:0 0 7pt;white-space:pre-wrap}
.stim b{display:block;font-family:"Aptos",sans-serif;font-size:8pt;text-transform:uppercase;letter-spacing:.1em;color:#5d6673;margin-bottom:3pt}
img.scan{display:block;width:100%;max-width:165mm;height:auto;margin:4pt auto 7pt;break-inside:avoid}
.rules i{display:block;border-bottom:.75pt solid #b9c0ca;height:8.2mm}
.mcq{font-size:10pt;color:#5d6673;font-weight:600;margin:6pt 0 4pt}
.mcq .blank{display:inline-block;width:38mm;border-bottom:.9pt solid #7b8391}
.empty,.also{font-size:9.5pt;color:#5d6673;font-style:italic;margin:5pt 0 2pt}
.extpage{break-before:page}
.extnote{font-size:9.5pt;color:#5d6673;font-style:italic;margin:4pt 0 10pt}
.exti{break-inside:avoid;margin:0 0 11pt;padding-bottom:9pt;border-bottom:.5pt solid #e3e7ec}
.exti:last-child{border-bottom:0}
.qtext.tight{font-size:10.5pt;line-height:1.35;margin:3pt 0 4pt}
.stim.tight{font-size:9pt;line-height:1.32;padding:5pt 7pt;margin:0}
img.scan.tight{max-width:135mm;max-height:95mm;width:auto;margin:3pt 0 4pt}
</style></head><body>
<div class="cover">
  <div class="eyebrow">HSC Business Studies</div>
  <h1>${esc(tax.label)}</h1>
  <div class="sub">Practice questions by syllabus point</div>
  <div class="stat"><b>${total} questions</b> · ${shots} shown as screenshots of the printed paper · ${covered} of ${orderedPoints.length} syllabus points covered</div>
  <div class="prov">Drawn from 23 papers: NESA HSC 2019–2023, school trial papers 2023–24, and topic question banks.</div>
  <h3>How to use this booklet</h3>
  <ul>
    <li>Questions sit under the syllabus dot point they actually test, in syllabus order.</li>
    <li>Ruled space follows each question, sized to its mark value — write straight onto the page, on paper or with a stylus.</li>
    <li>A question testing more than one dot point is printed once and cross-referenced from the others.</li>
    <li>Where a scan of the original page exists it is shown as-is, so you see the real layout and mark boxes.</li>
  </ul>
</div>
<div class="toc"><h3>Contents</h3>${contents}</div>
${body}
</body></html>`;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(launchOptions());
  for (const t of TOPICS) {
    const page = await browser.newPage();
    const errs = [];
    page.on("pageerror", e => errs.push(e.message));
    await page.setContent(topicHtml(t), { waitUntil: "load" });
    await page.emulateMedia({ media: "print" });
    const file = path.join(OUT, `HSC-Business-Studies-${t.file}-SAQ-Booklet.pdf`);
    await page.pdf({
      path: file, format: "A4", printBackground: true,
      margin: { top: "16mm", bottom: "14mm", left: "15mm", right: "15mm" },
      displayHeaderFooter: true,
      headerTemplate: `<div style="font:8pt 'Aptos',sans-serif;color:#8d95a2;width:100%;padding:0 15mm;">
        HSC Business Studies · ${t.file.replace(/-/g, " ")}</div>`,
      footerTemplate: `<div style="font:8pt 'Aptos',sans-serif;color:#8d95a2;width:100%;padding:0 15mm;text-align:right;">
        Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
    });
    await page.close();
    const kb = (fs.statSync(file).size / 1e6).toFixed(2);
    console.log(`${t.file.padEnd(16)} ${kb} MB${errs.length ? "  ERRORS: " + errs.join("; ") : ""}`);
  }
  await browser.close();
  console.log("wrote", OUT);
})();
