'use strict';
/**
 * Tab lanes (owner, 2026-10-09): in the jobbot Firefox, a tab that waits on the owner (captcha, Workday Create Account,
 * a logged-out site, a bot-check question) sits in a red "NEEDS YOU" tab group at the far left; tabs the bot is
 * still driving sit in a green "JOBBOT WORKING" group; a grey "DONE" group takes what he drags there (finished by
 * hand, or skip it; a submitted run's tab closes by itself). One glance shows what is waiting on him.
 *
 * Why tab groups and not the other two ideas:
 * - Firefox containers isolate cookies: a tab cannot change container without reopening its URL, which drops the
 *   half-filled form and the ATS sign-in (Workday / Handshake sessions live in the default container).
 * - A left "needs you" window and a right "working" window: this laptop runs KDE on Wayland, where Firefox cannot
 *   place its own windows (windows.update left/top is ignored), and a second window costs RAM on 8 GB.
 * - Tab groups (Firefox 138+, tabs.group + tabGroups) keep one window and one cookie jar, carry a colour and a
 *   label, and moving a tab between groups keeps the page exactly as it is.
 *
 * laneFor() is pure; place() is best effort and never throws (an old Firefox without tab groups just gets no colour).
 */

const LANES = {
  owner: { title: 'NEEDS YOU', color: 'red' },
  work: { title: 'JOBBOT WORKING', color: 'green' },
  done: { title: 'DONE', color: 'grey' },
};

// Stops only the owner can clear, in the tab itself. Emailed codes / verify links are Claude's (email_verification).
const OWNER_TYPES = new Set(['captcha', 'human_check', 'workday_create_account', 'password_reset', 'auth_failed', 'opt_in_required']);
const DONE = new Set(['submitted', 'already_applied', 'closed', 'dropped', 'skipped', 'duplicate']);

/** 'owner' | 'work' | 'done' for a run (status + needs). */
function laneFor(run) {
  const status = run && run.status;
  if (run && run.lane && run.laneStatus === status) return run.lane; // a hand-set lane holds until the run moves on
  if (DONE.has(status)) return 'done';
  if (status === 'blocked') return 'owner';
  if ((run.needs || []).some((n) => OWNER_TYPES.has(n.type))) return 'owner';
  return 'work';
}

/** Put the run's tab in its lane. `lane` overrides laneFor (jobctl lane). Returns the lane, or null. */
async function place(run, lane) {
  if (!run || run.tabId == null) return null;
  const want = lane || laneFor(run);
  try {
    await require('./client').send('lane', { tabId: run.tabId, lane: want });
    return want;
  } catch (e) {
    return null; // cosmetic: a closed tab or a Firefox without tab groups must never fail a run
  }
}

/** The lane a tab sits in, by its group's title; null when ungrouped or in a group of the owner's own. */
function laneOfTab(tab, groups) {
  if (!tab || tab.groupId == null || tab.groupId < 0) return null;
  const g = (groups || []).find((x) => x.groupId === tab.groupId);
  const hit = g && Object.entries(LANES).find(([, v]) => v.title === g.title);
  return hit ? hit[0] : null;
}

// A resume that crashed leaves drivingSince behind; after this long the run counts as stopped again.
const DRIVING_STALE_MS = 15 * 60 * 1000;

/**
 * Hand-backs (owner, 2026-10-09): the owner clears a red NEEDS YOU tab (captcha, Create Account ...) and drags it into
 * JOBBOT WORKING (or DONE). Polled, not evented, so a `jobctl reload` or browser restart loses nothing: a run whose
 * own lane is 'owner' but whose tab now sits in the WORKING / DONE group was handed back. Pure.
 * runs: open runs; tabs: tabInfo list (with groupId); groups: the groups command. Returns [{ run, to }].
 */
function handoffs(runs, tabs, groups, now = Date.now()) {
  const out = [];
  for (const run of runs || []) {
    if (run.handoffAt) continue; // already reported; a continue clears it
    if (run.drivingSince && now - run.drivingSince < DRIVING_STALE_MS) continue; // the bot moved it: it is driving
    if (laneFor(run) !== 'owner') continue;
    const tab = (tabs || []).find((t) => t.tabId === run.tabId);
    const to = laneOfTab(tab, groups);
    if (to === 'work' || to === 'done') out.push({ run, to });
  }
  return out;
}

module.exports = { LANES, OWNER_TYPES, laneFor, place, laneOfTab, handoffs, DRIVING_STALE_MS };
