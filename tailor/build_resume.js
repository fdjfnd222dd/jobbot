// Usage: node build_resume.js <resume.json> <output.docx>
// Builds the owner's one-page, parser-friendly resume from a JSON content file.
// Copied from the claude.ai skill resume-tailor (scripts/build_resume.js) on 2026-10-07.
// Only change: font/page/header come from ./common.js so the cover letter matches exactly.
const fs = require('fs');
const { Document, Packer, Paragraph, TextRun, TabStopType, BorderStyle } = require('docx');
const C = require('./common');
const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) { console.error('usage: node build_resume.js resume.json out.docx'); process.exit(1); }
const R = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const F = C.FONT, S = R.fontSize || 21, MARGIN = C.MARGIN, RT = C.RIGHT_TAB;
const r = (t, o = {}) => new TextRun({ text: t, font: F, size: o.size || S, bold: o.b, italics: o.i });
const head = t => new Paragraph({ spacing: { before: 110, after: 50 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 } },
  children: [r(t, { b: true, size: 25 })] });
const line = (left, right, o = {}) => new Paragraph({ spacing: { before: o.before || 0, after: 0 },
  tabStops: [{ type: TabStopType.RIGHT, position: RT }],
  children: [...left, ...(right ? [r('\t'), r(right, { i: o.ri !== false })] : [])] });
// Plain-text dash bullets (Word list bullets get mangled into "1." by Workday)
const bullet = t => new Paragraph({ spacing: { after: 0 }, indent: { left: 300, hanging: 180 },
  tabStops: [{ type: TabStopType.LEFT, position: 300 }], children: [r('-\t' + t)] });
const kids = [];
kids.push(...C.header(R.name, R.contact));

kids.push(head('Education'));
const ed = R.education;
kids.push(line([r(ed.school, { b: true })], ed.location, { ri: false }));
kids.push(line([r(ed.degree, { i: true })], ed.date));
(ed.extra || []).forEach(x => kids.push(new Paragraph({ spacing: { after: 0 },
  children: x.label ? [r(x.label + ': ', { i: true }), r(x.text)] : [r(x.text)] })));

// Experience: line 1 = company (bold) + location, line 2 = title (italic) + dates
kids.push(head('Experience'));
R.experience.forEach(j => {
  kids.push(line([r(j.company, { b: true })], j.location, { before: 40, ri: false }));
  kids.push(line([r(j.title, { i: true })], j.dates));
  j.bullets.forEach(b => kids.push(bullet(b)));
});

// Certifications sit above Projects, as on the owner's own resume (2026-10-12 layout).
kids.push(head('Certifications and Training'));
R.certifications.forEach(c => kids.push(line([r(c.label, { b: true }), r(c.text)], c.date)));

if (R.projects && R.projects.length) {
  kids.push(head('Projects'));
  R.projects.forEach(p => {
    kids.push(new Paragraph({ spacing: { before: 40, after: 0 }, children: [r(p.name, { b: true })] }));
    p.bullets.forEach(b => kids.push(bullet(b)));
  });
}

kids.push(head('Technical Skills'));
R.skills.forEach(s => kids.push(new Paragraph({ spacing: { after: 0 }, indent: { left: 300, hanging: 180 },
  children: [r('-\t'), r(s.label + ': ', { b: true }), r(s.items)] })));

if (R.leadership && R.leadership.length) {
  kids.push(head('Leadership'));
  const parts = [];
  R.leadership.forEach((l, i) => {
    if (i) parts.push(r('  |  '));
    parts.push(r(l.bold, { b: true }));
    parts.push(r(l.rest || ''));
  });
  kids.push(new Paragraph({ spacing: { after: 0 }, children: parts }));
}

const doc = new Document({ sections: [{ properties: { page: { size: C.PAGE,
  margin: { top: 620, bottom: 620, left: MARGIN, right: MARGIN } } }, children: kids }] });
Packer.toBuffer(doc).then(b => { fs.writeFileSync(outPath, b); console.log('wrote', outPath); });
