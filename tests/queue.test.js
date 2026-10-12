'use strict';
/* lib/queue.js: the queue (add with dedupe, rm, next), settle on finished runs, tracker bookkeeping (temp data dir). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-queue-'));
process.env.JOBBOT_DATA = DIR;
const Q = require('../lib/queue');
const R = require('../lib/runs');

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('add queues a posting once: the same posting in another link form is refused', () => {
  const a = Q.add('https://boards.greenhouse.io/acme/jobs/4001?utm_source=x', { company: 'Acme', role: 'SWE Intern', note: 'referral' });
  assert.strictEqual(a.added, true);
  assert.strictEqual(a.item.n, 1);
  assert.strictEqual(a.item.status, 'pending');
  assert.strictEqual(a.item.company, 'Acme');
  assert.strictEqual(a.item.note, 'referral');
  const b = Q.add('https://job-boards.greenhouse.io/embed/job_app?for=acme&token=4001');
  assert.strictEqual(b.added, false, 'the embed link of the same Greenhouse job is the same posting');
  assert.strictEqual(b.existing.n, 1);
  assert.match(b.message, /already in the queue as #1/);
  assert.throws(() => Q.add('not a link'), /not a link/);
  assert.ok(fs.existsSync(path.join(DIR, 'queue.json')));
});

test('rm by number or by link; next is the first pending item', () => {
  Q.add('https://jobs.lever.co/beta/11111111-1111-1111-1111-111111111111', { company: 'Beta' });
  Q.add('https://jobs.ashbyhq.com/gamma/22222222-2222-2222-2222-222222222222', { company: 'Gamma' });
  assert.strictEqual(Q.next().company, 'Acme');
  assert.strictEqual(Q.rm('1').company, 'Acme');
  assert.strictEqual(Q.next().company, 'Beta', 'the next pending item, after the removed one');
  assert.strictEqual(Q.rm('https://jobs.ashbyhq.com/gamma/22222222-2222-2222-2222-222222222222?src=x').company, 'Gamma');
  assert.throws(() => Q.rm('99'), /no queue item "99"/);
  assert.deepStrictEqual(Q.counts(), { pending: 1, done: 0 });
});

test('settle marks a queued posting done when its run ends submitted, closed, already applied or dropped', () => {
  const beta = Q.list().find((i) => i.company === 'Beta');
  // A stop is not an end: the item stays pending.
  assert.deepStrictEqual(Q.settle({ status: 'needs_input', url: beta.url }), []);
  assert.strictEqual(Q.next().company, 'Beta');
  // The run's own record (its url is the direct apply link, postingUrl the posting): still the same posting.
  const hit = Q.settle({ status: 'submitted', run: '20261009-100000-jobs-lever-co', url: 'https://jobs.lever.co/beta/11111111-1111-1111-1111-111111111111/apply', postingUrl: beta.url });
  assert.deepStrictEqual(hit, [beta.n]);
  const item = Q.list().find((i) => i.n === beta.n);
  assert.strictEqual(item.status, 'done');
  assert.strictEqual(item.result, 'submitted');
  assert.strictEqual(item.run, '20261009-100000-jobs-lever-co');
  assert.ok(item.doneAt);
  assert.strictEqual(Q.next(), null, 'nothing pending now');
  // Already applied (no run) settles by link too.
  Q.add('https://jobs.example.org/delta/9', { company: 'Delta' });
  assert.deepStrictEqual(Q.settle({ status: 'already_applied', url: 'https://jobs.example.org/delta/9' }).length, 1);
  assert.strictEqual(Q.list().find((i) => i.company === 'Delta').result, 'already_applied');
  // Dropped and closed settle too.
  Q.add('https://jobs.example.org/eps/1', { company: 'Eps' });
  assert.strictEqual(Q.settle({ status: 'dropped', url: 'https://jobs.example.org/eps/1' }).length, 1);
  Q.add('https://jobs.example.org/zeta/1', { company: 'Zeta' });
  assert.strictEqual(Q.settle({ status: 'closed', url: 'https://jobs.example.org/zeta/1' }).length, 1);
  assert.deepStrictEqual(Q.counts(), { pending: 0, done: 4 });
  // A re-add of a finished posting is refused, with the item it matches.
  assert.strictEqual(Q.add('https://jobs.example.org/zeta/1').added, false);
});

test('tracker bookkeeping: unlogged = submitted, not dry, not yet marked; markLogged takes ids, partial ids or all', () => {
  const save = (id, extra) => {
    const r = { id, url: `https://jobs.example.org/${id}`, status: 'submitted', created: new Date().toISOString(), steps: [], needs: [], ...extra };
    R.save(r);
    return r;
  };
  // The first call writes the baseline: earlier submitted runs whose company is already in the tracker count as written;
  // one whose company is not (review 2026-10-09: AmFam, Driftgate) stays unlogged so its row is not lost.
  fs.rmSync(path.join(DIR, 'logged.json'), { force: true }); // earlier tests may have started the bookkeeping
  fs.writeFileSync(path.join(DIR, 'tracker-companies.txt'), 'Old Co, Inc.\nOther\n');
  save('20261001-000000-old', { company: 'Old Co' });
  save('20261001-000000-new', { company: 'Not Yet Tracked' });
  assert.deepStrictEqual(Q.unlogged().map((r) => r.id), ['20261001-000000-new'], 'the baseline: only tracker companies are taken as written');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(DIR, 'logged.json'), 'utf8'))['20261001-000000-old'], 'baseline');
  assert.deepStrictEqual(Q.markLogged(['20261001-000000-new']), { marked: ['20261001-000000-new'], skipped: [] });

  save('20261001-000001-a', { company: 'A' });
  save('20261001-000002-b', { company: 'B', dry: true });
  save('20261001-000003-c', { company: 'C', status: 'needs_input' });
  save('20261001-000004-d', { company: 'D' });
  assert.deepStrictEqual(Q.unlogged().map((r) => r.id), ['20261001-000001-a', '20261001-000004-d']);

  // A partial id is enough (as in `jobctl show`).
  assert.deepStrictEqual(Q.markLogged(['20261001-000001']), { marked: ['20261001-000001-a'], skipped: [] });
  assert.deepStrictEqual(Q.unlogged().map((r) => r.id), ['20261001-000004-d']);

  // Not submitted, or not a run: skipped, nothing written for it.
  assert.deepStrictEqual(Q.markLogged(['20261001-000003-c', 'nope']), { marked: [], skipped: ['20261001-000003-c', 'nope'] });

  assert.deepStrictEqual(Q.markLogged(['all']), { marked: ['20261001-000004-d'], skipped: [] });
  assert.deepStrictEqual(Q.unlogged(), []);
  const logged = JSON.parse(fs.readFileSync(path.join(DIR, 'logged.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(logged).sort(), ['20261001-000000-new', '20261001-000000-old', '20261001-000001-a', '20261001-000004-d']);
  // Marking does not touch the run record (so `jobctl ... last` still means the run last worked on).
  const before = R.load('20261001-000001-a').updated;
  Q.markLogged(['20261001-000001-a']);
  assert.strictEqual(R.load('20261001-000001-a').updated, before);
});
