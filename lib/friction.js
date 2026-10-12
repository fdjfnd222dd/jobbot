'use strict';
/*
 * `jobctl friction`: what keeps slowing applications down, from data/friction.jsonl (one line per run stop,
 * written by lib/apply.js). The /apply skill reads this after each batch, fixes the top item (code +
 * regression test + docs/SITE-NOTES.md) and records it in docs/IMPROVEMENTS.md.
 */
const fs = require('node:fs');
const path = require('node:path');
const D = require('./data');

function load(days) {
  const since = Date.now() - (days || 30) * 86400000;
  try {
    return fs
      .readFileSync(path.join(D.DATA_DIR, 'friction.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => Date.parse(r.at) >= since && !r.dry);
  } catch (e) {
    return [];
  }
}

const count = (arr) => Object.entries(arr.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);

// Statuses that are not a stop: the run went through (or was closed / dropped on purpose). Shared with lib/hiccups.js.
const NOT_STOP = ['submitted', 'already_applied', 'closed', 'dropped', 'ready_to_submit']; // ready_to_submit: --no-submit by choice, not a stop

/** A friction row that is a stop (the run needed a human or a hand fix), not a finished run. */
const isStop = (r) => !!r && !r.dry && !NOT_STOP.includes(r.status);

function report(days) {
  const rows = load(days);
  const runs = new Map();
  for (const r of rows) runs.set(r.run, r); // last stop per run
  const finals = [...runs.values()];
  const submitted = finals.filter((r) => r.status === 'submitted');
  // A stop is no longer "stuck" when the SAME posting was submitted later (older rows have no url:
  // fall back to the same company + role).
  const { postingKey } = require('./urls');
  const doneLater = (r) => submitted.some((s) => Date.parse(s.at) > Date.parse(r.at) && (r.url && s.url ? postingKey(s.url) === postingKey(r.url) : s.company === r.company && (s.role || '') === (r.role || '')));
  const qs = count(rows.flatMap((r) => r.questions || []).map((q) => q.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()));
  // Stops only: the submit rows used to be counted too, so a clean run read as 1.0 stops per submit.
  const stops = rows.filter(isStop).length;
  return {
    days: days || 30,
    runs: finals.length,
    submitted: submitted.length,
    stops,
    stopsPerSubmit: submitted.length ? +(stops / submitted.length).toFixed(1) : null,
    avgMinutesToSubmit: submitted.length ? Math.round(submitted.reduce((a, r) => a + r.minutes, 0) / submitted.length) : null,
    stuckNow: finals.filter((r) => ['needs_input', 'blocked', 'needs_review'].includes(r.status) && !doneLater(r)).map((r) => `${r.company || r.host}: ${r.message}`),
    byAts: count(rows.map((r) => `${r.ats} ${r.status}`)).slice(0, 12),
    topReasons: count(rows.filter((r) => r.status !== 'submitted').map((r) => `${r.ats}: ${String(r.message).replace(/\d+/g, 'N').slice(0, 90)}`)).slice(0, 10),
    needTypes: count(rows.flatMap((r) => r.needTypes || [])).slice(0, 10),
    repeatedQuestions: qs.filter(([, n]) => n > 1).slice(0, 15),
  };
}

module.exports = { load, report, isStop, NOT_STOP };
