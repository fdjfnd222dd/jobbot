// Usage: node cover_letter.js <letter.json> <output.docx>
// Builds a one-page cover letter DOCX with the same header as the resume (centered name +
// contact line, Times New Roman). cover.sh turns it into a PDF.
//
// letter.json:
// {
//   "company":   "IBM",                          required
//   "role":      "Site Reliability Engineer Intern",  required
//   "date":      "October 7, 2026",              optional, default = today
//   "greeting":  "Dear Hiring Team,",            optional, default = "Dear Hiring Manager,"
//   "paragraphs": ["...", "..."],                required, plain text, one string per paragraph
//   "closing":   "Sincerely,",                   optional, default = "Sincerely,"
//   "recipient": ["Hiring Team", "IBM", "Raleigh, NC"],  optional, lines above the greeting;
//                                                default = ["Hiring Team", company]
//   "name", "contact": optional; default = the resume master (data/resumes/master.json),
//                      so the letter header always matches the resume header.
//   "fontSize": optional, half-points (22 = 11pt, the default)
// }
// No em dashes, please: the same writing rules as the resume apply.
const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph } = require('docx');
const C = require('./common');

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) { console.error('usage: node cover_letter.js letter.json out.docx'); process.exit(1); }
const L = JSON.parse(fs.readFileSync(inPath, 'utf8'));
for (const k of ['company', 'role']) if (!L[k]) { console.error(`missing "${k}" in ${inPath}`); process.exit(1); }
if (!Array.isArray(L.paragraphs) || !L.paragraphs.length) { console.error(`"paragraphs" must be a non-empty array`); process.exit(1); }

// Header identity: letter JSON wins, else the resume master, so both documents match.
let who = { name: L.name, contact: L.contact };
if (!who.name || !who.contact) {
  const master = process.env.JOBBOT_RESUME_MASTER || path.join(__dirname, '..', 'data', 'resumes', 'master.json');
  try { const M = JSON.parse(fs.readFileSync(master, 'utf8')); who = { name: who.name || M.name, contact: who.contact || M.contact }; }
  catch (e) { console.error(`no name/contact in letter and cannot read ${master}: ${e.message}`); process.exit(1); }
}

const S = L.fontSize || 22;
const r = (t, o = {}) => C.run(t, { size: S, ...o });
const para = (children, o = {}) => new Paragraph({ spacing: { before: 0, after: o.after ?? 0 }, alignment: o.align, children });
const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

const kids = [...C.header(who.name, who.contact)];
kids.push(para([], { after: 240 }));   // gap under the contact line
kids.push(para([r(L.date || today)], { after: 240 }));
const recipient = L.recipient || ['Hiring Team', L.company];
recipient.forEach((line, i) => kids.push(para([r(line)], { after: i === recipient.length - 1 ? 240 : 0 })));
kids.push(para([r('Re: ', { b: true }), r(L.role, { b: true })], { after: 240 }));
kids.push(para([r(L.greeting || 'Dear Hiring Manager,')], { after: 160 }));
L.paragraphs.forEach(p => kids.push(para([r(p)], { after: 160 })));
kids.push(para([r(L.closing || 'Sincerely,')], { after: 360 }));
kids.push(para([r(who.name)]));

// 0.5" top/bottom like the resume; 1" sides read better for prose than the resume's 0.5".
const doc = new Document({ sections: [{ properties: { page: { size: C.PAGE,
  margin: { top: 720, bottom: 720, left: 1440, right: 1440 } } }, children: kids }] });
Packer.toBuffer(doc).then(b => { fs.writeFileSync(outPath, b); console.log('wrote', outPath); });
