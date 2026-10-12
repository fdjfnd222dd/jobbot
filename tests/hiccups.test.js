'use strict';
/* lib/hiccups.js: session hiccup log, clusters, resolve, report (temp data dir, no browser). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-hiccups-'));
process.env.JOBBOT_DATA = DIR;
const H = require('../lib/hiccups');

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('normalize: refs, numbers, quoted values and URLs do not split a cluster', () => {
  assert.strictEqual(H.normalize('click 0:45 on "No" at https://x.y/job/3330'), H.normalize('click 0:51 on "Yes" at https://x.y/job/42182'));
});

test('session: hand fixes cluster by ATS + command + field; driver stops come in from friction.jsonl', () => {
  H.start(new Date(Date.now() - 1000));
  const run = { id: 'r1', company: 'Quarrymere', ats: 'oracle', status: 'needs_input', needs: [{ ref: '0:74', label: 'Address Line 1 *' }] };
  H.manual('answer', run, { ref: '0:74' });
  H.manual('answer', { ...run, id: 'r2', company: 'Junipermere', needs: [{ ref: '0:70', label: 'Address Line 1 *' }] }, { ref: '0:70' });
  H.log({ kind: 'search', detail: 'LinkedIn said 20 hours ago, posting was 23 days old', fix: 'show real age in jobctl find' });
  fs.appendFileSync(path.join(DIR, 'friction.jsonl'), JSON.stringify({ at: new Date().toISOString(), run: 'r3', ats: 'oracle', company: 'Amberwick', status: 'blocked', message: 'captcha', needTypes: [] }) + '\n');
  fs.appendFileSync(path.join(DIR, 'friction.jsonl'), JSON.stringify({ at: new Date().toISOString(), run: 'r4', ats: 'greenhouse', company: 'Cedarwick', status: 'submitted', message: 'ok' }) + '\n');
  const rep = H.report();
  const addr = rep.clusters.find((c) => c.cmd === 'answer');
  assert.strictEqual(addr.count, 2);
  assert.deepStrictEqual(addr.companies, ['Quarrymere', 'Junipermere']);
  assert.ok(rep.clusters.some((c) => c.cmd === 'stop:blocked' && c.companies.includes('Amberwick')), 'driver stop included');
  assert.ok(!rep.clusters.some((c) => c.companies.includes('Cedarwick')), 'a submit is not a hiccup');
  assert.strictEqual(rep.submitted, 1);
  assert.ok(rep.clusters.find((c) => c.kind === 'search').fixIdeas[0].includes('real age'));
});

test('resolve closes a cluster; it opens again if the hiccup comes back after the fix', async () => {
  const key = H.clusters().find((c) => c.cmd === 'answer').key;
  H.resolve(key, 'Oracle address suggestion picked automatically');
  assert.ok(H.clusters().find((c) => c.key === key).resolved);
  await new Promise((r) => setTimeout(r, 5));
  H.manual('answer', { id: 'r5', company: 'Cedarmere', ats: 'oracle', needs: [{ ref: '0:9', label: 'Address Line 1 *' }] }, { ref: '0:9' });
  assert.ok(!H.clusters().find((c) => c.key === key).resolved, 'back after the fix: open again');
});

test('start lists clusters left open by earlier sessions; save writes markdown', () => {
  const res = H.start();
  assert.ok(res.open.length >= 1);
  const f = H.save(H.report({ days: 1 }));
  assert.match(fs.readFileSync(f, 'utf8'), /Address Line 1/);
});

test('hand fixes carry the label of the need with that ref; "0:12" never takes frame 3\'s label', () => {
  const run = { id: 'r-label', company: 'Acme', ats: 'greenhouse', status: 'needs_input', needs: [{ ref: '3:12', label: 'Other frame field' }, { ref: '0:12', label: 'Country *' }] };
  assert.strictEqual(H.needFor(run, '0:12').label, 'Country *');
  assert.strictEqual(H.needFor({ needs: [{ ref: '3:12', label: 'X' }] }, '0:12'), null, 'frame 0 is not frame 3');
  assert.strictEqual(H.needFor({ needs: [{ ref: '3:12', label: 'X' }] }, '12').label, 'X', 'a bare number matches any frame');
  H.manual('answer', run, { ref: '0:12' });
  H.manual('set', run, { ref: '9:99' });
  const rows = fs.readFileSync(path.join(DIR, 'hiccups.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const a = rows[rows.length - 2];
  const b = rows[rows.length - 1];
  assert.strictEqual(a.label, 'Country *');
  assert.strictEqual(a.ref, '0:12');
  assert.strictEqual(b.label, null);
  assert.strictEqual(b.ref, '9:99');
  assert.match(b.key, /\(no field label\)/, 'a fix with no label clusters under its own name');
});
