'use strict';
// Fernhaven 2026-10-09: a ref read on one tab must never be pressed on another (lib/focus.js).
const test = require('node:test');
const assert = require('node:assert');
const F = require('../lib/focus');

const tabs = [{ tabId: 5, active: false }, { tabId: 9, active: true }, { tabId: 13, active: false }];

test('pickTarget: --tab > --run > the tab opened / driven last > the last run tab > active', () => {
  assert.deepStrictEqual(F.pickTarget({ flagTab: '13', runTab: 5, focused: { tabId: 9 }, tabs }), { tabId: 13, fallback: false });
  assert.deepStrictEqual(F.pickTarget({ flagRun: 'x', runTab: 5, focused: { tabId: 13 }, tabs }), { tabId: 5, fallback: false });
  // `jobctl open <handshake>` after a run: the next snap / text means the opened tab, not the run's (tab-10 bug).
  assert.deepStrictEqual(F.pickTarget({ runTab: 5, focused: { tabId: 13 }, tabs }), { tabId: 13, fallback: false });
  assert.deepStrictEqual(F.pickTarget({ runTab: 5, focused: { tabId: 99 }, tabs }), { tabId: 5, fallback: false }, 'a closed focus tab is ignored');
  assert.deepStrictEqual(F.pickTarget({ runTab: 77, focused: null, tabs }), { tabId: 9, fallback: true });
  assert.deepStrictEqual(F.pickTarget({ flagRun: 'x', runTab: 77, focused: { tabId: 13 }, tabs }), { tabId: 9, fallback: true }, 'a named run with a closed tab never borrows the focus tab');
});

test('refMismatch: a ref from tab 13 is refused on tab 5', () => {
  assert.strictEqual(F.refMismatch(5, { tabId: 5 }), null);
  assert.strictEqual(F.refMismatch(5, null), null, 'nothing recorded yet: allowed');
  assert.match(F.refMismatch(5, { tabId: 13, url: 'https://app.joinhandshake.com/jobs/1' }), /tab 13 .*joinhandshake.*tab 5.*jobctl snap/);
});

test('labelOf: a hand fix names its field from the newest snapshot (the "(no field label)" hiccup cluster)', () => {
  const snap = { tabId: 5, labels: { '0:12': 'Desired Salary/Hourly Rate', '109521666049:17': 'Are you willing to receive SMS Messages?' } };
  assert.strictEqual(F.labelOf('0:12', snap), 'Desired Salary/Hourly Rate');
  assert.strictEqual(F.labelOf('12', snap), 'Desired Salary/Hourly Rate');
  assert.strictEqual(F.labelOf('109521666049:17', snap), 'Are you willing to receive SMS Messages?');
  assert.strictEqual(F.labelOf('0:99', snap), null);
  assert.strictEqual(F.labelOf('0:12', null), null);
});
