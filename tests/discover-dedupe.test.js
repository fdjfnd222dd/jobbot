'use strict';
// Offline regression tests for discover (session 2026-10-09T20-57-43): runs count as applied,
// one posting listed twice, and Recruitee pay.
const test = require('node:test');
const assert = require('node:assert');
const { dedupeKey, dedupeHits, markRunSkips } = require('../lib/discover');
const { posting, locate } = require('../lib/posting');

test('same posting on amazon.jobs and www.amazon.jobs dedupes', () => {
  const hits = [{ url: 'https://amazon.jobs/en/jobs/3012345/leo-intern' }, { url: 'https://www.amazon.jobs/en/jobs/3012345/leo-intern' }];
  assert.strictEqual(dedupeHits(hits).length, 1);
});

test('Workday req on two sites of one tenant (R56702 / R56702-2) dedupes', () => {
  const a = 'https://cadence.wd1.myworkdayjobs.com/External_Careers/job/San-Jose/Intern_R56702';
  const b = 'https://cadence.wd1.myworkdayjobs.com/Cadence_Careers/job/San-Jose/Intern_R56702-2';
  assert.strictEqual(dedupeKey(a), dedupeKey(b));
  assert.notStrictEqual(dedupeKey(a), dedupeKey(a.replace('R56702', 'R56703')));
});

test('iCIMS ?mobile=true and /job slug dedupe', () => {
  const a = 'https://careers-yarrowmere.icims.com/jobs/8657/intern/job?mobile=true&needsRedirect=false';
  const b = 'https://careers-yarrowmere.icims.com/jobs/8657/intern/job';
  assert.strictEqual(dedupeHits([{ url: a }, { url: b }]).length, 1);
});

test('hits with an existing run are skipped (submitted and in progress); dry/dropped runs are not', () => {
  const runs = [
    { id: 'r1', status: 'submitted', url: 'https://driftgate.wd5.myworkdayjobs.com/VU/job/Columbia/Intern_R6249', company: 'Driftgate', role: 'Intern' },
    { id: 'r2', status: 'needs_input', url: 'https://gm.wd5.myworkdayjobs.com/Careers_QUARRYHALL/job/Warren/x_JR-202622064', company: 'QUARRYHALL', role: 'Software Intern' },
    { id: 'r3', status: 'dropped', url: 'https://boards.greenhouse.io/a/jobs/1', company: 'A', role: 'Dev' },
    { id: 'r4', status: 'needs_input', dry: true, url: 'https://boards.greenhouse.io/b/jobs/2', company: 'B', role: 'Dev' },
  ];
  const hits = [
    { url: 'https://driftgate.wd5.myworkdayjobs.com/en-US/VU/job/Columbia/Intern_R6249', company: 'Driftgate', title: 'Intern' },
    { url: 'https://gm.wd5.myworkdayjobs.com/Careers_QUARRYHALL/job/Warren/x_JR-202622064', company: 'QUARRYHALL', title: 'Other' },
    { url: 'https://boards.greenhouse.io/a/jobs/1', company: 'A', title: 'Dev' },
    { url: 'https://boards.greenhouse.io/b/jobs/2', company: 'B', title: 'Dev' },
    { url: 'https://example.com/9', company: 'Driftgate', title: 'intern' },
  ];
  markRunSkips(hits, runs);
  assert.match(hits[0].skip, /already applied \(run r1\)/);
  assert.match(hits[1].skip, /in progress \(run r2/);
  assert.strictEqual(hits[2].skip, undefined);
  assert.strictEqual(hits[3].skip, undefined);
  assert.match(hits[4].skip, /already applied/); // company + role match
});

test('Recruitee: locate and pay from the offers API (text and structured)', async () => {
  assert.deepStrictEqual(locate('https://wilcoxflegel.recruitee.com/o/it-intern'), { ats: 'recruitee', board: 'wilcoxflegel', id: 'it-intern' });
  const real = global.fetch;
  try {
    for (const offer of [
      { title: 'IT Intern', description: '<p>Pay: $17.3 - $26 per hour</p>', location: 'Oklahoma City' },
      { title: 'IT Intern', description: '<p>Help desk</p>', salary: { min: 17.3, max: 26, period: 'hour' }, location: 'Oklahoma City' },
    ]) {
      global.fetch = async () => ({ ok: true, json: async () => ({ offer }) });
      const p = await posting('https://wilcoxflegel.recruitee.com/o/it-intern');
      assert.ok(p.payPerHour && p.payPerHour.high < 35, JSON.stringify(p.payPerHour));
      assert.strictEqual(p.payPerHour.high, 26);
    }
  } finally {
    global.fetch = real;
  }
});
