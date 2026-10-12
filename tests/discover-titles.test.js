'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { titleFits } = require('../lib/discover');

// 2026-10-12 search experiment: raw board dump vs the title filter. These were real postings in his cities.
test('title filter keeps SDE / SDET / developer, data-ML-AI engineer, technology and controls interns', () => {
  for (const t of [
    'Summer 2027 Software Development and Testing Intern', // SAS, Cary
    'SDET Intern', // Yarrowwick, Cary
    'Enterprise Technology Engineer Intern', // Ravenvale, NYC
    '2027 Summer Internship - Machine Learning Engineer', // Q2, Cary
    'Machine Learning Engineer, Co-op',
    'Data Engineer Intern',
    'Controls Engineering Intern', // OT-adjacent
    'Software Engineering Intern - Enterprise Data & Systems (Salesforce & Snowflake)', // "sales" no longer kills Salesforce
    'Summer Analyst Program: Information Technology',
    'Global Technology Intern', // MetLife
    'Solutions Engineer Intern 2027',
    'Undergraduate/Graduate Software Intern',
    'Firewall Engineer Intern',
    'Identity and Access Management Intern',
    '2027 Summer IT Site Admin Intern', // Butterball, Garner
    'Manufacturing Systems IT Intern',
  ])
    assert.ok(titleFits(t), t);
});

test('title filter drops grad-only, policy, sales, fab / chip and physical-security titles', () => {
  for (const t of [
    'Intern, Business Development, Partner Network',
    'Intern, Cybersecurity Policy Analyst',
    'Systems Engineer Graduate Internship',
    "SRE & Application Services Intern (Graduate/Master's)",
    'Process Technology Development Intern',
    'Hardware Intern',
    'Software Sales Intern',
    'Tax Technology Intern',
    'Security & Fire Operation Intern',
    'Neurodiagnostic Technologist- EEG Apprentice', // Duke Health via Handshake (no intern word needed there)
    'Product Design Intern',
    'Winter 2027 Cybersecurity Intern',
    'Senior Software Engineer', // not an internship
  ])
    assert.ok(!titleFits(t), t);
});

// Phenom (Butterball, Truist, MITRE) and Oracle HCM board adapters: list JSON -> postings (2026-10-12).
test('phenom and oracle adapters map the list APIs to postings', async () => {
  const X = require('../lib/discover');
  const realFetch = global.fetch;
  global.fetch = async (url) => ({
    ok: true,
    json: async () =>
      /widgets$/.test(url)
        ? { refineSearch: { data: { jobs: [{ title: '2027 Summer IT Site Admin Intern', postedDate: '2026-09-11T00:00:00.000+0000', cityStateCountry: 'Garner, North Carolina, United States', applyUrl: 'https://butterball.rec.pro.ukg.net/x?opportunityId=1', jobSeqNo: 'BUTTUS1' }] } } }
        : { items: [{ requisitionList: [{ Id: '26011734', Title: 'Software Engineering Intern', PostedDate: '2026-10-12', PrimaryLocation: 'Austin, TX, United States', secondaryLocations: [{ Name: 'Remote, US' }] }] }] },
  });
  try {
    const [b] = await X.phenom({ host: 'careers.butterball.com', company: 'Butterball' });
    assert.strictEqual(b.url, 'https://butterball.rec.pro.ukg.net/x?opportunityId=1'); // the real ATS, not the Phenom page
    assert.strictEqual(b.location, 'Garner, North Carolina, United States');
    assert.ok(b.posted.startsWith('2026-09-11'));
    const [o] = await X.oracle({ host: 'hdjq.fa.us2.oraclecloud.com', site: 'CX_1', company: 'Emerson' });
    assert.strictEqual(o.url, 'https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26011734');
    assert.strictEqual(o.location, 'Austin, TX, United States; Remote, US');
  } finally {
    global.fetch = realFetch;
  }
});

test('ROLE: "Technologist" (Handshake hits skip the intern check) is not a tech role (Duke EEG apprentice, 2026-10-12)', () => {
  const { ROLE } = require('../lib/discover');
  assert.ok(!ROLE.test('Neurodiagnostic Technologist- EEG Apprentice'));
  assert.ok(ROLE.test('Global Technology Intern'));
});

test('part-time titles: board titles must say part-time / spring; Handshake ones are typed already', () => {
  const { partTimeFits } = require('../lib/discover');
  assert.ok(partTimeFits('Part-Time IT Help Desk Technician'));
  assert.ok(partTimeFits('Cybersecurity Spring 2027 Intern'));
  assert.ok(partTimeFits('GPSU Cybersecurity Spring Internship')); // Brookfield: part-time remote, Jan-Apr
  assert.ok(partTimeFits('IT Support Assistant', undefined, true)); // Handshake: employment type Part-Time
  assert.ok(!partTimeFits('IT Support Assistant')); // a board title without part-time: full-time job
  assert.ok(!partTimeFits('Software Engineer Intern Summer 2027', undefined, true));
  assert.ok(!partTimeFits('Part-Time Sales Associate'));
});

test('discover --part-time: an intern title is kept only when the posting text says part-time (Brookfield GPSU/NE)', async () => {
  const X = require('../lib/discover');
  const P = require('../lib/posting');
  const realPosting = P.posting;
  P.posting = async (url) => ({ text: /6218667004/.test(url) ? 'This is a part-time, remote paid internship ($20/hr)' : 'A 12-week full-time summer internship', flags: {}, ageDays: 3 });
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ meta: { name: 'Brookfield' }, jobs: [
    { title: 'Cloud Infrastructure Intern - GPSU/NE', location: { name: 'Remote' }, absolute_url: 'https://boards.greenhouse.io/brookfield/jobs/6218667004', first_published: new Date(Date.now() - 3 * 86400000).toISOString() },
    { title: 'Software Engineering Intern', location: { name: 'Remote' }, absolute_url: 'https://boards.greenhouse.io/brookfield/jobs/1', first_published: new Date(Date.now() - 3 * 86400000).toISOString() },
  ] }) });
  const fs = require('node:fs');
  const realRead = fs.readFileSync;
  fs.readFileSync = (f, ...a) => (/boards\.json$/.test(String(f)) ? JSON.stringify({ greenhouse: ['brookfield'] }) : realRead(f, ...a));
  try {
    const r = await X.discover({ partTime: true, simplify: false, noBoards: true });
    assert.deepStrictEqual(r.postings.map((p) => p.title), ['Cloud Infrastructure Intern - GPSU/NE']);
  } finally {
    P.posting = realPosting;
    global.fetch = realFetch;
    fs.readFileSync = realRead;
  }
});

test('part-time text: the job is part-time, not EEO boilerplate; grad-program-only text', () => {
  const { PT_TEXT, GRAD_ONLY_TEXT } = require('../lib/discover');
  assert.ok(PT_TEXT.test('This is a part-time, remote paid internship ($20/hr) that runs for 12 weeks'));
  assert.ok(PT_TEXT.test('Work 25-29hrs/wk Monday-Friday'));
  assert.ok(!PT_TEXT.test('regardless of status (full-time, part-time, per diem, temporary, etc.)')); // aah
  assert.ok(!PT_TEXT.test('Interns will be scheduled to work up to 40 hours per week'));
  assert.ok(GRAD_ONLY_TEXT.test("a part-time, work-study-based opportunity for active students in Master's and PhD programs")); // Ancestry
});
