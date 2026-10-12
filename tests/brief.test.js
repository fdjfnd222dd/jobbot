'use strict';
/* lib/brief.js: compact output for run reports, --continue results, batches, snap, discover, the session brief. Pure. */
const test = require('node:test');
const assert = require('node:assert');
const B = require('../lib/brief');

const options = (n) => Array.from({ length: n }, (_, i) => `Option ${i}`);

test('a stopped run keeps what Claude acts on and drops the bulk', () => {
  const rep = {
    run: '20261009-120000-acme',
    status: 'needs_input',
    company: 'Acme',
    role: 'Intern',
    url: 'https://jobs.example/1',
    message: '2 item(s): Country; Phone',
    lastSteps: ['fill: 3 filled'],
    shots: '/data/runs/x',
    shot: '/data/runs/x/stop-needs_input.jpg',
    submittedFields: [{ label: 'Name', value: 'the owner' }],
    needs: [
      { ref: '0:12', label: 'Country *', kind: 'select', required: true, value: '', options: options(20), tried: 'Canada', error: 'no option matches', excerpt: 'x'.repeat(900), frame: 0, section: 'Contact' },
      { ref: '0:14', label: 'Work auth', kind: 'radio', options: ['Yes', 'No'], aiPolicy: true, consent: false, declined: false },
    ],
  };
  const b = B.briefReport(rep);
  assert.strictEqual(b.run, '20261009-120000-acme');
  assert.strictEqual(b.status, 'needs_input');
  assert.match(b.exit, /^10 needs input/);
  assert.strictEqual(b.shot, '/data/runs/x/stop-needs_input.jpg', 'only the last screenshot');
  for (const k of ['lastSteps', 'shots', 'submittedFields']) assert.ok(!(k in b), `${k} dropped`);
  const [a, c] = b.needs;
  assert.strictEqual(a.ref, '0:12');
  assert.strictEqual(a.required, true);
  assert.strictEqual(a.tried, 'Canada');
  assert.strictEqual(a.error, 'no option matches');
  assert.strictEqual(a.options.length, 12, 'at most 12 options');
  assert.strictEqual(a.optionCount, 20, 'optionCount when there are more');
  assert.ok(!('excerpt' in a) && !('frame' in a) && !('section' in a), 'long text and bookkeeping dropped');
  assert.ok(!('value' in a), 'an empty value is dropped');
  assert.deepStrictEqual(c.options, ['Yes', 'No']);
  assert.ok(!('optionCount' in c), 'no optionCount for a short list');
  assert.strictEqual(c.aiPolicy, true);
  assert.ok(!('consent' in c) && !('declined' in c), 'false flags are dropped');
});

test('long messages and values are cut, so the line stays short', () => {
  const b = B.briefReport({ run: 'r1', status: 'blocked', message: 'captcha '.repeat(200), needs: [{ ref: '0:1', label: 'L'.repeat(900), value: 'v'.repeat(900) }] });
  assert.ok(b.message.length <= 400 && b.message.endsWith('…'));
  assert.ok(b.needs[0].label.length <= 160);
  assert.ok(b.needs[0].value.length <= 200);
  assert.match(b.exit, /^11 blocked/);
});

test('a submitted run carries its tracker row, so no separate jobctl row call is needed', () => {
  const row = { docId: 'acme-4001', data: { company: 'Acme', role: 'Intern', location: 'Boston, MA', status: 'applied' } };
  const b = B.briefReport({ run: 'r9', status: 'submitted', company: 'Acme', message: 'ok', row, lastSteps: ['x'] });
  assert.deepStrictEqual(b.row, row);
  assert.match(b.exit, /^0 done/);
  assert.ok(!('lastSteps' in b));
});

test('--continue: the answers and the run report; a refused continue says why', () => {
  const ok = B.briefReport({ answered: { ok: true, answered: 2, failed: [], warnings: [], lastSteps: ['x'] }, run: { run: 'r2', status: 'submitted', row: { docId: 'd' } } });
  assert.deepStrictEqual(ok.answered, { ok: true, answered: 2 });
  assert.strictEqual(ok.run.status, 'submitted');
  assert.strictEqual(ok.run.row.docId, 'd');
  const refused = B.briefReport({ answered: { ok: false, answered: 1, failed: [{ ref: '0:7', ok: false, error: 'no option matches', options: ['a', 'b'], note: 'x' }], warnings: [] }, continued: false, reason: '1 answer(s) failed: 0:7' });
  assert.strictEqual(refused.continued, false);
  assert.strictEqual(refused.reason, '1 answer(s) failed: 0:7');
  assert.deepStrictEqual(refused.answered.failed, [{ ref: '0:7', error: 'no option matches', options: ['a', 'b'] }]);
});

test('a batch is one line per link, with the row on submitted ones', () => {
  const batch = {
    count: { submitted: 1, needs_input: 1 },
    results: [
      { url: 'https://a.example/1', status: 'submitted', run: 'r1', company: 'Acme', role: 'Intern', message: undefined, row: { docId: 'acme-1', data: {} } },
      { url: 'https://b.example/2', status: 'needs_input', run: 'r2', company: 'Beta', role: 'Intern', message: 'x'.repeat(500), needs: 3 },
    ],
  };
  const b = B.briefReport(batch);
  assert.strictEqual(b.count.submitted, 1);
  assert.strictEqual(b.results[0].row.docId, 'acme-1');
  assert.ok(!('message' in b.results[0]), 'no undefined keys');
  assert.strictEqual(b.results[1].needs, 3);
  assert.ok(b.results[1].message.length <= 300);
});

test('snap --brief: one line per field, the buttons on one line', () => {
  const text = B.snapText({
    tabId: 4,
    page: 'form',
    nav: { ref: '0:9', text: 'Next' },
    url: 'https://jobs.example/apply',
    title: 'Apply',
    fields: [
      { ref: '0:1', kind: 'text', label: 'First name', required: true, value: 'the owner' },
      { ref: '0:2', kind: 'select', label: 'Country', value: '', options: ['US', 'CA'] },
    ],
    buttons: [{ ref: '0:9', text: 'Next' }, { ref: '0:10', text: 'Back' }],
    signals: { errors: [] },
  });
  const lines = text.split('\n');
  assert.match(lines[0], /^page: form {2}next: "Next" {2}tab 4$/);
  assert.ok(lines.includes('0:1  text *  "First name"  = the owner'));
  assert.ok(lines.includes('0:2  select  "Country"  = (empty)  [2 options]'));
  assert.ok(lines.some((l) => l === 'buttons: 0:9 "Next" | 0:10 "Back"'));
  assert.strictEqual(lines.length, 6, 'page, title, url, two fields, buttons');
});

test('discover --brief: one line per hit with age, pay and skip or flags', () => {
  const text = B.discoverText({
    count: 2,
    searched: 40,
    unreachable: 1,
    simplify: {},
    postings: [
      { company: 'Acme', title: 'SWE Intern', location: 'Boston, MA', ageDays: 2, payPerHour: '38-45', flags: { requiresUnclaimed: ['Go'] }, url: 'https://boards.greenhouse.io/acme/jobs/1' },
      { company: 'Beta', title: 'Intern', location: 'Remote', ageDays: null, payPerHour: null, skip: 'pay under $35/hr', needsAccount: true },
    ],
  });
  const lines = text.split('\n');
  assert.match(lines[0], /^2 hits \(searched 40 boards, 1 unreachable\)$/);
  // The url ends the line: /find queues picks by it.
  assert.strictEqual(lines[1], '1. Acme | SWE Intern | Boston, MA | 2d | $38-45/hr | requiresUnclaimed: Go | https://boards.greenhouse.io/acme/jobs/1');
  assert.strictEqual(lines[2], '2. Beta | Intern | Remote | age ? | pay ? | SKIP pay under $35/hr [needs account] | ?');
  assert.strictEqual(lines.length, 3);
});

test('the session brief is at most 12 lines: queue, tracker, scorecard trend, top hiccups', () => {
  const sc = (n) => ({ session: `s${n}`, submitted: n, minutesPerSubmit: 10 + n, stopsPerSubmit: 0.5, handFixesPerSubmit: 0.2, ownerWaitMinutes: 7, topOpenCluster: { key: 'k', count: 3, what: 'Address Line 1' } });
  const open = [1, 2, 3].map((i) => ({ count: i, ats: 'oracle', cmd: 'answer', what: 'Address Line 1' }));
  const text = B.sessionBrief({ session: { id: 's9' }, queueOpen: 2, unlogged: 1, trend: [sc(1), sc(2), sc(3)], open });
  const lines = text.split('\n');
  assert.ok(lines.length <= 12, `${lines.length} lines`);
  assert.match(lines[0], /session s9 started/);
  assert.match(lines[1], /queue: 2 pending .* 1 submitted run\(s\) without a row/);
  assert.ok(lines.some((l) => /^ {2}s3: 3 submitted, 13 min\/submit/.test(l)));
  assert.ok(lines.some((l) => /x3 oracle answer: Address Line 1/.test(l)));
  const none = B.sessionBrief({ session: { id: 's1' }, queueOpen: 0, unlogged: 0, trend: [], open: [] });
  assert.match(none, /scorecard: none yet/);
  assert.match(none, /open hiccups: none/);
});

test('the Q&A bank is counted by topic, not listed', () => {
  const sum = B.answersSummary([
    { question: 'Are you authorized to work in the US?', sensitive: true },
    { question: 'What is your GPA?' },
    { question: 'Something unusual' },
  ]);
  assert.strictEqual(sum.total, 3);
  assert.strictEqual(sum.sensitive, 1);
  assert.deepStrictEqual(sum.topics.map(([t]) => t).sort(), ['other', 'school / GPA / degree', 'work authorization / sponsorship'].sort());
  assert.match(B.answersText(sum), /jobctl answers --all/);
});

test('log, queue and scorecard lines are one line each', () => {
  const log = B.logLine({ at: '2026-10-09T12:00:00.000Z', company: 'Acme', role: 'Intern', location: 'Boston, MA', run: 'r1' });
  assert.strictEqual(log, '2026-10-09  Acme - Intern  Boston, MA  [r1]');
  const pending = B.queueLine({ n: 4, status: 'pending', company: 'Acme', role: 'Intern', url: 'https://x.example/1' });
  assert.strictEqual(pending, '#4 pending  Acme - Intern  https://x.example/1');
  const done = B.queueLine({ n: 5, status: 'done', result: 'submitted', run: 'r7', company: 'Beta', role: 'SWE', url: 'https://y.example/2' });
  assert.match(done, /^#5 done {5}Beta - SWE {2}https:\/\/y\.example\/2 {2}\(submitted, run r7\)$/);
  assert.match(B.scorecardLine({ session: 's1', submitted: 0, minutesPerSubmit: null, stopsPerSubmit: null, handFixesPerSubmit: null, ownerWaitMinutes: 0, topOpenCluster: null }), /^s1: 0 submitted, -\/submit/);
});

test('exit meanings follow lib/followup.js exit codes', () => {
  assert.match(B.exitLine('ready_to_submit'), /^12 /);
  assert.match(B.exitLine('closed'), /^0 /);
  assert.match(B.exitLine('weird'), /^1 unknown status/);
});
