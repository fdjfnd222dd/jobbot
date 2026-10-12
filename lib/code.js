'use strict';
/**
 * Emailed verification codes (owner rule 2026-10-08: Claude reads them from Gmail and types them in).
 * Greenhouse splits its 8-character security code over 8 boxes (the first labelled "Security code", the rest
 * with the "A verification code was sent to..." sentence); Oracle splits its PIN over 6 boxes ("Enter
 * verification code digit 1 of six."). Typing one box per `jobctl set` took 8 calls a run (2026-10-08).
 * codeBoxes() maps a code onto the page's boxes: one character per box, or the whole code in a single box.
 */
const CODE_LABEL = /security code|verification code|one[- ]time (pass)?code|passcode|\bpin\b|enter the \d+-character code|digit \d+ of/i;

// Never a code box: a PIN or code the person makes up, or a payment card's security code.
const NOT_CODE = /\b(create|new|choose|confirm|re-?enter)\b|cvv|cvc|card/i;
// Split boxes say which character they hold, or carry the "code was sent" sentence (Greenhouse).
const SPLIT = /digit \d+ of|verification code|security code|code was sent/i;

function codeBoxes(fields, code) {
  const value = String(code || '').trim();
  const boxes = (fields || []).filter((f) => /^(text|tel|number|password)$/.test(f.kind || 'text') && CODE_LABEL.test(f.label || '') && !NOT_CODE.test(f.label || ''));
  if (!value || !boxes.length) return [];
  if (boxes.length === 1) return [{ ref: boxes[0].ref, value }];
  const split = boxes.filter((f) => SPLIT.test(f.label || ''));
  if (split.length !== value.length) return []; // ambiguous: type it with jobctl set
  return [...value].map((ch, i) => ({ ref: split[i].ref, value: ch }));
}

module.exports = { codeBoxes };
