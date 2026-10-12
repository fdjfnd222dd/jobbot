'use strict';
/* lib/runtext.js (text output of apply / continue / answer-batch / status) and the stale-ref helpers. Pure, offline. */
const test = require('node:test');
const assert = require('node:assert');
const B = require('../lib/brief');
const RT = require('../lib/runtext');
const C = require('../lib/client');

const options = (n) => Array.from({ length: n }, (_, i) => `Option ${i}`);

test('a stopped run is one head line, who, message, then one line per need with its exact options', () => {
  const rep = {
    run: '20261009-120000-acme',
    status: 'needs_input',
    company: 'Acme',
    role: 'Intern',
    url: 'https://jobs.example/1',
    message: '3 item(s): Country; Work auth; How did you hear',
    shot: '/data/runs/x/stop.jpg',
    needs: [
      { ref: '0:12', label: 'Country *', kind: 'select', required: true, value: '', options: options(20), tried: 'Canada', error: 'no option matches' },
      { ref: '0:14', label: 'Work auth', kind: 'radio', options: ['Yes', 'No'], aiPolicy: true },
      { ref: '0:20', label: 'How did you hear?', kind: 'multiselect', options: ['Job Board - Linkedin', 'Social Media - LinkedIn', 'TCP/IP'] },
      { type: 'email_verification', site: 'acme.wd5', email: 'n@example.com', note: 'Gmail from:myworkday.com newer_than:1h' },
    ],
  };
  const t = RT.reportText(B.briefReport(rep));
  const lines = t.split('\n');
  assert.strictEqual(lines[0], 'run 20261009-120000-acme | needs_input | 10 needs input: answer the needs, then continue');
  assert.strictEqual(lines[1], 'Acme - Intern | https://jobs.example/1');
  assert.match(t, /\n {2}0:12 select\* "Country \*" \| tried "Canada" \| error: no option matches \| options \(20, first 12; all: jobctl options 0:12\): \["Option 0",/);
  assert.match(t, /\n {2}0:14 radio "Work auth" \| \[aiPolicy\] \| options: \["Yes","No"\]\n/);
  assert.match(t, /options: \["Job Board - Linkedin","Social Media - LinkedIn","TCP\/IP"\]/, 'options stay exact (JSON), separators inside them are safe');
  assert.match(t, /\n {2}- email_verification \| site: acme\.wd5 \| email: n@example\.com \| note: Gmail/);
  assert.ok(lines.length <= 9, 'one line per need');
  assert.match(t, /\nshot: \/data\/runs\/x\/stop\.jpg$/);
});

test('a submitted run prints its tracker row as one JSON line (ArtifactData takes it as is)', () => {
  const row = { docId: 'acme-4001', data: { company: 'Acme', role: 'Intern', location: 'Boston, MA' } };
  const t = RT.reportText(B.briefReport({ run: 'r9', status: 'submitted', company: 'Acme', message: 'ok', row }));
  assert.match(t, /^run r9 \| submitted \| 0 done: submitted/);
  assert.ok(t.split('\n').includes(`row: ${JSON.stringify(row)}`));
});

test('--continue: answers then the run; a refused continue lists the failed refs with their options', () => {
  const ok = RT.reportText(B.briefReport({ answered: { ok: true, answered: 2, failed: [], warnings: [] }, run: { run: 'r2', status: 'submitted' } }));
  assert.match(ok, /^answered 2\nrun r2 \| submitted/);
  const refused = RT.reportText(B.briefReport({ answered: { ok: false, answered: 1, failed: [{ ref: '0:7', error: 'no option matches', options: ['a', 'b'] }], warnings: [{ ref: '0:9', warning: 'names Acme' }] }, continued: false, reason: '1 answer(s) failed: 0:7' }));
  assert.match(refused, /^answered 1\n {2}failed 0:7: no option matches \| options: \["a","b"\]\n {2}warning 0:9: names Acme\nnot continued: 1 answer\(s\) failed: 0:7$/);
  assert.match(RT.answerText(B.briefAnswer({ ok: true, boxes: 6, filled: 6 })), /^answered ok \| code boxes 6\/6$/);
});

test('a batch is one line per link (plus the row of a submitted one)', () => {
  const t = RT.reportText(B.briefReport({ count: { submitted: 1, needs_input: 1 }, results: [{ url: 'https://a/1', status: 'submitted', run: 'r1', company: 'Acme', role: 'Intern', row: { docId: 'acme-1', data: {} } }, { url: 'https://b/2', status: 'needs_input', run: 'r2', company: 'Beta', needs: 3 }] }));
  assert.strictEqual(t, 'batch: 1 submitted, 1 needs_input\n  submitted | r1 | Acme - Intern | https://a/1\n    row: {"docId":"acme-1","data":{}}\n  needs_input | r2 | Beta | https://b/2 | 3 needs (jobctl continue r2)');
});

test('status lists every need (not just the first 4), "+N more" past the cap, and counts low-confidence fills', () => {
  const needs = Array.from({ length: 12 }, (_, i) => ({ ref: `0:${i}`, label: `Question ${i}`, required: i === 0 }));
  needs.push({ type: 'review', label: 'GPA', value: '3.7' });
  const lines = RT.statusNeedLines(needs, 'r1');
  assert.strictEqual(lines.length, 13);
  assert.strictEqual(lines[0], '- Question 0  [0:0] *');
  assert.strictEqual(lines[11], '- Question 11  [0:11]');
  assert.strictEqual(lines[12], '(+1 low-confidence fill to check: jobctl show r1)');
  const capped = RT.statusNeedLines(Array.from({ length: 20 }, (_, i) => ({ label: `Q${i}` })), 'r2', 15);
  assert.strictEqual(capped[15], '+5 more (jobctl show r2)');
});

test('stale refs: a stack-only page error becomes a clear message; the field is found again by its label', () => {
  assert.strictEqual(C.pageError('byRef@moz-extension://0a1b/agent/page.js:137:11\nset@moz-extension://0a1b/agent/page.js:880:14', '57'), 'stale ref 57: the page re-rendered since the last snapshot; run `jobctl snap --brief` and use the new ref');
  assert.match(C.pageError('ref 57 not found on this page (it changed?): take a new snapshot [at byRef@agent/page.js:137:11]'), /^stale ref:/);
  assert.strictEqual(C.pageError('pickOption@moz-extension://0a1b/agent/page.js:1500:3'), 'page error in pickOption (page.js:1500), no message');
  assert.strictEqual(C.pageError('no option matches "Canada" [at set@agent/page.js:900:2]'), 'no option matches "Canada"');
  assert.ok(C.STALE.test(C.pageError('byRef@moz-extension://x/agent/page.js:1:1')));
  const fields = [{ ref: '0:88', label: 'ZIP Code *', kind: 'text' }, { ref: '0:90', label: 'City', kind: 'text' }, { ref: '0:91', label: 'State', kind: 'select' }, { ref: '0:95', label: 'State', kind: 'text' }];
  assert.strictEqual(C.relabel(fields, { ref: '0:76', label: 'ZIP Code', kind: 'text' }).ref, '0:88');
  assert.strictEqual(C.relabel(fields, { label: 'State', kind: 'select' }).ref, '0:91', 'same kind breaks a label tie');
  assert.strictEqual(C.relabel(fields, { label: 'State' }), null, 'two fields with that label: never guess');
  assert.strictEqual(C.relabel(fields, { label: 'County' }), null);
});
