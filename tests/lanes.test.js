'use strict';
// Tab-group lanes (owner, 2026-10-09): tabs waiting on the owner go to a red "NEEDS YOU" group, the rest green / grey.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('../lib/lanes');

test('laneFor: only stops the owner clears in the tab go red', () => {
  assert.strictEqual(L.laneFor({ status: 'blocked', needs: [{ type: 'workday_create_account' }] }), 'owner');
  assert.strictEqual(L.laneFor({ status: 'blocked', needs: [] }), 'owner', 'captcha / logged out');
  assert.strictEqual(L.laneFor({ status: 'needs_input', needs: [{ type: 'human_check' }, { kind: 'text' }] }), 'owner');
  assert.strictEqual(L.laneFor({ status: 'needs_input', needs: [{ type: 'email_verification' }] }), 'work', 'emailed codes are the bot\'s');
  assert.strictEqual(L.laneFor({ status: 'needs_input', needs: [{ kind: 'select', label: 'Current Year' }] }), 'work');
  assert.strictEqual(L.laneFor({ status: 'needs_review', needs: [] }), 'work');
  assert.strictEqual(L.laneFor({ status: 'ready_to_submit', needs: [] }), 'work');
  for (const s of ['submitted', 'already_applied', 'closed', 'dropped']) assert.strictEqual(L.laneFor({ status: s }), 'done', s);
});

test('laneFor: a hand-set lane holds until the status changes', () => {
  const run = { status: 'needs_input', needs: [], lane: 'owner', laneStatus: 'needs_input' };
  assert.strictEqual(L.laneFor(run), 'owner');
  run.status = 'submitted';
  assert.strictEqual(L.laneFor(run), 'done');
});

test('place never throws (no browser connected)', async () => {
  assert.strictEqual(await L.place({ tabId: null, status: 'blocked' }), null);
});

/** background.js in a vm with a fake browser that has tab groups. */
function background(withGroups = true) {
  const world = { tabs: new Map([[1, { id: 1, windowId: 9, groupId: -1 }], [2, { id: 2, windowId: 9, groupId: -1 }]]), groups: [], moves: [] };
  const em = () => ({ addListener() {}, removeListener() {} });
  const browser = {
    runtime: { connectNative: () => ({ onMessage: em(), onDisconnect: em(), postMessage() {} }) },
    browserAction: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    tabs: { onCreated: em(), onUpdated: em(), onRemoved: em(), get: async (id) => ({ ...world.tabs.get(id) }) },
    webNavigation: { onCommitted: em(), onDOMContentLoaded: em() },
  };
  if (withGroups) {
    browser.tabs.group = async ({ tabIds, groupId, createProperties }) => {
      let id = groupId;
      if (id == null) {
        id = 100 + world.groups.length;
        world.groups.push({ id, windowId: createProperties.windowId, title: '', color: 'blue' });
      }
      tabIds.forEach((t) => (world.tabs.get(t).groupId = id));
      return id;
    };
    browser.tabGroups = {
      query: async ({ windowId } = {}) => world.groups.filter((g) => windowId == null || g.windowId === windowId).map((g) => ({ ...g })),
      update: async (id, props) => Object.assign(world.groups.find((g) => g.id === id), props),
      move: async (id, { index }) => world.moves.push([id, index]),
    };
  }
  const ctx = vm.createContext({ browser, console, setTimeout, clearTimeout, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'agent', 'background.js'), 'utf8'), ctx);
  world.C = vm.runInContext('COMMANDS', ctx);
  return world;
}

test('lane command: makes the labelled, coloured group once and reuses it', async () => {
  const w = background();
  const a = await w.C.lane({ tabId: 1, lane: 'owner' });
  assert.strictEqual(a.mode, 'group');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(w.groups)), [{ id: 100, windowId: 9, title: 'NEEDS YOU', color: 'red', collapsed: false }]);
  assert.deepStrictEqual(w.moves, [[100, 0]], 'NEEDS YOU goes leftmost');
  await w.C.lane({ tabId: 2, lane: 'owner' });
  assert.strictEqual(w.groups.length, 1, 'second waiting tab joins the same group');
  assert.strictEqual(w.tabs.get(2).groupId, 100);
  await w.C.lane({ tabId: 1, lane: 'work' });
  assert.strictEqual(w.groups[1].title, 'JOBBOT WORKING');
  assert.strictEqual(w.groups[1].color, 'green');
  assert.strictEqual(w.tabs.get(1).groupId, 101);
  const again = await w.C.lane({ tabId: 1, lane: 'work' });
  assert.strictEqual(again.groupId, 101, 'already there: no regroup');
  await assert.rejects(w.C.lane({ tabId: 1, lane: 'purple' }), /unknown lane/);
});

test('lane command: a Firefox without tab groups is a no-op', async () => {
  const w = background(false);
  assert.strictEqual((await w.C.lane({ tabId: 1, lane: 'owner' })).mode, 'none');
});

test('background and lib agree on the lanes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'agent', 'background.js'), 'utf8');
  for (const [k, v] of Object.entries(L.LANES)) assert.ok(src.includes(`${k}: { title: '${v.title}', color: '${v.color}' }`), k);
});

test('handoffs: the owner dragged a red tab into WORKING or DONE', () => {
  const groups = [{ groupId: 1, title: 'NEEDS YOU' }, { groupId: 2, title: 'JOBBOT WORKING' }, { groupId: 3, title: 'DONE' }, { groupId: 4, title: 'my stuff' }];
  const tabs = [{ tabId: 10, groupId: 2 }, { tabId: 11, groupId: 1 }, { tabId: 12, groupId: 3 }, { tabId: 13, groupId: 4 }, { tabId: 14, groupId: -1 }, { tabId: 15, groupId: 2 }, { tabId: 16, groupId: 2 }];
  const blocked = (id, tabId, extra) => ({ id, tabId, status: 'blocked', needs: [{ type: 'workday_create_account' }], ...extra });
  const now = 1_000_000_000;
  const runs = [
    blocked('wex', 10), // red -> green: hand-back
    blocked('apl', 11), // still red
    blocked('umbermoor', 12), // red -> DONE
    blocked('own', 13), // a group of his own: not ours to read
    blocked('loose', 14), // ungrouped
    blocked('busy', 15, { drivingSince: now - 1000 }), // the bot itself is driving it
    blocked('seen', 16, { handoffAt: 'x' }), // reported already
    { id: 'answers', tabId: 10, status: 'needs_input', needs: [{ kind: 'text' }] }, // a bot stop in WORKING is no hand-back
  ];
  const got = L.handoffs(runs, tabs, groups, now).map((h) => `${h.run.id}:${h.to}`);
  assert.deepStrictEqual(got, ['wex:work', 'umbermoor:done']);
  // A crashed continue (drivingSince hours old) no longer hides the hand-back.
  assert.deepStrictEqual(L.handoffs([blocked('stale', 15, { drivingSince: now - L.DRIVING_STALE_MS - 1 })], tabs, groups, now).length, 1);
  // A stop Claude handed to the owner by hand (jobctl lane <run> owner) counts too.
  assert.deepStrictEqual(L.handoffs([{ id: 'q', tabId: 10, status: 'needs_input', needs: [], lane: 'owner', laneStatus: 'needs_input' }], tabs, groups, now).length, 1);
});

test('groups command lists tab groups; tabInfo carries groupId', async () => {
  const w = background();
  await w.C.lane({ tabId: 1, lane: 'owner' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await w.C.groups())), [{ groupId: 100, windowId: 9, title: 'NEEDS YOU', color: 'red' }]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await background(false).C.groups())), []);
});
