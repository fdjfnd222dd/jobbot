'use strict';
/**
 * Which tab the low-level commands (snap / text / shot / set / click / options / upload ...) act on, and where a
 * ref came from.
 *
 * 2026-10-09 (Fernhaven, Oracle): the application went out with "Asian" ticked under race although the owner's answer is
 * decline. The driver filled nothing on that page; the box was ticked between two runs while another process was
 * driving other tabs (`jobctl open <handshake url>` + snap / click). Low-level commands aimed at "the last run's tab"
 * whatever tab was opened or snapped last, so a ref read on one tab could be pressed on another. Two guards:
 * - focus: `jobctl open` and every apply / continue name the tab the next low-level command means (data/focus.json).
 * - provenance: every snapshot records its tab (data/last-snap.json); a write that names a ref (set / click /
 *   options / upload / answer) is refused when the newest snapshot was of another tab. Refs are numbered per
 *   snapshot and per tab: on another tab the same ref is another field.
 */
const fs = require('node:fs');
const path = require('node:path');
const P = require('./paths');

const FOCUS = path.join(P.DATA, 'focus.json');
const LAST_SNAP = path.join(P.DATA, 'last-snap.json');

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function write(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) {
    /* bookkeeping only: never fail a command over it */
  }
}

function setFocus(tabId, by) {
  if (tabId != null) write(FOCUS, { tabId, by: by || '', at: new Date().toISOString() });
}

function focus() {
  return read(FOCUS);
}

/** labels: { ref: label } of the snapshot's fields and buttons (hand-fix hiccups name the field, not "(no field label)"). */
function recordSnap(tabId, url, labels) {
  if (tabId != null) write(LAST_SNAP, { tabId, url: url || '', at: new Date().toISOString(), pid: process.pid, labels: labels || {} });
}

/** The label the newest snapshot gave a ref ("0:12" or "12"), or null. */
function labelOf(ref, snap) {
  const s = snap === undefined ? lastSnap() : snap;
  if (!s || !s.labels || ref == null) return null;
  const r = String(ref);
  return s.labels[r] || s.labels[r.includes(':') ? r : `0:${r}`] || null;
}

function lastSnap() {
  return read(LAST_SNAP);
}

/**
 * The tab a low-level command acts on. Pure: flags, the last run's tab, the focus record, open tabs.
 * --tab N > --run R (that run's tab) > focus (a tab opened or driven last, still open) > last run's tab > active.
 * Returns { tabId, fallback } like runs.pickTab (fallback: the wanted run tab is gone).
 */
function pickTarget({ flagTab, flagRun, runTab, focused, tabs }) {
  const list = tabs || [];
  const open = (id) => id != null && list.some((t) => t.tabId === id);
  if (flagTab != null) return { tabId: Number(flagTab), fallback: false };
  if (flagRun) return open(runTab) ? { tabId: runTab, fallback: false } : { tabId: activeOf(list), fallback: true };
  if (focused && open(focused.tabId)) return { tabId: focused.tabId, fallback: false };
  if (open(runTab)) return { tabId: runTab, fallback: false };
  return { tabId: activeOf(list), fallback: runTab != null };
}

function activeOf(list) {
  const t = list.find((x) => x.active) || list[list.length - 1];
  return t ? t.tabId : null;
}

/** Why a ref-based write on tabId must not go ahead, or null. snap: lastSnap(). */
function refMismatch(tabId, snap) {
  if (!snap || snap.tabId == null || snap.tabId === tabId) return null;
  return `refs come from the newest snapshot, of tab ${snap.tabId}${snap.url ? ` (${String(snap.url).slice(0, 80)})` : ''}, but this command acts on tab ${tabId}: the same ref there is another field. Run \`jobctl snap --brief\` (or pass --tab ${snap.tabId}) first`;
}

module.exports = { setFocus, focus, recordSnap, lastSnap, labelOf, pickTarget, refMismatch, FOCUS, LAST_SNAP };
