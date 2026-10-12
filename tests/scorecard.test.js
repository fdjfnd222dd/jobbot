'use strict';
/*
 * The measurement loop (temp data dir, no browser, no network): the session scorecard (lib/hiccups.js), stops per
 * submit (lib/friction.js) and the discover funnel (lib/discover.js; fetch is stubbed).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-scorecard-'));
process.env.JOBBOT_DATA = DIR;
const H = require('../lib/hiccups');
const F = require('../lib/friction');
const X = require('../lib/discover');

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const MIN = 60000;
const writeLines = (name, rows) => fs.writeFileSync(path.join(DIR, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

test('friction: stops per submit counts the stop records, not the submit rows', () => {
  const now = Date.now();
  const row = (run, status, m, extra) => ({ at: new Date(now - m * MIN).toISOString(), run, url: `https://jobs.example.org/${run}`, ats: 'greenhouse', company: run, status, message: status, minutes: 10, needTypes: [], ...extra });
  writeLines('friction.jsonl', [
    row('r1', 'needs_input', 50),
    row('r1', 'submitted', 40),
    row('r2', 'blocked', 45),
    row('r2', 'needs_input', 44),
    row('r2', 'submitted', 30),
    row('r3', 'submitted', 20),
    row('r4', 'already_applied', 15),
    row('r5', 'needs_input', 12, { dry: true }),
  ]);
  const rep = F.report(1);
  assert.strictEqual(rep.submitted, 3);
  assert.strictEqual(rep.stops, 3, 'two needs_input and one blocked; not the 3 submits, not the dry run');
  assert.strictEqual(rep.stopsPerSubmit, 1);
});

test('scorecard: one session of numbers (submits, minutes, stops, hand fixes, owner wait, top open cluster)', () => {
  const now = Date.now();
  H.start(new Date(now - 4 * 60 * MIN)); // the session began 4 h ago
  const row = (run, status, m, extra) => ({ at: new Date(now - m * MIN).toISOString(), run, url: `https://jobs.example.org/${run}`, ats: 'oracle', company: run, status, message: status, minutes: 20, needTypes: [], ...extra });
  writeLines('friction.jsonl', [
    row('ra', 'needs_input', 40, { minutes: 15 }),
    row('ra', 'submitted', 20, { minutes: 25 }),
    row('rb', 'submitted', 10, { minutes: 9 }),
    row('rc', 'blocked', 50),
    row('rd', 'blocked', 180), // 3 h ago, nobody touched it since: its owner wait is capped
  ]);
  // The owner's hand fix on ra, 35 min ago (its run answered 5 min after the stop).
  writeLines('hiccups.jsonl', [{ at: new Date(now - 35 * MIN).toISOString(), kind: 'manual', cmd: 'answer', run: 'ra', ats: 'oracle', key: 'manual|oracle|answer|address line 1', label: 'Address Line 1 *' }]);

  const sc = H.scorecard(new Date(now));
  assert.strictEqual(sc.session, H.session().id);
  assert.strictEqual(sc.submitted, 2);
  assert.strictEqual(sc.minutesPerSubmit, 17, 'median of 25 and 9');
  assert.strictEqual(sc.stops, 3, 'ra needs_input, rc and rd blocked');
  assert.strictEqual(sc.stopsPerSubmit, 1.5);
  assert.strictEqual(sc.handFixes, 1);
  assert.strictEqual(sc.handFixesPerSubmit, 0.5);
  assert.strictEqual(sc.ownerWaitMinutes, 5 + 50 + 60, 'ra 5 min (answered), rc 50 min (still waiting), rd capped at 60');
  assert.ok(sc.topOpenCluster && sc.topOpenCluster.count >= 1);
});

test('scorecard lines: one per session (a second save replaces it); scorecards(3) is the last three, oldest first', () => {
  H.saveScorecard({ session: 's1', submitted: 1 });
  H.saveScorecard({ session: 's2', submitted: 1 });
  H.saveScorecard({ session: 's2', submitted: 5 });
  H.saveScorecard({ session: 's3', submitted: 2 });
  H.saveScorecard({ session: 's4', submitted: 3 });
  const lines = fs.readFileSync(path.join(DIR, 'sessions', 'scorecard.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 4);
  assert.deepStrictEqual(H.scorecards(3).map((s) => s.session), ['s2', 's3', 's4']);
  assert.strictEqual(H.scorecards(3)[0].submitted, 5);
});

test('median ignores missing values', () => {
  assert.strictEqual(H.median([]), null);
  assert.strictEqual(H.median([3, 1, 2]), 2);
  assert.strictEqual(H.median([1, 2, 3, 4]), 2.5);
  assert.strictEqual(H.median([null, undefined, 5]), 5);
});

test('discover funnel: hits, skips by reason, and what is left to apply to', () => {
  const rec = X.funnelRecord(
    [{ skip: 'pay under $35/hr' }, { skip: 'requires Go, Rust' }, { skip: 'requires Java' }, {}, { skip: 'already applied at this company (skip a similar role)' }],
    '2026-10-09T00:00:00.000Z'
  );
  assert.deepStrictEqual(rec, {
    at: '2026-10-09T00:00:00.000Z',
    hits: 5,
    skipped: { 'pay under $35/hr': 1, 'requires a skill not claimed': 2, 'already applied at this company (skip a similar role)': 1 },
    applyable: 1,
  });
});

test('discover appends one funnel line per run (fetch stubbed: nothing leaves the machine)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const res = await X.discover({ simplify: false, noDetail: true });
    assert.strictEqual(res.count, 0);
    await X.discover({ simplify: false, noDetail: true });
  } finally {
    globalThis.fetch = realFetch;
  }
  const lines = fs.readFileSync(path.join(DIR, 'discover-funnel.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(lines[0].skipped, {});
  assert.strictEqual(lines[0].hits, 0);
  assert.strictEqual(lines[0].applyable, 0);
  assert.ok(lines[0].at);
});
