'use strict';
// Offline checks of lib/posting.js parsing (no network): pay normalisation and gate flags.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/posting');

test('payPerHour: hourly, monthly, bi-weekly, yearly, USD-without-$ and mislabeled monthly ranges', () => {
  const one = (t) => P.payPerHour(t)[0];
  assert.deepStrictEqual([one('Hourly Salary USD 35.00 - 46.00 in Minnesota').low, one('Hourly Salary USD 35.00 - 46.00').high], [35, 46]);
  assert.strictEqual(one('USA monthly base pay: $9,500').low, 54.81);
  assert.strictEqual(one('$7.5K – $8K bi-weekly').low, 93.75);
  assert.strictEqual(one('yearly salary for this role is: $100,000 - $110,000 USD').low, 48.08);
  assert.strictEqual(one('The annual base salary range is: $8,500 - $10,000 USD').low, 49.04, 'intern "annual" figure this small is monthly');
  assert.strictEqual(one('Our hourly rate for this role is $50.00 per hour.').low, 50);
  assert.deepStrictEqual(P.payPerHour('raised over $1 billion'), []);
});

test('flags: required DO NOT CLAIM skills, but not when one choice in a list; clearance; AI policy', () => {
  const f = (text) => P.flags({ text, location: '', workplace: '' });
  assert.deepStrictEqual(f('WHAT YOU BRING Current enrollment in a BS. Proficiency in C++ Strong fundamentals').requiresUnclaimed, ['C++']);
  assert.strictEqual(f('Requirements: Strong proficiency in one or more languages (Python, TypeScript/JavaScript, Java, Go, or similar)').requiresUnclaimed, undefined);
  assert.strictEqual(f('Requirements: Python. Nice to have: Kubernetes and Docker').requiresUnclaimed, undefined);
  assert.ok(f('Must be able to obtain a security clearance.').clearance);
  assert.ok(f('Applicants must not use generative AI to answer these questions.').aiPolicy);
});

test('locate: Greenhouse via board link, embed link and careers-site gh_jid; Workday path', () => {
  assert.deepStrictEqual(P.locate('https://job-boards.greenhouse.io/embed/job_app?for=glenfield&token=8052118'), { ats: 'greenhouse', board: 'glenfield', id: '8052118' });
  assert.strictEqual(P.locate('https://www.lindenstonecareers.com/jobs/?gh_jid=7838577').board, 'lindenstone');
  const w = P.locate('https://umbermoor.wd5.myworkdayjobs.com/en-US/Jobsathpe/job/San-Jose/Cloud-Developer-Intern_1214950');
  assert.deepStrictEqual([w.tenant, w.site, w.path], ['umbermoor', 'Jobsathpe', '/job/San-Jose/Cloud-Developer-Intern_1214950']);
});

// Skipped in the public copy: asserts against the author's own facts bank (tailor/references/facts.md), which here is a small example.
test.skip('tailor: ranks real facts.md alternates, leads with confirmed skills, lists gaps but never the company itself', () => {
  const T = require('../lib/tailor');
  const facts = T.readFacts();
  assert.ok(facts.alternates.length >= 3, 'alternates parsed');
  assert.ok(facts.doNotClaim.includes('C++') && facts.doNotClaim.includes('Java') && !facts.doNotClaim.includes('Python'));
  assert.ok(!facts.alternates.some((a) => /Data Structures/.test(a.text)), 'coursework names are not bullets');
  const r = T.suggest('Build CI/CD pipelines and test automation in Python and Bash on Linux. Java a plus. Glenfield monitors.', facts, 'Glenfield');
  assert.ok(r.alternates.some((a) => /CI\/CD/.test(a.text)));
  assert.deepStrictEqual(['Python', 'Bash', 'CI/CD', 'Linux'].filter((s) => r.leadSkills.some((x) => x.startsWith(s))).length, 4);
  assert.deepStrictEqual(r.gaps, ['Java']);
  assert.ok(!T.suggest('Let us go to the office', facts).leadSkills.includes('Go'), '"go" the verb is not Go');
});

test('review fixes: preferred / nice-to-have skills are not required; "$150M raised" is not pay; structured pay parsed', () => {
  const f = (text) => P.flags({ text, location: '', workplace: '' }).requiresUnclaimed;
  assert.strictEqual(f('Minimum qualifications: Python. ' + 'x '.repeat(400) + ' Preferred qualifications: Docker, Kubernetes'), undefined);
  assert.strictEqual(f('Requirements: Python. Experience with Docker is a plus.'), undefined);
  assert.strictEqual(f('Nice-to-have: Kubernetes'), undefined);
  assert.deepStrictEqual(f('Requirements: Java and Python required'), ['Java']);
  assert.deepStrictEqual(P.payPerHour('We raised $150M from investors'), []);
  assert.strictEqual(P.payPerHour('Pay: $40 - $50 per hour.')[0].high, 50);
});

test('payTier: pay set by academic level uses the Junior/Senior tier (xAI 2026-10-08)', () => {
  const t = 'Software Engineering Intern/Freshman/Sophomore: $30 USD per hour Software Engineering Intern/Junior/Senior: $34 USD per hour Software Engineering Intern/Completed Bachelor’s: $36 USD per hour Software Engineering Intern/Completed Master’s: $38 USD per hour Software Engineering Intern/Completed PhD: $40 USD per hour';
  const tier = P.payTier(P.payPerHour(t));
  assert.strictEqual(tier.low, 34);
  assert.strictEqual(tier.high, 34);
  assert.strictEqual(P.payTier(P.payPerHour('Pay: $40 - $50 per hour.')), null);
  assert.strictEqual(P.payTier(P.payPerHour('$30/hourly for undergraduate students')), null);
});

test('payTier: tiers listed highest first still pick Junior/Senior (code review 2026-10-08)', () => {
  const tier = P.payTier(P.payPerHour("Completed Master's: $38/hr. Junior/Senior: $34/hr. Freshman/Sophomore: $30/hr."));
  assert.strictEqual(tier.low, 34);
});

test('payPerHour: 4-digit amounts without commas are whole, small annual benefits are not pay (Brookfield 2026-10-09)', () => {
  const t = 'This is a part-time, remote paid internship ($20hr) that is offered as part of the GPSU program. GPS will contribute ($850 per EE annually / $1750 per family annually (includes spouse/children/family options) Group Dental';
  const pay = P.payPerHour(t);
  assert.strictEqual(pay.length, 1);
  assert.deepStrictEqual([pay[0].low, pay[0].high], [20, 20]);
  assert.strictEqual(P.payPerHour('$2400 per week')[0].low, 60);
});

test('flags: "Python and/or Java" / "Java or Python" is a choice, not a Java requirement (Glenmoor 2026-10-09)', () => {
  const f = (t) => P.flags({ text: t, location: '' }).requiresUnclaimed;
  assert.strictEqual(f('Qualifications: Proficiency in Python and/or Java through coursework.'), undefined);
  assert.strictEqual(f('Qualifications: Proficiency in Java or Python.'), undefined);
  assert.deepStrictEqual(f('Requirements: Strong Java skills. Experience with Spring.'), ['Java']);
  assert.deepStrictEqual(f('Requirements: Experience with C++, Python, and Go.'), ['C++']);
});

// ---- 2026-10-09 fix pass: Oracle and JSON-LD readers (no tab), role family -------------------------------------
const fs = require('node:fs');
const path = require('node:path');
const FX = path.join(__dirname, 'fixtures');

test('locate: Oracle Recruiting Cloud job links (site name or number, job or requisition preview)', () => {
  const o = P.locate('https://iawmqy.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/careers/job/300404?utm_source=x');
  assert.deepStrictEqual([o.ats, o.host, o.site, o.id], ['oracle', 'iawmqy.fa.ocs.oraclecloud.com', 'careers', '300404']);
  assert.strictEqual(o.page, 'https://iawmqy.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/careers/job/300404');
  assert.strictEqual(P.locate('https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_45001/requisitions/preview/12345').site, 'CX_45001');
});

test('oracle: the site number comes from the job page, the text from the REST detail (Fernhaven 300404 fixture)', async () => {
  const at = P.locate('https://iawmqy.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/careers/job/300404');
  const asked = [];
  const html = '<html><head><title>Fernhaven</title><link rel="icon" href="/hcmRestApi/CandidateExperience/siteFavicon/favicon-16x16.png?siteNumber=CX_1001&size=16x16"></head></html>';
  const json = JSON.parse(fs.readFileSync(path.join(FX, 'oracle-requisition.json'), 'utf8'));
  const p = await P.oraclePosting(at, async (u) => (asked.push(u), json), async (u) => (asked.push(u), html));
  assert.strictEqual(asked[0], at.page);
  assert.match(asked[1], /\/hcmRestApi\/resources\/latest\/recruitingCEJobRequisitionDetails\?expand=all&onlyData=true&finder=ById;Id=%22300404%22,siteNumber=CX_1001$/);
  assert.deepStrictEqual([p.company, p.title, p.location, p.posted], ['Fernhaven', 'Cloud Software Security (CSS) Summer Internship, Undergraduate Intern', 'Round Rock, TX, United States', '2026-10-07T19:28:56+00:00']);
  assert.ok(p.text.length > 2000 && !/<p|&nbsp;/.test(p.text), 'html stripped');
  assert.deepStrictEqual(P.payPerHour(p.text).map((x) => [x.low, x.high]), [[21.03, 28.92]]);
  assert.match(P.flags(p).roleFamily, /^sales \(Commercial Sales/, 'a sales internship behind a security title');
  // A link that already names the site number needs no page fetch.
  const direct = [];
  await P.oraclePosting({ ...at, site: 'CX_1001' }, async (u) => (direct.push(u), json), async () => assert.fail('no page fetch'));
  assert.strictEqual(direct.length, 1);
});

test('jsonLdPosting: schema.org JobPosting from a career page (IRONFIELD iCIMS fixture); none on other pages', () => {
  const html = fs.readFileSync(path.join(FX, 'jsonld-posting.html'), 'utf8');
  const p = P.jsonLdPosting(html, 'https://careers.ironfield.edu/jobs/59576');
  assert.deepStrictEqual([p.company, p.title, p.location, p.posted], ['Ironfield', '2027 Internship - Systems Engineer', 'Laurel, Maryland', '2026-10-08T15:04:00+0000']);
  assert.ok(p.text.length > 1000 && !/<\w+/.test(p.text));
  assert.ok(!/Pay:/.test(p.text), 'a zero baseSalary is no pay');
  assert.strictEqual(P.jsonLdPosting('<html><script type="application/ld+json">{"@type":"Organization","name":"X"}</script></html>', 'https://x.test'), null);
  const paid = P.jsonLdPosting('<script type="application/ld+json">{"@type":"JobPosting","title":"Intern","description":"<p>Build things</p>","baseSalary":{"value":{"minValue":30,"maxValue":40,"unitText":"HOUR"}}}</script>', 'https://x.test');
  assert.match(paid.text, /Pay: \$30 - \$40 per hour\./);
});

test('roleFamily: a non-engineering team is named; pay boilerplate about other teams is not (DUNVALE 2026-10-09)', () => {
  assert.strictEqual(P.roleFamily('Base pay is one part. Most sales positions are eligible for commission under an applicable plan. Non-sales roles are eligible for a bonus.', 'DevOps Intern'), null);
  assert.strictEqual(P.roleFamily('Partner with our sales team and product to ship APIs in Python.', 'Software Engineer Intern'), null, 'one passing mention is not the role');
  assert.match(P.roleFamily('Join our Commercial Sales team. Geared towards those with an interest in sales.', 'Cloud Software Security Intern'), /^sales/);
  assert.match(P.roleFamily('', 'Marketing Intern'), /^marketing/);
});

test('fetchPosting: login-walled boards (LinkedIn, Indeed, Handshake) are never fetched for JSON-LD', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => assert.fail('no request for a login-walled board');
  try {
    for (const u of ['https://www.linkedin.com/jobs/view/4012345678', 'https://www.indeed.com/viewjob?jk=abc', 'https://exu.joinhandshake.com/jobs/1']) await assert.rejects(P.fetchPosting(u), /no public API/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('jsonLdPosting: iCIMS "now minus 2 years" datePosted placeholder is no date, a real date is kept', () => {
  const now = Date.parse('2026-10-11T14:35:55.398Z');
  const page = (d) => `<script type="application/ld+json">{"@type":"JobPosting","title":"Cybersecurity Internship","description":"x","datePosted":"${d}"}</script>`;
  assert.strictEqual(P.jsonLdPosting(page('2024-10-11T14:35:55.398Z'), 'https://uscareers-yarrowmere.icims.com/jobs/8663/job', now).posted, '');
  assert.strictEqual(P.jsonLdPosting(page('2026-10-08T00:00:00Z'), 'https://x.icims.com/jobs/1/job', now).posted, '2026-10-08T00:00:00Z');
  assert.strictEqual(P.placeholderDate('2024-09-01T00:00:00Z', now), false, 'a genuinely old date stays old');
});

test('flags: the "Employee Polygraph Protection" EEO footer is not a clearance; a polygraph exam still is', () => {
  const f = (text) => P.flags({ text, location: '', workplace: '' });
  assert.ok(!f('Know Your Rights I Family & Medical Leave I Employee Polygraph Protection I Right to Work I E-Verify').clearance);
  assert.ok(!f('Employee Polygraph Protection Act poster').clearance);
  assert.ok(f('Candidates must pass a polygraph examination.').clearance);
});

test('schoolTermCoop: Jan-Jun and Aug-Dec co-ops clash with classes; summer co-ops and internships do not', () => {
  const c = P.schoolTermCoop;
  assert.strictEqual(c('a 6-month co-op, running from January 5th – June 24th, 2027', 'Spring Co-op 2027 - Software Engineering, Security & Operations'), 'spring co-op');
  assert.strictEqual(c('Software Engineering Co-Op (January – June 2027) What you will do', 'Software Engineering Co-Op'), 'spring co-op');
  assert.strictEqual(c('This co-op runs July - December 2027', 'IT Co-op'), 'fall co-op');
  assert.strictEqual(c('Summer co-op, May - August 2027', 'Summer Co-op'), null);
  assert.strictEqual(c('12-week summer internship, June - August 2027', 'Security Intern'), null);
  assert.strictEqual(c('We also run a spring co-op program.', 'Summer 2027 Co-op'), null, 'the keyword counts only in the title');
  assert.strictEqual(P.flags({ text: 'Software Engineering Co-Op (January – June 2027)', title: 'Software Engineering Co-Op', location: '', workplace: '' }).schoolTerm, 'spring co-op');
});

test('flags: a long "X, Y, Z, and/or W" list or a "(this is a strong plus)" item is not a requirement', () => {
  const f = (text) => P.flags({ text, location: '', workplace: '' }).requiresUnclaimed;
  const ravenvale = 'Requirements - A strong academic background in computer science - Professional or personal experience with Java, Kotlin, TypeScript, SQL, and/or AWS (this is a strong plus) - Exceptional verbal and written communication skills';
  assert.ok(!(f(ravenvale) || []).includes('Java'));
  assert.ok(!(f('Requirements: experience with Java, Kotlin, Go, or Rust.') || []).includes('Java'));
  assert.deepStrictEqual(f('Requirements: Proficiency in Java, SQL and Git.'), ['Java'], 'an and-list still requires each');
});

test('flags: "Technologies we use include ..." and "exposure to ..." are the team stack, not requirements', () => {
  const f = (text) => P.flags({ text, location: '', workplace: '' }).requiresUnclaimed;
  const t = 'Requirements - Ability to code is required - Technologies we use include: Linux, Kubernetes, Docker, Python, Haskell, Java, Kerberos (MIT/Windows), DNS (BIND), AWS (SQS, SNS, EC2), SSH, IPSec, Ansible, NFS, Git - Ability to use GenAI tools';
  assert.strictEqual(f(t), undefined);
  assert.strictEqual(f('Qualifications: you will get exposure to Kubernetes / Docker and SRE.'), undefined);
});
