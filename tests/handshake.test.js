'use strict';
// Handshake as a jobbot source (2026-10-09): search + GraphQL parsing, apply routing, discover hook, modal plan.
// Offline: fixtures captured from exu.joinhandshake.com (tests/fixtures/handshake/), a fake fetcher instead of the
// logged-in browser tab. discover runs against an empty JOBBOT_DATA so the owner's tracker and runs stay out of it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.JOBBOT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-hs-'));
const H = require('../lib/handshake');
const HA = require('../lib/handshake-apply');
const R = require('../lib/runs');

const FIX = path.join(__dirname, 'fixtures', 'handshake');
const POSTINGS = JSON.parse(fs.readFileSync(path.join(FIX, 'postings.json'), 'utf8'));
const GQL = JSON.parse(fs.readFileSync(path.join(FIX, 'graphql-jobs.json'), 'utf8'));
const JOBS = new Map(Object.values(GQL.data).map((j) => [String(j.id), j]));
const NOW = Date.parse('2026-10-10T03:00:00Z');

/** A fake page fetcher: /stu/postings -> the fixture, GraphQL job(id) aliases -> fixture jobs, applications -> `applied`. */
function fakeFetcher(applied) {
  const calls = [];
  const f = async (p, init) => {
    calls.push(p);
    if (p.startsWith('/stu/postings')) return { status: 200, url: 'https://exu.joinhandshake.com' + p, json: POSTINGS };
    const q = JSON.parse(init.body).query;
    if (/applications/.test(q)) {
      const nodes = (applied || []).map((id) => ({ id: 'a' + id, createdAt: '2026-10-01T00:00:00Z', status: 'PENDING', applicable: { id } }));
      const one = q.match(/applicableId: "(\d+)"/);
      return { status: 200, json: { data: { currentUser: { applications: { nodes: one ? nodes.filter((n) => n.applicable.id === one[1]) : nodes } } } } };
    }
    const data = {};
    for (const m of q.matchAll(/(j\d+): job\(id: "(\d+)"\)/g)) data[m[1]] = JOBS.get(m[2]) || null;
    return { status: 200, json: { data } };
  };
  f.calls = calls;
  return f;
}

test('jobIdOf reads every Handshake job link shape', () => {
  assert.strictEqual(H.jobIdOf('https://exu.joinhandshake.com/jobs/11627964'), '11627964');
  assert.strictEqual(H.jobIdOf('https://app.joinhandshake.com/stu/jobs/11627964?ref=x'), '11627964');
  assert.strictEqual(H.jobIdOf('https://exu.joinhandshake.com/job-search/11627964?page=1'), '11627964');
  assert.strictEqual(H.jobIdOf('https://boards.greenhouse.io/x/jobs/1'), null);
  assert.ok(H.isHandshake('https://exu.joinhandshake.com/jobs/1'));
  assert.strictEqual(require('../lib/urls').atsOf('https://exu.joinhandshake.com/jobs/1'), 'handshake');
});

test('pay: cents per schedule, a mislabeled annual rate, stipends unknown', () => {
  assert.deepStrictEqual(H.payPerHour({ salary_min_raw: '4808', salary_max_raw: '4808', pay_schedule: { name: 'Hourly Wage' } }), { low: 48.08, high: 48.08, from: 'handshake' });
  assert.deepStrictEqual(H.payPerHour({ salary_min_raw: '4650000', salary_max_raw: '6950000', pay_schedule: { name: 'Annual Salary' } }), { low: 22.36, high: 33.41, from: 'handshake' });
  // Pinecrest 2026-10-09: "Annual Salary" 3277-5367 is $32.77-53.67 an hour, not $0.02.
  assert.deepStrictEqual(H.payPerHour({ salary_min_raw: '3277', salary_max_raw: '5367', pay_schedule: { name: 'Annual Salary' } }), { low: 32.77, high: 53.67, from: 'handshake' });
  assert.strictEqual(H.payPerHour({ salary_min_raw: '543900', salary_max_raw: '543900', pay_schedule: { name: 'Monthly Stipend' } }).low, 31.38);
  assert.strictEqual(H.payPerHour({ salary_min_raw: null, salary_max_raw: null }), null);
  assert.strictEqual(H.payPerHour({ salary_min_raw: '100000', pay_schedule: { name: 'Lump Sum' } }), null);
});

test('external links: tracking and Workday /apply stripped; careers home pages are not postings', () => {
  assert.strictEqual(
    H.cleanExternal('https://crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers/job/USA---Austin-TX/Sales-Intern_R30135/apply?source=Handshake'),
    'https://crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers/job/USA---Austin-TX/Sales-Intern_R30135'
  );
  assert.strictEqual(H.cleanExternal('https://careers.mitre.org/us/en/job/MITRUSR117737EXTERNALENUS/Cyber?utm_source=JB-10067&utm_medium=phenom-feeds'), 'https://careers.mitre.org/us/en/job/MITRUSR117737EXTERNALENUS/Cyber');
  assert.ok(H.isSpecific('https://careers.rockco.com/careers-home/jobs/5355'));
  assert.ok(!H.isSpecific('https://nystrs.wd12.myworkdayjobs.com/NYSTRS_Careers'));
  assert.ok(!H.isSpecific('https://www.auditor.nc.gov/auditor-les-merritt-internships'));
  // the Workday dedupe key matches a board hit for the same req once /apply is gone
  const D = require('../lib/discover');
  assert.strictEqual(D.dedupeKey(H.cleanExternal('https://crowdstrike.wd5.myworkdayjobs.com/en-US/crowdstrikecareers/job/X/Y_R30135/apply?source=Handshake')), D.dedupeKey('https://crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers/job/X/Y_R30135'));
});

test('apply routing from the GraphQL job: native, external, careers page', () => {
  const hit = (id) => ({ company: 'C', title: 'T', handshakeUrl: H.jobUrl(id) });
  const native = H.resolveApply(JOBS.get('11627964'), hit('11627964'));
  assert.strictEqual(native.applyVia, 'handshake');
  assert.strictEqual(native.applyUrl, 'https://exu.joinhandshake.com/jobs/11627964');
  const ext = H.resolveApply(JOBS.get('11625515'), hit('11625515'));
  assert.strictEqual(ext.applyVia, 'external');
  assert.match(ext.applyUrl, /^https:\/\/careers\.mitre\.org\/.*MITRUSR\d+/);
  assert.doesNotMatch(ext.applyUrl, /utm_/);
  const home = H.resolveApply(JOBS.get('11626223'), hit('11626223'));
  assert.strictEqual(home.applyVia, 'external-unresolved');
  assert.strictEqual(home.applyUrl, 'https://exu.joinhandshake.com/jobs/11626223');
  assert.match(home.find, /^jobctl find "C" "T"$/);
  assert.strictEqual(H.resolveApply({ jobApplySetting: { applyType: 'HANDSHAKE_AND_EXTERNAL', externalUrl: 'https://x.example/jobs/123' } }, hit('1')).applyVia, 'handshake');
  assert.strictEqual(H.resolveApply({ jobApplySetting: { applyType: 'EXTERNAL', externalApplyType: 'EMAIL' } }, hit('1')).applyVia, 'other');
});

test('search pages each query until postings are older than maxAge; a login redirect throws LoggedOut', async () => {
  const f = fakeFetcher();
  const r = await H.search(f, { query: ['security', 'software'], now: NOW, maxAge: 7 });
  assert.strictEqual(r.hits.length, POSTINGS.results.length, 'one hit per job across both queries');
  const h = r.hits.find((x) => x.jobId === '11628803');
  assert.strictEqual(h.source, 'handshake');
  assert.strictEqual(h.url, 'https://exu.joinhandshake.com/jobs/11628803');
  assert.match(h.location, /^[A-Za-z .]+, [A-Z]{2}/, 'locations are "City, ST" (not "Seattle, Washington": DC metro)');
  assert.match(decodeURIComponent(f.calls[0]), /job\.job_types\[\]=3/, 'internships only');
  const none = await H.search(f, { query: 'x', now: NOW + 30 * 86400000, maxAge: 7 });
  assert.strictEqual(none.hits.length, 0, 'everything older than a week is dropped');
  const out = async () => ({ status: 200, url: 'https://exu.joinhandshake.com/login', text: '<html>' });
  await assert.rejects(H.search(out, { query: 'x' }), (e) => e.code === 'HANDSHAKE_LOGGED_OUT' && /the owner must log in/.test(e.message));
});

test('hits: details, gate flags, short links followed, Handshake applications skipped', async () => {
  const f = fakeFetcher(['11628803']);
  const fetchImpl = async () => ({ headers: { get: () => null } });
  const r = await H.hits({ fetcher: f, query: 'x', now: NOW, keep: (h) => ['11628803', '11628254'].includes(h.jobId), fetchImpl });
  assert.strictEqual(r.kept, 2);
  const docu = r.hits.find((x) => x.jobId === '11628803');
  assert.strictEqual(docu.applyVia, 'handshake');
  assert.strictEqual(docu.ats, 'handshake');
  assert.deepStrictEqual(docu.documents, ['resume']);
  assert.strictEqual(docu.skip, 'already applied on Handshake');
  assert.ok(docu.flags && typeof docu.flags === 'object');
  // a short link (Kestrelvale: smrtr.io = SmartRecruiters) resolves to the real posting
  const cap = { applyVia: 'external-unresolved', externalUrl: 'https://smrtr.io/CgPLF', url: 'https://exu.joinhandshake.com/jobs/11627723', company: 'Kestrelvale', title: 'SWE Intern' };
  const loc = 'https://jobs.smartrecruiters.com/ni/KestrelvaleConsulting/0456e834-dd58-42e4-923a-f14f8eea5242-consulting-internship';
  await H.followShortLinks([cap], async () => ({ headers: { get: (k) => (k === 'location' ? loc : null) } }));
  assert.strictEqual(cap.applyVia, 'external');
  assert.strictEqual(cap.url, loc);
  assert.strictEqual(cap.ats, 'smartrecruiters');
});

test('discover: Handshake hits go through the same filters and dedupe against board hits', async () => {
  const X = require('../lib/discover');
  const res = await X.discover({ boards: false, simplify: false, noDetail: true, anywhere: true, query: 'x', maxAge: 30, handshakeFetcher: fakeFetcher() });
  assert.strictEqual(res.handshake.found, POSTINGS.results.length);
  const titles = res.postings.map((p) => p.title);
  assert.ok(titles.includes('Software Engineering Intern'), 'role match kept');
  assert.ok(!titles.some((t) => /product management|sales|program manager|highway/i.test(t)), 'off-role titles dropped: ' + titles.join(' | '));
  assert.ok(res.postings.every((p) => p.source === 'handshake'));
  const line = require('../lib/brief').discoverText(res);
  assert.match(line, /Handshake: \d+ found, \d+ kept/);
  assert.match(line, /\[HS native\]/);
  // logged out: discover still answers, with the reason
  const out = await X.discover({ boards: false, simplify: false, noDetail: true, handshakeFetcher: async () => ({ status: 302, url: 'https://exu.joinhandshake.com/login' }) });
  assert.ok(out.handshake.loggedOut);
  assert.strictEqual(out.count, 0);
});

test('modal plan: keep this run\'s file, remove a pre-picked one, upload, ask for a missing transcript, 1 MB cap', () => {
  const p = { documents: { resume: 'data/resumes/Default.pdf' } };
  const size = (f) => (/Big/.test(f) ? 2 * 1024 * 1024 : 50000);
  const run = { resume: 'data/resumes/Tailored.pdf' };
  const plan = HA.planDocs(
    [
      { heading: 'Attach your resume', attached: 'Old_Resume.pdf', removeRef: '28', uploadRef: null },
      { heading: 'Attach your transcript', attached: null, removeRef: null, uploadRef: '30' },
    ],
    run,
    p,
    size
  );
  assert.deepStrictEqual(plan.map((d) => [d.which, d.action]), [['resume', 'remove'], ['transcript', 'need']]);
  // a same-named pre-pick may be an older version: kept only once this run uploaded it
  assert.strictEqual(HA.planDocs([{ heading: 'Attach your resume', attached: 'Tailored.pdf', removeRef: '1' }], run, p, size)[0].action, 'remove');
  assert.strictEqual(HA.planDocs([{ heading: 'Attach your resume', attached: 'Tailored.pdf (1)', removeRef: '1' }], { ...run, hsUploaded: { resume: 'Tailored.pdf' } }, p, size)[0].action, 'keep');
  assert.strictEqual(HA.planDocs([{ heading: 'Attach your resume', attached: null, uploadRef: '3' }], {}, p, size)[0].file, 'data/resumes/Default.pdf');
  assert.strictEqual(HA.planDocs([{ heading: 'Attach your transcript', uploadRef: '3' }], {}, { documents: { transcript: 'data/T.pdf' } }, size)[0].action, 'upload');
  assert.strictEqual(HA.planDocs([{ heading: 'Attach your resume', uploadRef: '3' }], { resume: 'Big.pdf' }, p, size)[0].action, 'too_big');
  assert.strictEqual(HA.planDocs([{ heading: 'Attach your cover letter', uploadRef: '3' }], {}, p, size)[0].action, 'need');
});

test('tests never reach the live browser: discover leaves Handshake off unless asked, browserFetcher refuses', async () => {
  const X = require('../lib/discover');
  const res = await X.discover({ boards: false, simplify: false, noDetail: true });
  assert.strictEqual(res.handshake.enabled, false, 'library callers (scorecard.test) get no Handshake by default');
  assert.ok(process.env.NODE_TEST_CONTEXT, 'node --test marks child processes');
  await assert.rejects(H.browserFetcher(), /no live browser under test/);
});

test('low-level commands: a closed run tab falls back to the active tab (tabs-clean + open, 2026-10-09)', () => {
  const tabs = [{ tabId: 17, active: false }, { tabId: 21, active: true }];
  assert.deepStrictEqual(R.pickTab(17, tabs), { tabId: 17, fallback: false });
  assert.deepStrictEqual(R.pickTab(9, tabs), { tabId: 21, fallback: true });
  assert.deepStrictEqual(R.pickTab(null, tabs), { tabId: 21, fallback: false });
  assert.deepStrictEqual(R.pickTab(9, []), { tabId: null, fallback: true });
});

// Part-time mode (2026-10-12, spring-semester remote IT job): no internship facet, only Part-Time employment.
test('search --part-time: any job type, keeps only Part-Time postings', async () => {
  const pt = JSON.parse(JSON.stringify(POSTINGS));
  pt.results[0].job.employment_type_name = 'Part-Time';
  const calls = [];
  const f = async (p) => (calls.push(p), { status: 200, url: 'https://exu.joinhandshake.com' + p, json: pt });
  const r = await H.search(f, { query: 'IT', now: NOW, maxAge: 7, partTime: true });
  assert.deepStrictEqual(r.hits.map((h) => h.jobId), [String(pt.results[0].job_id)]);
  assert.doesNotMatch(decodeURIComponent(calls[0]), /job_types/, 'every job type, not internships only');
  assert.ok(H.PART_TIME_QUERIES.includes('help desk'));
});
