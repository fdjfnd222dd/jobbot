// Unit tests for the driver's page classification and button choice (no browser).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib/apply');

const snap = (o) => ({ url: 'https://x', heading: '', fields: [], buttons: [], signals: { confirmation: false, alreadyApplied: false, closed: false, verifyEmail: false, captcha: [], passwordFields: 0, errors: [], embeddedForms: [] }, ...o, signals: { confirmation: false, alreadyApplied: false, closed: false, verifyEmail: false, captcha: [], passwordFields: 0, errors: [], embeddedForms: [], ...(o.signals || {}) } });
const b = (text, extra) => ({ ref: '0:' + text.length, text, ...(extra || {}) });
const f = (label, extra) => ({ ref: '0:9', label, kind: 'text', required: false, value: '', ...(extra || {}) });

test('landing page with Apply button', () => {
  const s = snap({ buttons: [b('Save job'), b('Apply for this job')] });
  assert.strictEqual(A.classify(s), 'landing');
  assert.strictEqual(A.findApply(s).text, 'Apply for this job');
});
test('Apply with LinkedIn is not chosen', () => {
  const s = snap({ buttons: [b('Apply with LinkedIn'), b('Apply')] });
  assert.strictEqual(A.findApply(s).text, 'Apply');
});
test('Workday modal: Use My Last Application only with an account, else autofill from the resume', () => {
  const s = snap({ buttons: [b('Apply Manually', { aid: 'applyManually' }), b('Autofill with Resume', { aid: 'autofillWithResume' }), b('Use My Last Application', { aid: 'useMyLastApplication' })] });
  assert.strictEqual(A.findApply(s, { hasAccount: true }).text, 'Use My Last Application');
  assert.strictEqual(A.findApply(s).text, 'Autofill with Resume');
});
test('confirmation wins', () => {
  assert.strictEqual(A.classify(snap({ signals: { confirmation: true } })), 'done');
});
test('captcha challenge blocks', () => {
  assert.strictEqual(A.classify(snap({ fields: [f('a'), f('b')], signals: { captcha: ['hcaptcha-challenge'] } })), 'captcha');
});
test('password fields mean auth', () => {
  assert.strictEqual(A.classify(snap({ fields: [f('Email'), f('Password', { kind: 'password' })], signals: { passwordFields: 1 } })), 'auth');
});
test('form with fields', () => {
  assert.strictEqual(A.classify(snap({ fields: [f('First name'), f('Last name')] })), 'form');
});
test('search box alone is not a form', () => {
  assert.notStrictEqual(A.classify(snap({ fields: [f('Search jobs')] })), 'form');
});
test('nav: Workday footer button', () => {
  const s = snap({ buttons: [b('Back'), b('Save and Continue', { aid: 'pageFooterNextButton' })] });
  assert.deepStrictEqual(A.findNav(s).kind, 'next');
  const s2 = snap({ buttons: [b('Submit', { aid: 'pageFooterNextButton' })] });
  assert.deepStrictEqual(A.findNav(s2).kind, 'submit');
});
test('nav: Next beats Submit when both exist', () => {
  assert.strictEqual(A.findNav(snap({ buttons: [b('Submit application'), b('Next')] })).kind, 'next');
  assert.strictEqual(A.findNav(snap({ buttons: [b('Submit application')] })).kind, 'submit');
});
test('nav: a row\'s Delete (type=submit) is never the Submit (DUNVALE My Experience 2026-10-09)', () => {
  assert.strictEqual(A.findNav(snap({ buttons: [b('Delete', { submit: true }), b('Back')] })), null);
  assert.strictEqual(A.findNav(snap({ buttons: [b('Remove', { submit: true }), b('Submit')] })).btn.text, 'Submit');
});
test('splitRef', () => {
  assert.deepStrictEqual(A.splitRef('3:12'), { frameId: 3, ref: '12' });
  assert.throws(() => A.splitRef('12'));
});

const U = require('../lib/urls');
test('urls: ATS detection', () => {
  assert.strictEqual(U.atsOf('https://job-boards.greenhouse.io/acme/jobs/123'), 'greenhouse');
  assert.strictEqual(U.atsOf('https://quillstone.wd5.myworkdayjobs.com/en-US/External/job/X_R1'), 'workday');
  assert.strictEqual(U.atsOf('https://example.com/careers'), 'unknown');
});
test('urls: direct application form', () => {
  const id = '0c5b6c3e-1111-2222-3333-444455556666';
  assert.strictEqual(U.applyUrl(`https://jobs.lever.co/acme/${id}`), `https://jobs.lever.co/acme/${id}/apply`);
  assert.strictEqual(U.applyUrl(`https://jobs.lever.co/acme/${id}/apply`), `https://jobs.lever.co/acme/${id}/apply`);
  assert.strictEqual(U.applyUrl(`https://jobs.ashbyhq.com/acme/${id}`), `https://jobs.ashbyhq.com/acme/${id}/application`);
  assert.strictEqual(U.applyUrl('https://acme.taleo.net/careersection/2/jobdetail.ftl?job=42'), 'https://acme.taleo.net/careersection/2/jobapply.ftl?job=42');
  assert.strictEqual(U.applyUrl('https://acme.com/careers?gh_jid=987&for=acme'), 'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=987');
  // Glenfield's board redirects /jobs/ID to careers.glenfieldhq.com (form in a cross-origin iframe): go to the embed form.
  assert.strictEqual(U.applyUrl('https://job-boards.greenhouse.io/glenfield/jobs/8052118'), 'https://job-boards.greenhouse.io/embed/job_app?for=glenfield&token=8052118');
  assert.strictEqual(U.applyUrl('https://boards.greenhouse.io/brookvale/jobs/8207970?t=gh_src=&gh_jid=8207970'), 'https://job-boards.greenhouse.io/embed/job_app?for=brookvale&token=8207970');
  assert.strictEqual(U.applyUrl('https://job-boards.greenhouse.io/embed/job_app?for=acme&token=5'), 'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=5');
});
test('urls: LinkedIn wrapper unwrapped', () => {
  const inner = 'https://jobs.lever.co/acme/0c5b6c3e-1111-2222-3333-444455556666';
  assert.strictEqual(U.unwrap('https://www.linkedin.com/safety/go?url=' + encodeURIComponent(inner) + '&trk=x'), inner);
});
test('confirmation by URL (Lever /thanks, Greenhouse /confirmation)', () => {
  assert.strictEqual(A.classify(snap({ url: 'https://jobs.lever.co/a/b/thanks' })), 'done');
  assert.strictEqual(A.classify(snap({ url: 'https://job-boards.greenhouse.io/a/jobs/1/confirmation' })), 'done');
});
test('emailed security code hands off', () => {
  assert.strictEqual(A.classify(snap({ fields: [f('a'), f('b')], signals: { securityCode: true } })), 'security_code');
});
test('email-first gate (iCIMS / Oracle)', () => {
  assert.strictEqual(A.classify(snap({ fields: [f('Email Address', { kind: 'email' })], buttons: [b('Next')] })), 'email_gate');
});

test('profileAnswer: plain profile facts for custom dropdowns, nothing for questions', () => {
  const p = { profile: { city: 'Springfield', state: 'VA', school: 'State U', major: 'IT', gradMonth: '12', gradYear: '2027' } };
  assert.deepStrictEqual(A.profileAnswer({ label: 'Location (City)*' }, p), { value: 'Springfield, VA', query: 'Springfield' });
  assert.deepStrictEqual(A.profileAnswer({ label: 'School*' }, p), { value: 'State U' });
  assert.deepStrictEqual(A.profileAnswer({ label: 'Discipline' }, p), { value: 'IT' });
  assert.deepStrictEqual(A.profileAnswer({ label: 'End date month*', section: 'Education' }, p), { value: 'December' });
  assert.deepStrictEqual(A.profileAnswer({ label: 'End date year*', section: 'Education' }, p), { value: '2027' });
  assert.strictEqual(A.profileAnswer({ label: 'End date month*', section: 'Employment' }, p), null, 'work-history end date is not the grad date');
  assert.strictEqual(A.profileAnswer({ label: 'Are you located in SF/NYC or open to relocation?' }, p), null);
  assert.strictEqual(A.profileAnswer({ label: 'Did you attend a school in the University of California system?' }, p), null);
});

test('profileAnswer: never puts the college into high-school fields (Lever regression)', () => {
  const p = { profile: { school: 'State U', gradMonth: '12', gradYear: '2027' } };
  assert.strictEqual(A.profileAnswer({ label: 'Year of High School Graduation✱' }, p), null);
  assert.strictEqual(A.profileAnswer({ label: 'High School Name✱' }, p), null);
  assert.strictEqual(A.profileAnswer({ label: 'Graduation year', section: 'High school' }, p), null);
  assert.deepStrictEqual(A.profileAnswer({ label: 'Which university are you currently attending or did you last attend?' }, p), { value: 'State U' });
  assert.deepStrictEqual(A.profileAnswer({ label: 'Please include your intended graduation year for the degree you are currently pursuing.✱' }, p), { value: '2027' });
});

test('standardAnswer: exact option for the stored answer, nothing it cannot derive', () => {
  const p = { standardAnswers: { workAuth: 'yes', sponsorship: 'no', veteran: 'not' } };
  assert.strictEqual(A.standardAnswer({ label: 'Are you legally authorized to work in the United States?', kind: 'radio', options: ['Yes', 'No'] }, p).value, 'Yes');
  assert.strictEqual(A.standardAnswer({ label: 'Will you now or in the future require visa sponsorship?', kind: 'select', options: ['Yes', 'No'] }, p).value, 'No');
  // "not a protected veteran" does not say "never served": left for the owner.
  assert.strictEqual(A.standardAnswer({ label: 'What is your military status?', kind: 'combobox', options: ['I am on active duty', 'I have never served in the military', "I don't wish to answer"] }, p), null);
  assert.strictEqual(A.standardAnswer({ label: 'Why do you want to work here?', kind: 'textarea' }, p), null);
});

test('company-built sites: "I want to apply" and links to <posting>/apply (Copperstone)', () => {
  assert.strictEqual(A.findApply(snap({ buttons: [b('Your Privacy Choices', { chrome: true }), b('I want to apply', { href: 'https://careers.example.com/jobs/x/apply' })] })).text, 'I want to apply');
  assert.strictEqual(A.findApply(snap({ buttons: [b('Join the team', { href: 'https://careers.example.com/jobs/x/apply' })] })).text, 'Join the team');
  assert.strictEqual(A.findApply(snap({ buttons: [b('Join the team', { href: 'https://careers.example.com/jobs/x' })] })), undefined);
});

test('a careers landing page with a video player is not a form (range sliders)', () => {
  const s = snap({ fields: [f('Seek', { kind: 'range' }), f('Volume', { kind: 'range' })], buttons: [b('Apply now')] });
  assert.strictEqual(A.classify(s), 'landing');
});

/* Q&A bank: {company} answers and the audit (a scratch data dir, never the owner's). */
test('bank: answers saved with {company} are reused for the next company, not without one', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-bank-'));
  const run = (code) => require('node:child_process').execFileSync(process.execPath, ['-e', code], { env: { ...process.env, JOBBOT_DATA: dir }, cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'answers.json'), '{"entries":[]}');
  const out = JSON.parse(run(`
    const D = require('./lib/data');
    const e = D.saveAnswer('Why do you want to work at Acme Robotics?', 'I like what Acme Robotics builds.', '', 'Acme Robotics');
    const w = D.saveAnswer('What do you know about Acme Robotics?', 'Acme makes arms.', '', 'Acme Robotics');
    console.log(JSON.stringify({ q: e.question, a: e.answer, warn: w.warning || null,
      other: D.lookup({ label: 'Why do you want to work at Globex?' }, 'Globex'),
      none: D.lookup({ label: 'Why do you want to work at Globex?' }, null),
      review: require('./lib/review').review().map((r) => r.flags) }));`));
  assert.strictEqual(out.q, 'why do you want to work at {company}');
  assert.strictEqual(out.a, 'I like what {company} builds.');
  assert.match(out.warn, /still names Acme/);
  assert.strictEqual(out.other.answer, 'I like what Globex builds.');
  assert.strictEqual(out.none, null, 'a {company} answer needs a known company');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('review-answers: flags a company-specific history fact stored as {company}', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-bank-'));
  fs.writeFileSync(path.join(dir, 'answers.json'), JSON.stringify({ entries: [
    { id: 'qa-1', question: 'have you ever worked for {company}', answer: 'No', aliases: [] },
    { id: 'qa-2', question: 'what tools do you use', answer: 'Python and Java daily', aliases: [] },
  ] }));
  const out = require('node:child_process').execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./lib/review').review().map((r) => r.flags)))"], { env: { ...process.env, JOBBOT_DATA: dir }, cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  const flags = JSON.parse(out);
  assert.ok(flags[0].some((f) => /company-specific/.test(f)), JSON.stringify(flags));
  assert.ok(flags[1].some((f) => /claim: Java/.test(f)), JSON.stringify(flags));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dry runs never press Submit (the one remaining dry guard)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'apply.js'), 'utf8');
  assert.match(src, /if \(run\.noSubmit \|\| run\.dry \|\| !p\.policy\.autoSubmit\)/);
  const R = require('../lib/runs');
  assert.ok(R.create.toString().includes('opts.noSubmit || opts.dry'), 'a dry run is also noSubmit');
});

test('salary: the number only for "what is your expected pay", never for "willing to accept the range?" (Willowvale)', () => {
  assert.ok(A.isSalaryAmountQuestion('What are your salary expectations?'));
  assert.ok(A.isSalaryAmountQuestion('Desired hourly pay'));
  assert.ok(!A.isSalaryAmountQuestion('The job posting listed the applicable salary range for this position. Are you willing to accept this salary range?'));
  // Willowcrest 2026-10-08: a yes/no question, not a request for the number.
  assert.ok(!A.isSalaryAmountQuestion('Is the posted salary range within your desired salary range?*'));
  assert.ok(A.isSalaryAmountQuestion('What hourly rate fits your expectations?'));
  assert.ok(A.isSalaryAmountQuestion('Salary expectations (in line with your experience)'));
});

test('conflict-of-interest questions are recognised (owner rule: always No); employment history is not', () => {
  assert.ok(A.isConflictQuestion('Do you have: a) any Personal/Familial Relationships (current Brookvale employees …'));
  assert.ok(A.isConflictQuestion('Are you related to anyone at Willowvale?'));
  assert.ok(A.isConflictQuestion('Do you have any outside business activities that you wish to continue?'));
  assert.ok(!A.isConflictQuestion('Have you ever worked for Brookvale as an employee, intern or contractor?'));
  assert.ok(!A.isConflictQuestion('Were you referred by a current employee?'));
});

test('discover filters: interns in his track only', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'discover.js'), 'utf8');
  const INTERN = eval(src.match(/const INTERN = (\/.*\/i);/)[1]);
  const OFF = eval(src.match(/const OFF_TRACK = (\/.*\/i);/)[1]);
  assert.ok(INTERN.test('Network Infrastructure Intern') && INTERN.test('IT Co-op'));
  assert.ok(!INTERN.test('Engineering Manager, Cooperative Systems'));
  assert.ok(OFF.test('Fluid Systems Intern Summer 2027') && !OFF.test('Systems Engineering Intern'));
  const D = require('../lib/discover');
  assert.ok(D.ROLE.test('Security Analyst Intern') && D.ROLE.test('Supercomputing Intern') && !D.ROLE.test('Product Design Intern'));
});

test('discover: never-list and in-motion employers are filtered, Austin is a search area', () => {
  const X = require('../lib/discover');
  for (const c of ['examplecorp-never-apply']) assert.ok(X.NEVER.test(c), c);
  for (const c of ['embervale', 'glenfield', 'northfield', 'capitalone']) assert.ok(!X.NEVER.test(c), c);
  for (const c of ['brightco', 'quillstone', 'globex']) assert.ok(X.IN_MOTION.test(c), c);
  assert.ok(X.PLACES.some(([n, re]) => n === 'Austin' && re.test('Austin, TX')));
  assert.ok(X.ROLE.test('Technical Support Engineer (TSE) Intern'));
});

test('discover: Workday "Posted N Days Ago" becomes a date; postings older than a week are out', () => {
  const X = require('../lib/discover');
  const now = Date.parse('2026-10-07T12:00:00Z');
  assert.strictEqual(X.workdayPosted('Posted Today', now).slice(0, 10), '2026-10-07');
  assert.strictEqual(X.workdayPosted('Posted Yesterday', now).slice(0, 10), '2026-10-06');
  assert.strictEqual(X.workdayPosted('Posted 30+ Days Ago', now).slice(0, 10), '2026-09-07');
  assert.ok(X.ageDays({ posted: X.workdayPosted('Posted 2 Days Ago', now) }, now) <= 7);
  assert.ok(X.ageDays({ posted: '2026-08-28T00:00:00Z' }, now) > 7);
  assert.strictEqual(X.ageDays({}, now), Infinity, 'unknown date is treated as too old');
});

test('postingKey: different Greenhouse postings never collide; the same posting matches in any URL form', () => {
  const U = require('../lib/urls');
  const a = U.postingKey('https://job-boards.greenhouse.io/northfield/jobs/8181017');
  const b = U.postingKey('https://job-boards.greenhouse.io/umberfield/jobs/8001295003');
  assert.notStrictEqual(a, b);
  assert.strictEqual(a, U.postingKey('https://job-boards.greenhouse.io/embed/job_app?for=northfield&token=8181017'));
  assert.strictEqual(U.postingKey('https://www.lindenstonecareers.com/jobs/?gh_jid=7838577'), U.postingKey('https://job-boards.greenhouse.io/lindenstone/jobs/7838577'));
  assert.strictEqual(U.postingKey('https://jobs.lever.co/acme/c3017f47-8150-44ae-8522-71fd28657e25'), U.postingKey('https://jobs.lever.co/acme/c3017f47-8150-44ae-8522-71fd28657e25/apply'));
});

test('runs: a stopped run is no longer "waiting" once the same posting was submitted in a later run, or dropped', () => {
  const R = require('../lib/runs');
  const stopped = { id: 'r1', status: 'blocked', url: 'https://job-boards.greenhouse.io/glenfield/jobs/8052118' };
  assert.strictEqual(R.isOpen(stopped, []), true);
  assert.strictEqual(R.isOpen(stopped, [{ run: 'r2', url: 'https://job-boards.greenhouse.io/embed/job_app?for=glenfield&token=8052118' }]), false);
  assert.strictEqual(R.isOpen({ ...stopped, abandoned: true }, []), false);
  assert.strictEqual(R.isOpen({ ...stopped, dry: true }, []), false);
});

test('review fixes 2026-10-07: US locations, postingKey locale / id params, EU Greenhouse host, drop guard', () => {
  const X = require('../lib/discover');
  for (const l of ['Toronto, ON, Canada; New York, NY, United States', 'Dublin, OH', 'Vancouver, WA', 'Ontario, CA', 'Albuquerque, New Mexico', 'San Jose, CA', 'Remote, US']) assert.ok(X.isUsLocation(l), l);
  for (const l of ['Toronto, ON, CA', 'London, UK', 'Mexico City, Mexico', 'Paris, France']) assert.ok(!X.isUsLocation(l), l);
  const U = require('../lib/urls');
  assert.strictEqual(U.postingKey('https://umbermoor.wd5.myworkdayjobs.com/en-US/Jobsathpe/job/X_1'), U.postingKey('https://umbermoor.wd5.myworkdayjobs.com/Jobsathpe/job/X_1'));
  assert.notStrictEqual(U.postingKey('https://apply.careers.microsoft.com/careers?pid=111'), U.postingKey('https://apply.careers.microsoft.com/careers?pid=222'));
  assert.notStrictEqual(U.postingKey('https://x.adp.com/a?jobId=1'), U.postingKey('https://x.adp.com/a?jobId=2'));
  assert.strictEqual(U.applyUrl('https://job-boards.eu.greenhouse.io/acme/jobs/4567'), 'https://job-boards.eu.greenhouse.io/embed/job_app?for=acme&token=4567');
});

test('OPT_IN: job alerts / marketing / other roles, not real consent', () => {
  const yes = ['I agree to receive updates about new job opportunities.', 'I agree to receive marketing communications', 'Would you like to join our Talent Community?', 'Please consider me for other roles at the company', 'Sign me up for job alerts', 'I consent to receive text messages'];
  const no = ['I agree to the Terms of Use and Privacy Policy', 'I certify that the information provided is true', 'Will you require sponsorship?', 'Do you have any active non-compete agreements?'];
  for (const t of yes) assert.ok(A.OPT_IN.test(t), t);
  for (const t of no) assert.ok(!A.OPT_IN.test(t), t);
});

test('nav never presses a skip link or a captcha button as submit (Driftmere iCIMS, 2026-10-08)', () => {
  const s = snap({ buttons: [b('Skip to Main Content', { submit: true }), b('About hCaptcha & Accessibility Options', { submit: true }), b('Create Profile', { submit: true })] });
  const nav = A.findNav(s);
  assert.strictEqual(nav.btn.text, 'Create Profile');
  assert.strictEqual(nav.kind, 'next', 'iCIMS Create Profile leads to more steps');
  assert.strictEqual(A.findNav(snap({ buttons: [b('Skip to Main Content', { submit: true })] })), null);
});

test('uploadPage: iCIMS iframe layout params are not a new page (IRONFIELD 2026-10-09)', () => {
  const base = 'https://studentcareers-ironfield.icims.com/jobs/59576/2027-internship---systems-engineer/candidate';
  assert.strictEqual(A.uploadPage(base + '?bga=true&height=500&jan1offset=-300&jun1offset=-240&width=926'), A.uploadPage(base + '?bga=true&height=500&jan1offset=-300&jun1offset=-240&width=919'));
  assert.strictEqual(A.uploadPage(base + '?bga=true&width=926'), A.uploadPage(base + '?from=login&csrf=X&uploadResume=1'));
});
test('uploadPage: one key per page whatever the query (iCIMS reload re-uploaded and re-parsed the resume)', () => {
  const u1 = 'https://uscareers-driftmere.icims.com/jobs/30465/software-engineer-intern/candidate?from=login&eem=abc&in_iframe=1#x';
  const u2 = 'https://uscareers-driftmere.icims.com/jobs/30465/software-engineer-intern/candidate?from=login&csrf=E64&uploadResume=1&uploadResume=1';
  assert.strictEqual(A.uploadPage(u1), A.uploadPage(u2));
  assert.notStrictEqual(A.uploadPage(u1), A.uploadPage('https://uscareers-driftmere.icims.com/jobs/30465/software-engineer-intern/questions'));
});

test('profileAnswer: Oracle Address Line 1 gets the home street as a suggestion search; employer blocks do not', () => {
  const p = { profile: { addressLine1: '1 Main St', city: 'Springfield' } };
  assert.deepStrictEqual(A.profileAnswer({ label: 'Address Line 1 *' }, p), { value: '1 Main St', query: '1 Main St' });
  assert.strictEqual(A.profileAnswer({ label: 'Address Line 1', section: 'Professional Experience (2)' }, p), null);
  assert.strictEqual(A.profileAnswer({ label: 'Address' }, p), null, 'a bare "Address" can be an employer block (iCIMS)');
});

test('discover markSkips: Workday-account flag, dropped / tracker skips (68-hit run left them unmarked)', () => {
  const { markSkips } = require('../lib/discover');
  const hits = [
    { ats: 'workday', company: 'glenmoor', url: 'https://glenmoor.wd1.myworkdayjobs.com/x/job/y' },
    { ats: 'workday', company: 'elmwick', url: 'https://elmwick.wd1.myworkdayjobs.com/x/job/y' },
    { ats: 'ashby', company: 'Silverwick', url: 'https://jobs.ashbyhq.com/silverwick/1' },
    { ats: 'greenhouse', company: 'Copperfield', url: 'https://job-boards.greenhouse.io/s/jobs/1', inTracker: true },
    { ats: 'greenhouse', company: 'Valemere', url: 'https://job-boards.greenhouse.io/d/jobs/1' },
  ];
  markSkips(hits, new Set(['silverwick']), (site) => site.startsWith('elmwick.'));
  // Owner 2026-10-09: no Workday account is a flag (he presses Create Account), not a skip.
  assert.strictEqual(hits[0].skip, undefined);
  assert.strictEqual(hits[0].needsAccount, true);
  assert.strictEqual(hits[1].skip, undefined);
  assert.strictEqual(hits[1].needsAccount, undefined);
  assert.match(hits[2].skip, /owner dropped/);
  assert.match(hits[3].skip, /already applied/);
  assert.strictEqual(hits[4].skip, undefined);
});

test('discover: a different role at a company already applied to stays in; a similar one is skipped (69 hidden 2026-10-12)', () => {
  const { markSkips, similarRole } = require('../lib/discover');
  assert.strictEqual(similarRole('Software Engineer Intern', 'Software Engineer Intern (2027)'), true);
  assert.strictEqual(similarRole('Software Engineering Intern - Summer 2027', 'Summer 2027 Internship - Software Engineering Intern'), true);
  assert.strictEqual(similarRole('Cybersecurity - Summer 2027 Internships', 'Software Engineering - Summer 2027 Internships'), false);
  assert.strictEqual(similarRole('Infrastructure Deployment Automation Intern', 'Network Engineering Intern'), false);
  assert.strictEqual(similarRole('Software Engineer Intern', 'Early Careers - Identify & Access Management (IAM) Intern'), false);
  assert.strictEqual(similarRole('Software Engineer Intern', 'Data Center Engineer Intern - Summer 2027'), false);
  assert.strictEqual(similarRole('Software Engineer Intern', 'Machine Learning Engineer Intern'), false);
  assert.strictEqual(similarRole('Software Engineer Intern', 'Software Development Engineer Intern'), true);
  const hits = [
    { ats: 'greenhouse', company: 'Acme', url: 'https://g/1', title: 'Network Engineering Intern', inTracker: true, appliedRoles: ['Software Engineer Intern'], similarApplied: false },
    { ats: 'greenhouse', company: 'Acme', url: 'https://g/2', title: 'Software Engineer Intern', inTracker: true, appliedRoles: ['Software Engineer Intern'], similarApplied: true },
    { ats: 'greenhouse', company: 'Byco', url: 'https://g/3', title: 'IT Intern', inTracker: true, appliedRoles: [], similarApplied: false },
  ];
  markSkips(hits, new Set(), () => true);
  assert.strictEqual(hits[0].skip, undefined);
  assert.match(hits[1].skip, /already applied for a similar role/);
  assert.strictEqual(hits[2].skip, undefined);
});

test('codeTyped: submit once every Greenhouse code box holds a character (one site stayed blocked)', () => {
  const box = (v, i) => f(i ? 'A verification code was sent to you@x.com.' : 'Security code', { value: v, ref: '0:' + (75 + i) });
  assert.strictEqual(A.codeTyped(snap({ fields: 'BZ0HPPgd'.split('').map(box) })), true);
  assert.strictEqual(A.codeTyped(snap({ fields: 'BZ0HPPg'.split('').map(box).concat(box('', 7)) })), false);
  assert.strictEqual(A.codeTyped(snap({ fields: [f('First Name', { value: 'N' })] })), false);
});

test('code review: address only for the owner, step query kept, bad feed URL does not break discover', () => {
  const p = { profile: { addressLine1: '1 Main St' } };
  assert.strictEqual(A.profileAnswer({ label: 'Address Line 1', section: 'Emergency Contact' }, p), null);
  assert.strictEqual(A.profileAnswer({ label: 'Address Line 1', section: 'References' }, p), null);
  assert.notStrictEqual(A.uploadPage('https://x.com/apply?step=1'), A.uploadPage('https://x.com/apply?step=2'));
  const { markSkips } = require('../lib/discover');
  const hits = [{ ats: 'workday', company: 'x', url: '' }, { ats: 'greenhouse', company: 'y', url: 'https://g/1' }];
  assert.doesNotThrow(() => markSkips(hits, new Set(), () => false));
  assert.match(hits[0].skip, /bad posting URL/);
});

// Audit fixes (2026-10-08). The driver talks to the page through lib/client: stubbed here, restored after.
const C = require('../lib/client');
const Data = require('../lib/data');
async function withStubs(page, send, profile, fn) {
  const saved = { page: C.page, send: C.send, profile: Data.profile, lookup: Data.lookup };
  C.page = page;
  C.send = send;
  Data.profile = () => profile;
  Data.lookup = () => null;
  try {
    return await fn();
  } finally {
    Object.assign(C, { page: saved.page, send: saved.send });
    Object.assign(Data, { profile: saved.profile, lookup: saved.lookup });
  }
}

test('optInOutcome: never ticks an opt-in; a required box with no "no" goes to the owner', () => {
  const sms = { label: 'I agree to receive text messages about my application', kind: 'checkbox' };
  assert.deepStrictEqual(A.optInOutcome(sms, []), { skip: true });
  const req = A.optInOutcome({ ...sms, required: true, ref: '0:4' }, []);
  assert.strictEqual(req.need.type, 'opt_in_required');
  assert.match(req.need.note, /owner decides/);
  assert.deepStrictEqual(A.optInOutcome({ label: 'Text me updates (SMS)?', kind: 'radio', required: true }, ['Yes, send me texts', 'No']), { value: 'No' });
  assert.strictEqual(A.optInOutcome({ label: 'I agree to the Privacy Policy', kind: 'checkbox', required: true }, []), null, 'consent is not opt-in');
  assert.strictEqual(A.optInOutcome({ label: 'Mobile phone (we may send text messages)', kind: 'text', required: true }, []), null, 'a phone box is not a box to tick');
});

test('autoResolve: required opt-in box is never ticked, even flagged consent; privacy consent is; SMS radio gets No', async () => {
  const sets = [];
  const page = async (tabId, fn, args, frames) => {
    if (fn === 'set') sets.push(args);
    return [{ frameId: frames ? frames[0] : 0, result: fn === 'set' ? { ok: true, value: args.value } : fn === 'options' ? [] : null }];
  };
  const needs = [
    // The old page.js flagged a required opt-in as consent too: the driver must not trust that.
    { ref: '0:1', label: 'I agree to receive job alerts and marketing communications *', kind: 'checkbox', required: true, optIn: true, consent: true },
    { ref: '0:2', label: 'I agree to the privacy policy *', kind: 'checkbox', required: true, consent: true },
    { ref: '0:3', label: 'May we send you text messages about your application?', kind: 'radio', required: true, options: ['Yes, send me texts', 'No'] },
    { ref: '0:4', label: 'Sign me up for the newsletter', kind: 'checkbox', required: false, optIn: true },
  ];
  const p = { policy: { autoConsent: true, autoSubmit: true }, extras: { fullName: 'N B' }, profile: {} };
  const left = await withStubs(page, async () => [], p, () => A.autoResolve({ tabId: 1 }, needs));
  assert.deepStrictEqual(sets.map((s) => [s.ref, s.value]), [['2', 'yes'], ['3', 'No']]);
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0].ref, '0:1');
  assert.strictEqual(left[0].type, 'opt_in_required');
});

test('pressNav: Submit pressed at most twice per page while Oracle shows "You have 1 issue" (TI got 45)', async () => {
  let n = 0;
  let clicks = 0;
  const shown = () => ({
    top: true,
    url: 'https://x.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/1/apply/section/3?csrf=' + n,
    heading: 'Apply',
    fields: [{ ref: '1', label: 'Email', kind: 'text', required: true, value: 'a@b.c' }],
    // The toast's own button changes the page signature on every press, so the stuck check never fires.
    buttons: [{ ref: '9', text: 'SUBMIT' }, { ref: '8', text: `Dismiss ${n}` }],
    signals: { errors: ['You have 1 issue that needs to be fixed'] },
  });
  const page = async (tabId, fn) => {
    if (fn !== 'click') return [{ frameId: 0, result: shown() }];
    clicks++;
    n++;
    return [{ frameId: 0, result: { ok: true } }];
  };
  const send = async (cmd) => {
    if (cmd === 'spawned') return [];
    throw new Error('no ' + cmd);
  };
  const p = { policy: { autoConsent: true, autoSubmit: true }, extras: {}, profile: {} };
  const run = { tabId: 1, steps: [], uploads: {} };
  const res = await withStubs(page, send, p, async () => {
    for (let i = 0; i < 6; i++) {
      const r = await A.pressNav(run, await A.snapshot(run.tabId), p);
      if (r) return r;
    }
    return null;
  });
  assert.strictEqual(clicks, 2);
  assert.ok(res, 'stopped');
  assert.strictEqual(run.status, 'needs_input');
  assert.strictEqual(run.needs[0].type, 'validation');
  assert.deepStrictEqual(run.needs[0].errors, ['You have 1 issue that needs to be fixed']);
  assert.match(run.needs[0].excerpt, /1 issue/);
  // A continue (after a hand fix) starts the count again.
  run.submits = {};
  assert.strictEqual(A.submitCap(run, shown().url).full, false);
});

test('nav: Finish Later is never pressed; Update Profile is Next (Driftmere iCIMS, 2026-10-09)', () => {
  const s = snap({ buttons: [b('Replace Resume'), b('Finish Later', { submit: true }), b('Update Profile', { submit: true })] });
  assert.strictEqual(A.findNav(s).btn.text, 'Update Profile');
  assert.strictEqual(A.findNav(s).kind, 'next');
  const q = snap({ buttons: [b('Finish Later', { submit: true }), b('Submit', { submit: true })] });
  assert.strictEqual(A.findNav(q).btn.text, 'Submit');
  assert.strictEqual(A.findNav(snap({ buttons: [b('Save for later', { submit: true })] })), null);
});

test('how heard: "Social Media/External Job Board" covers LinkedIn (Driftmere iCIMS, 2026-10-09)', () => {
  const opts = ['— Make a Selection —', 'Company Website', 'Job Board', 'Recruiting Event', 'Social Media/External Job Board'];
  assert.strictEqual(A.howHeardAnswer({ kind: 'select', options: opts }, 'LinkedIn'), 'Social Media/External Job Board');
});

test('Workday Review step (only a footer Submit) is a form page (Coppermoor / Elmbrook, 2026-10-09)', () => {
  const s = snap({ buttons: [b('Back', { aid: 'pageFooterBackButton' }), b('Submit', { aid: 'pageFooterNextButton', submit: true })] });
  assert.strictEqual(A.classify(s), 'form');
  assert.strictEqual(A.findNav(s).kind, 'submit');
});

test('how heard: Workday "Job Advert/Job Board" covers LinkedIn (Coppermoor, 2026-10-09)', () => {
  const opts = ['Select One', 'Company Career Site', 'Former Employee', 'I know someone in the company', 'Job Advert/Job Board'];
  assert.strictEqual(A.howHeardAnswer({ kind: 'select', options: opts }, 'LinkedIn'), 'Job Advert/Job Board');
  assert.strictEqual(A.howHeardAnswer({ kind: 'select', options: ['Select One', 'Job Board  - Linkedin', 'Social Media - LinkedIn'] }, 'LinkedIn'), 'Job Board  - Linkedin');
});
test('Workday sign-in chooser (AmFam): press "Sign in with email", not Google / LinkedIn', () => {
  const s = snap({ buttons: [b('Sign In', { aid: 'utilityButtonSignIn', chrome: true }), b('Back to Job Posting', { aid: 'backToJobPosting' }), b('Sign in with Google', { aid: 'GoogleSignInButton' }), b('Sign in with LinkedIn', { aid: 'LinkedInSignInButton' }), b('Sign in with email', { aid: 'SignInWithEmailButton' })] });
  assert.strictEqual(A.classify(s), 'auth_chooser');
});
test('needs the owner answered by hand and the page holds are not asked again (AmFam)', () => {
  const q = 'Have you been previously employed by Lindenbrook or any of its affiliates?*';
  const needs = [{ ref: '0:42', label: q, kind: 'radio', required: true }, { ref: '0:43', label: 'Other', kind: 'radio', required: true }];
  const s = snap({ fields: [f(q, { kind: 'radio', value: 'No', required: true }), f('Other', { kind: 'radio', required: true })] });
  assert.deepStrictEqual(A.dropHandAnswered({ handAnswers: { [q]: 'No' } }, needs, s).map((n) => n.ref), ['0:43']);
  assert.strictEqual(A.dropHandAnswered({}, needs, s).length, 2);
  const blank = snap({ fields: [f(q, { kind: 'radio', required: true })] });
  assert.strictEqual(A.dropHandAnswered({ handAnswers: { [q]: 'No' } }, needs, blank).length, 2);
});
test('Workday footer Back is never pressed as submit (Driftgate)', () => {
  const s = snap({ buttons: [b('Back', { aid: 'pageFooterBackButton', submit: true }), b('Back to Job Posting', { aid: 'backToJobPosting' })] });
  assert.strictEqual(A.findNav(s), null);
});

test('how did you hear: owner 2026-10-09 "any option", never a stop; no referral / recruiter / employee picks', () => {
  const h = (options) => A.howHeardAnswer({ kind: 'select', options }, 'LinkedIn');
  assert.strictEqual(h(['Select One', 'LinkedIn', 'Other']), 'LinkedIn');
  assert.strictEqual(h(['Referral', 'Company Website', 'Other']), 'Company Website');
  assert.strictEqual(h(['Select One', 'Employee Referral', 'Career Fair', 'Other']), 'Other');
  assert.strictEqual(h(['Employee Referral', 'Career Fair']), 'Career Fair');
  assert.strictEqual(h(['— Make a Selection —', 'Recruiter', 'Employee Referral']), null, 'only person-sources: asked');
});

test('iCIMS confirmation: mode=submit_apply is done, a stale required certify box does not keep it open (Cedarhall 2026-10-09)', () => {
  assert.strictEqual(A.classify(snap({ url: 'https://us-careers-cedarhall.icims.com/jobs/34316/x/job?mode=submit_apply' })), 'done');
  const stale = snap({ fields: [f('I certify the above is true', { kind: 'checkbox', required: true })], signals: { confirmation: true } });
  assert.strictEqual(A.classify(stale), 'done');
  const open = snap({ fields: [f('First name', { required: true }), f('Last')], signals: { confirmation: true } });
  assert.notStrictEqual(A.classify(open), 'done', 'an empty required text field still blocks');
});

test('disabled buttons are never a way forward (Rippling Apply until every answer is in)', () => {
  assert.strictEqual(A.findNav(snap({ buttons: [b('Apply', { disabled: true })] })), null);
  assert.strictEqual(A.findNav(snap({ buttons: [b('Apply', { disabled: true }), b('Next')] })).btn.text, 'Next');
});

test('Workday footer Save and Continue counts even when the snapshot marks the button bar as chrome (UMBERMOOR)', () => {
  const s = snap({ buttons: [b('Back', { aid: 'pageFooterBackButton', chrome: true }), b('Save and Continue', { aid: 'pageFooterNextButton', chrome: true })] });
  assert.strictEqual(A.findNav(s).btn.text, 'Save and Continue');
});
