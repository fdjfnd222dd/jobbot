'use strict';
/*
 * The default output of `jobctl apply / continue / batch / answer / answer-batch / code` (2026-10-09). The compact
 * JSON (lib/brief.js) still printed every need as a multi-line object with its option array, so a session wrote its own
 * parser to get "ref | kind | label | options" lines. This prints that directly: a head line (run, status, exit
 * meaning), who, the message, then ONE LINE PER NEED with its exact options as a JSON array (answers must match an
 * option exactly, and JSON keeps "Job Board - Linkedin" or "TCP/IP" unambiguous). `--json` prints the compact JSON,
 * `--full` the whole report. Pure: takes what lib/brief.js briefReport() returns.
 */

const one = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const q = (s) => `"${one(s)}"`;

/** One need on one line: ref, kind (* = required), label, current value, flags, what was tried, hints, then options. */
function needLine(n) {
  const parts = [`${n.ref || '-'} ${n.type || n.kind || '?'}${n.required ? '*' : ''}${n.label ? ' ' + q(n.label) : ''}`];
  if (n.value !== undefined) parts.push(`= ${q(n.value)}${n.source ? ` (from ${n.source})` : ''}`);
  const flags = ['consent', 'aiPolicy', 'pressed', 'optional'].filter((k) => n[k] === true);
  if (n.declined) flags.push(`declined${typeof n.declined === 'string' ? ': ' + n.declined : ''}`);
  if (flags.length) parts.push(`[${flags.join(', ')}]`);
  if (n.tried) parts.push(`tried ${q(n.tried)}`);
  if (n.error) parts.push(`error: ${one(n.error)}`);
  for (const k of ['hint', 'topic', 'site', 'email', 'for', 'placeholder', 'note']) if (n[k]) parts.push(`${k}: ${one(n[k])}`);
  if (Array.isArray(n.errors) && n.errors.length) parts.push(`page errors: ${n.errors.map(one).join(' | ')}`);
  if (Array.isArray(n.emptyRequired) && n.emptyRequired.length) parts.push(`still empty: ${n.emptyRequired.map(one).join(', ')}`);
  if (Array.isArray(n.options) && n.options.length) {
    const more = n.optionCount ? ` (${n.optionCount}, first ${n.options.length}; all: jobctl options ${n.ref})` : '';
    parts.push(`options${more}: ${JSON.stringify(n.options)}`);
  }
  let line = parts.join(' | ');
  if (n.pageText) line += `\n      page: ${one(n.pageText)}`;
  return line;
}

/** A compact run report (briefRun) as text. */
function runText(b) {
  if (!b || typeof b !== 'object') return String(b);
  const L = [`run ${b.run || '?'} | ${b.status || '?'} | ${b.exit || ''}`.trim()];
  const who = [b.company, b.role].filter(Boolean).join(' - ');
  if (who || b.url) L.push([who, b.url].filter(Boolean).join(' | '));
  if (b.message) L.push(`message: ${one(b.message)}`);
  if (b.errors && b.errors.length) L.push(`errors: ${b.errors.map(one).join(' | ')}`);
  if (b.needs && b.needs.length) {
    L.push(`needs (${b.needs.length}): ref kind(*=required) "label" | = value | ... | options`);
    for (const n of b.needs) L.push(`  ${needLine(n)}`);
  }
  if (b.previous) L.push(`previous: run ${b.previous.run} at ${b.previous.at}`);
  if (b.shot) L.push(`shot: ${b.shot}`);
  if (b.row) L.push(`row: ${JSON.stringify(b.row)}`);
  if (b.dry) L.push('dry run (nothing submitted)');
  return L.join('\n');
}

/** What answer / answer-batch / code did (briefAnswer). */
function answerText(a) {
  if (!a || typeof a !== 'object') return String(a);
  const head = [`answered ${a.answered != null ? a.answered : a.ok ? 'ok' : 'failed'}`];
  if (a.boxes != null) head.push(`code boxes ${a.filled || 0}/${a.boxes}`);
  if (a.savedAs) head.push(`saved as ${q(a.savedAs)}`);
  if (a.error) head.push(`error: ${one(a.error)}`);
  if (a.reason) head.push(one(a.reason));
  if (a.placeholder) head.push(`expected format: ${one(a.placeholder)}`);
  if (a.warning) head.push(`warning: ${one(a.warning)}`);
  if (a.note) head.push(`note: ${one(a.note)}`);
  const L = [head.join(' | ')];
  for (const f of a.failed || []) L.push(`  failed ${f.ref}: ${one(f.error || 'not set')}${f.options ? ` | options${f.optionCount ? ` (${f.optionCount})` : ''}: ${JSON.stringify(f.options)}` : ''}`);
  for (const w of a.warnings || []) L.push(`  warning ${w.ref}: ${one(w.warning)}`);
  if (Array.isArray(a.options) && a.options.length) L.push(`  options${a.optionCount ? ` (${a.optionCount})` : ''}: ${JSON.stringify(a.options)}`);
  return L.join('\n');
}

/** Whatever briefReport() returned (a run, a --continue result, or a batch), as text. */
function reportText(b) {
  if (!b || typeof b !== 'object') return String(b);
  if (b.answered && typeof b.answered === 'object') {
    if (b.continued === false) return `${answerText(b.answered)}\nnot continued: ${one(b.reason)}`;
    return `${answerText(b.answered)}\n${runText(b.run)}`;
  }
  if (Array.isArray(b.results)) {
    const L = [`batch: ${Object.entries(b.count || {}).map(([k, v]) => `${v} ${k}`).join(', ')}`];
    for (const r of b.results) {
      L.push(`  ${r.status} | ${r.run || '-'} | ${[r.company, r.role].filter(Boolean).join(' - ') || '?'} | ${r.url}${r.needs ? ` | ${r.needs} needs (jobctl continue ${r.run})` : ''}${r.message ? ` | ${one(r.message)}` : ''}`);
      if (r.row) L.push(`    row: ${JSON.stringify(r.row)}`);
    }
    return L.join('\n');
  }
  return runText(b);
}

/**
 * `jobctl status`: the needs of a waiting run, one short line each. Every one is listed up to `max`; past that, a
 * "+N more" line says where the rest are (2026-10-09: status showed 4 of a run's 12 needs and said nothing).
 */
function statusNeedLines(needs, runId, max = 15) {
  const list = (needs || []).filter((n) => n.type !== 'review');
  const reviews = (needs || []).length - list.length;
  const out = list.slice(0, max).map((n) => `- ${one(n.label || n.type).slice(0, 90)}${n.ref ? '  [' + n.ref + ']' : ''}${n.required ? ' *' : ''}`);
  if (list.length > max) out.push(`+${list.length - max} more (jobctl show ${runId})`);
  if (reviews) out.push(`(+${reviews} low-confidence fill${reviews > 1 ? 's' : ''} to check: jobctl show ${runId})`);
  return out;
}

module.exports = { needLine, runText, answerText, reportText, statusNeedLines };
