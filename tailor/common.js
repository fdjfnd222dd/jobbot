// Shared look for the resume and the cover letter, so both documents match.
// Times New Roman, US Letter, 0.5" side margins, centered name + contact line.
// (Times New Roman is not installed on this laptop; LibreOffice swaps in Liberation Serif,
//  which has identical metrics, so line breaks and page fit are the same as in Word.)
const { Paragraph, TextRun, AlignmentType } = require('docx');

const FONT = 'Times New Roman';
const PAGE = { width: 12240, height: 15840 };      // US Letter in twips (1/1440 inch)
const MARGIN = 720;                                  // 0.5 inch
const RIGHT_TAB = PAGE.width - 2 * MARGIN;           // right-aligned tab stop at the text edge

// One text run. size is in half-points (21 = 10.5pt).
const run = (text, o = {}) => new TextRun({ text, font: FONT, size: o.size || 21, bold: o.b, italics: o.i });

// Name (17pt bold) + contact line (9.5pt), both centered. Same as the resume header.
const header = (name, contact) => [
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [run(name, { b: true, size: 34 })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [run(contact, { size: 19 })] }),
];

module.exports = { FONT, PAGE, MARGIN, RIGHT_TAB, run, header };
