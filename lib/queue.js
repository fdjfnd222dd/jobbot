'use strict';
/*
 * The job queue (data/queue.json: postings to apply to next) and the tracker bookkeeping after an application
 * (data/logged.json: which submitted runs already have their tracker row written). Both are plain files under
 * data/, so they survive /clear and a new session.
 *
 * settle() is called where bin/jobctl prints a finished run: a queued posting whose run ended submitted, closed,
 * already_applied or dropped is marked done. lib/apply.js is not involved.
 */
const fs = require('node:fs');
const path = require('node:path');
const P = require('./paths');
const U = require('./urls');
const D = require('./data');
const R = require('./runs');

const DONE_RESULTS = ['submitted', 'closed', 'already_applied', 'dropped'];

const read = () => D.readJson(P.QUEUE, { items: [] });
const write = (q) => D.writeJson(P.QUEUE, q);
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

/** Every queue item, in the order they were added. */
function list() {
  return read().items || [];
}

/**
 * Queue a posting. Dedupes by posting key (lib/urls.js postingKey): the same posting twice is refused with the
 * existing item, pending or done. Returns { added, item } or { added: false, existing, message }.
 */
function add(url, opts) {
  const o = opts || {};
  const clean = U.unwrap(String(url || '').trim());
  if (!/^https?:\/\//i.test(clean)) throw new Error(`not a link: "${url}"`);
  const key = U.postingKey(clean);
  const q = read();
  const items = q.items || [];
  const dup = items.find((i) => i.key === key);
  if (dup) return { added: false, existing: dup, message: `already in the queue as #${dup.n} (${dup.status}); \`jobctl queue rm ${dup.n}\` to re-add` };
  const n = items.reduce((m, i) => Math.max(m, i.n || 0), 0) + 1;
  const item = compact({
    n,
    url: clean,
    key,
    company: o.company,
    role: o.role,
    resume: o.resume,
    note: o.note,
    status: 'pending',
    added: new Date().toISOString(),
  });
  items.push(item);
  write({ items });
  return { added: true, item };
}

/** Remove one item by its number (#n from `jobctl queue`) or by its link. Throws when nothing matches. */
function rm(ref) {
  const s = String(ref || '').trim();
  const items = list();
  const numeric = /^\d+$/.test(s);
  const idx = numeric ? items.findIndex((i) => i.n === Number(s)) : items.findIndex((i) => i.key === U.postingKey(s));
  if (idx < 0) throw new Error(`no queue item "${s}" (jobctl queue lists them)`);
  const [gone] = items.splice(idx, 1);
  write({ items });
  return gone;
}

/** The first pending item (the one to apply to next), or null. */
function next() {
  return list().find((i) => i.status === 'pending') || null;
}

function counts() {
  const items = list();
  return { pending: items.filter((i) => i.status === 'pending').length, done: items.filter((i) => i.status === 'done').length };
}

/**
 * A run ended for good: its queued posting (if any) is done. `r` is a run or a run report with status, url and
 * postingUrl (or run / id). Returns the numbers of the items marked done.
 */
function settle(r) {
  if (!r || !DONE_RESULTS.includes(r.status)) return [];
  const keys = [r.postingUrl, r.url].filter(Boolean).map((u) => U.postingKey(u));
  if (!keys.length) return [];
  const q = read();
  const hit = [];
  for (const i of q.items || []) {
    if (i.status === 'pending' && keys.includes(i.key)) {
      Object.assign(i, compact({ status: 'done', result: r.status, run: typeof r.run === 'string' ? r.run : r.id, doneAt: new Date().toISOString() }));
      hit.push(i.n);
    }
  }
  if (hit.length) write(q);
  return hit;
}

// ---- tracker bookkeeping ------------------------------------------------------------------------------------

/**
 * data/logged.json: run id -> when its tracker row was written ('baseline' for runs that predate this file). The first
 * call writes the baseline: every submitted run that exists then is taken as written, because /apply wrote those rows
 * as it went (44 of the 46 companies are in data/tracker-companies.txt). Runs submitted after that are tracked.
 */
function loggedMap() {
  if (fs.existsSync(P.LOGGED)) return D.readJson(P.LOGGED, {});
  // Only runs whose company is already in the tracker (data/tracker-companies.txt, refreshed by /apply) count as
  // written; anything else stays unlogged so its row is written (or found to exist) rather than silently lost.
  const known = trackerCompanies();
  const map = {};
  for (const r of R.all()) if (r.status === 'submitted' && known.has(norm(r.company))) map[r.id] = 'baseline';
  D.writeJson(P.LOGGED, map);
  return map;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(inc|llc|corp|corporation|co|company|the)\b/g, '').trim();

function trackerCompanies() {
  try {
    return new Set(fs.readFileSync(path.join(P.DATA, 'tracker-companies.txt'), 'utf8').split('\n').map(norm).filter(Boolean));
  } catch (e) {
    return new Set();
  }
}

/** Submitted runs (not dry) whose tracker row has not been written yet, oldest first. */
function unlogged() {
  const logged = loggedMap();
  return R.all().filter((r) => r.status === 'submitted' && !r.dry && !logged[r.id]);
}

/**
 * Record that these runs' tracker rows were written. ids: run ids (partial ids work, as in `jobctl show`), or
 * ['all'] for every run `unlogged()` lists. Returns { marked, skipped } (skipped: ids not found or not submitted).
 */
function markLogged(ids) {
  const logged = loggedMap();
  const at = new Date().toISOString();
  const want = ids.includes('all') ? unlogged().map((r) => r.id) : ids;
  const marked = [];
  const skipped = [];
  for (const id of want) {
    let r = null;
    try {
      r = R.load(id);
    } catch (e) {
      /* no such run */
    }
    if (!r || r.status !== 'submitted') {
      skipped.push(id);
      continue;
    }
    logged[r.id] = at;
    marked.push(r.id);
  }
  if (marked.length) D.writeJson(P.LOGGED, logged);
  return { marked, skipped };
}

module.exports = { list, add, rm, next, counts, settle, unlogged, markLogged, DONE_RESULTS };
