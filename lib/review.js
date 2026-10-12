'use strict';
/*
 * `jobctl review-answers`: an audit of the Q&A bank for the owner.
 * The bank is reused on every application, so one wrong or over-specific answer
 * repeats everywhere. Flags:
 *   names    the question or answer names a company jobbot has applied to (should be {company}, or forgotten)
 *   claim    the answer mentions something on facts.md's DO NOT CLAIM / never-confirmed lists
 *   dup      the same question is stored twice
 *   long     long free text, reused word for word
 *   empty    no answer stored
 */
const fs = require('node:fs');
const path = require('node:path');
const D = require('./data');
const R = require('./runs');
const { ROOT } = require('./paths');

/** Terms from facts.md's "DO NOT CLAIM" and "Never confirmed" paragraphs. */
function doNotClaim() {
  let text = '';
  try {
    text = fs.readFileSync(path.join(ROOT, 'tailor', 'references', 'facts.md'), 'utf8');
  } catch (e) {
    return [];
  }
  const out = new Set();
  const grab = (re) => {
    const m = re.exec(text);
    if (!m) return;
    m[1]
      .replace(/\n/g, ' ')
      .replace(/\([^)]*\)/g, '')
      .split(/[,.;]/)
      .map((t) => t.replace(/^\s*(any|specific)\s+/i, '').trim())
      .filter((t) => t && t.length <= 40 && !/^(if|or|never|put it|call it)/i.test(t))
      .forEach((t) => t.split('/').forEach((x) => x.trim().length >= 2 && out.add(x.trim())));
  };
  grab(/^DO NOT CLAIM \([^)]*\):?\s*\n([\s\S]*?)(?:\nNever confirmed|\n## )/m);
  grab(/Never confirmed[^:]*:\s*([\s\S]*?)(?:If a posting|\n## )/);
  return Array.from(out);
}

// Company names the /apply skill caches from the tracker (one per line), plus everything jobbot ran.
const TRACKER_COMPANIES = path.join(D.DATA_DIR, 'tracker-companies.txt');

function knownCompanies() {
  const names = new Set();
  try {
    fs.readFileSync(TRACKER_COMPANIES, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).forEach((n) => names.add(n));
  } catch (e) {
    /* no cache yet */
  }
  for (const a of D.applied()) if (a.company) names.add(a.company);
  for (const id of R.list()) {
    try {
      const r = R.load(id);
      if (r.company) names.add(r.company);
    } catch (e) {
      /* skip */
    }
  }
  return Array.from(names);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function review() {
  const entries = D.answers().entries;
  const terms = doNotClaim();
  const companies = knownCompanies();
  const seen = new Map();
  return entries.map((e) => {
    const flags = [];
    const answer = String(e.answer == null ? '' : e.answer);
    if (!answer.trim()) flags.push('empty');
    const only = [];
    for (const c of companies) {
      const comp = D.companyOf(c);
      const inQuestion = comp && D.AF.company.mentions(e.question, comp);
      if (inQuestion) only.push(c); // matches that company's form only: fine
      else if (D.stillNamed(answer, c).length) flags.push(`answer names ${c} but the question is generic`);
    }
    const hits = terms.filter((t) => new RegExp(`(?<![A-Za-z0-9])${esc(t)}(?![A-Za-z0-9])`, 'i').test(answer));
    if (hits.length) flags.push(`claim: ${hits.join(', ')}`);
    for (const q of [e.question].concat(e.aliases || [])) {
      if (seen.has(q) && seen.get(q) !== e.id) flags.push(`dup of ${String(seen.get(q)).slice(0, 12)}`);
      else seen.set(q, e.id);
    }
    if (answer.length > 300) flags.push('long');
    // A {company} answer to a question about the owner's history with that company is true for one
    // company only ("never worked at {company}" is false for a past employer).
    if (/\{company\}/.test(e.question) && /\b(work(ed)? (for|at|with)|employ|intern(ed)?|interview|relative|related|family|referr|contractor|applied)\b/.test(e.question)) flags.push('company-specific fact as {company}');
    return {
      id: e.id,
      question: e.question,
      answer,
      reusable: /\{company\}/.test(e.question + answer) || undefined,
      sensitive: e.sensitive || undefined,
      aliases: (e.aliases || []).length || undefined,
      updated: e.updatedAt ? new Date(e.updatedAt).toISOString().slice(0, 10) : undefined,
      only: only.length ? only : undefined,
      flags,
    };
  });
}

function report(format) {
  const rows = review();
  if (format === 'json') return { count: rows.length, flagged: rows.filter((r) => r.flags.length).length, entries: rows };
  const cut = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  const lines = [`Q&A bank: ${rows.length} answers, ${rows.filter((r) => r.flags.length).length} flagged. Fix: jobctl remember "<q>" "<a>"; remove: jobctl forget <id>.`, ''];
  const order = rows.slice().sort((a, b) => b.flags.length - a.flags.length);
  for (const r of order) {
    const tags = [r.flags.length ? '!! ' + r.flags.join('; ') : null, r.only ? `${r.only.join(', ')} only` : null, r.sensitive ? `sensitive:${r.sensitive}` : null, r.reusable ? '{company}' : null].filter(Boolean).join(' | ');
    lines.push(`${r.id}  ${cut(r.question, 90)}`);
    lines.push(`    -> ${cut(r.answer.replace(/\s+/g, ' '), 110)}${tags ? '   [' + tags + ']' : ''}`);
  }
  return lines.join('\n');
}

module.exports = { review, report, doNotClaim };
