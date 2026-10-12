'use strict';
// One "run" = one application attempt, saved under data/runs/<id>/ (run.json + screenshots).
const fs = require('node:fs');
const path = require('node:path');
const { RUNS } = require('./paths');
const { writeJson, readJson } = require('./data');

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function create(url, opts) {
  let host = 'page';
  try {
    host = new URL(url).hostname.replace(/^www\./, '').split('.').slice(0, 2).join('-');
  } catch (e) {
    /* keep default */
  }
  const id = `${stamp(new Date())}-${host}`;
  const run = {
    id,
    url,
    status: 'new',
    tabId: null,
    company: (opts && opts.company) || null,
    role: (opts && opts.role) || null,
    resume: (opts && opts.resume) || null,
    cover: (opts && opts.cover) || null,
    transcript: (opts && opts.transcript) || null,
    noSubmit: !!(opts && (opts.noSubmit || opts.dry)),
    dry: !!(opts && opts.dry),
    steps: [],
    needs: [],
    uploads: {},
    authAttempts: 0,
    created: new Date().toISOString(),
    updated: null,
  };
  save(run);
  return run;
}

function dir(id) {
  return path.join(RUNS, id);
}

function save(run) {
  run.updated = new Date().toISOString();
  writeJson(path.join(dir(run.id), 'run.json'), run);
}

function list() {
  if (!fs.existsSync(RUNS)) return [];
  return fs
    .readdirSync(RUNS)
    .filter((d) => fs.existsSync(path.join(RUNS, d, 'run.json')))
    .sort();
}

/**
 * "last" = the run touched most recently (continue / answer save it), not the one started last: with three
 * Workday runs open, `jobctl answer` after `continue <umbermoor>` went to Elmbrook's tab (2026-10-09).
 */
function lastTouched(ids) {
  let best = ids[ids.length - 1];
  let bestAt = '';
  for (const x of ids.slice(-30)) {
    let at = '';
    try {
      at = readJson(path.join(dir(x), 'run.json')).updated || '';
    } catch (e) {
      /* unreadable run: skip */
    }
    if (at > bestAt) [best, bestAt] = [x, at];
  }
  return best;
}

function load(id) {
  const ids = list();
  const want = !id || id === 'last' ? lastTouched(ids) : ids.find((x) => x === id) || ids.filter((x) => x.includes(id)).pop();
  if (!want) throw new Error(id && id !== 'last' ? `no run matches "${id}"` : 'no runs yet');
  return readJson(path.join(dir(want), 'run.json'));
}

/** Every run that loads, oldest first (an unreadable run is skipped, never fatal). */
function all() {
  const out = [];
  for (const id of list()) {
    try {
      out.push(readJson(path.join(dir(id), 'run.json')));
    } catch (e) {
      /* unreadable run: skip */
    }
  }
  return out;
}

function saveShot(run, name, dataUrl) {
  if (!dataUrl) return null;
  const file = path.join(dir(run.id), `${name}.jpg`);
  fs.writeFileSync(file, Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
  return file;
}

const WAITING = ['needs_input', 'blocked', 'needs_review'];

/**
 * A run still waiting on someone: stopped (needs input / blocked / review), not a dry run, not dropped,
 * and not superseded by a later submission of the same posting (Glenfield: the first run stopped on
 * unknown_page, a second run submitted, the first kept its tab open forever).
 */
function isOpen(run, applied) {
  if (!WAITING.includes(run.status) || run.dry || run.abandoned) return false;
  const { postingKey } = require('./urls');
  const k = postingKey(run.url);
  return !(applied || require('./data').applied()).some((a) => a.run !== run.id && (postingKey(a.url) === k || (a.finalUrl && postingKey(a.finalUrl) === k)));
}

/** Give up on a run (stale posting, owner said skip): it stops counting as waiting anywhere. */
function drop(id, reason, force) {
  const run = load(id);
  if (!force && !WAITING.includes(run.status) && run.status !== 'new') throw new Error(`run ${run.id} is ${run.status}, not waiting: nothing to drop (--force to drop anyway)`);
  run.abandoned = true;
  run.status = 'dropped';
  run.message = reason || 'dropped';
  save(run);
  return run;
}

/** Tab ids of `runs` whose tab is still on the run's site (ids are reused after a browser restart). */
function tabsInUse(runs, tabs) {
  const host = (u) => {
    try {
      return new URL(u).hostname;
    } catch (e) {
      return '';
    }
  };
  const ids = [];
  for (const r of runs) {
    const t = tabs.find((x) => x.tabId === r.tabId);
    const site = host(r.lastUrl || r.url);
    // No recorded site: keep the tab (closing a live run's tab is worse than one extra tab).
    if (t && (!site || host(t.url) === site)) ids.push(t.tabId);
  }
  return ids;
}

/**
 * The tab a low-level command (snap / text / shot / options ...) acts on: the last run's tab while it is still open,
 * else the active tab, else the newest. 2026-10-09: after `jobctl tabs-clean` closed the last run's tab, `jobctl open`
 * + `jobctl text` kept aiming at the closed tab id. Returns { tabId, fallback } (tabId null when there is no tab).
 */
function pickTab(runTabId, tabs) {
  const list = tabs || [];
  if (runTabId != null && list.some((t) => t.tabId === runTabId)) return { tabId: runTabId, fallback: false };
  const t = list.find((x) => x.active) || list[list.length - 1];
  return { tabId: t ? t.tabId : null, fallback: runTabId != null };
}

module.exports = { create, save, load, list, all, dir, saveShot, isOpen, tabsInUse, pickTab, drop, WAITING };
