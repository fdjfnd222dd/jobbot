'use strict';
// Offline tests for lib/inbox.js (/inbox): classify, deadlines, company matching, update planning, Gmail query.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const I = require('../lib/inbox');

const E = {
  ghReject: { id: 'gh-1111aaaa', date: '2026-10-05T14:00:00Z', from: 'Embervale Recruiting <no-reply@us.greenhouse-mail.io>', subject: 'Update on your application to Embervale', snippet: 'Thank you for your interest.', body: 'Unfortunately, we have decided not to move forward with your application for the Network Engineer Intern role. We will keep your resume on file.' },
  csOA: { id: 'cs-2222bbbb', date: '2026-10-06T09:30:00Z', from: 'Glenfield <no-reply@codesignal.com>', subject: 'Glenfield: complete your CodeSignal assessment', snippet: 'You have been invited', body: 'Hi the owner, Glenfield invited you to take a CodeSignal General Assessment. Please complete it by October 14. The link expires on 10/14/2026.' },
  wdReceived: { id: 'wd-3333cccc', date: '2026-10-07T12:00:00Z', from: 'Northfield <northfield@myworkday.com>', subject: 'Thank you for applying to Northfield', snippet: 'We received your application', body: 'Thank you for applying. We have received your application for Software Engineering Intern. If your background matches we may schedule an interview.' },
  gtInterview: { id: 'gt-4444dddd', date: '2026-10-06T16:00:00Z', from: 'Elmstone Recruiting <no-reply@goodtime.io>', subject: 'Elmstone: please schedule your interview', snippet: 'Select a time', body: 'Hi the owner, we would like to schedule a video interview for the SRE Intern role. Your interview is on Tuesday, October 13 at 2:00 PM ET. Select a time if that does not work.' },
  liAlert: { id: 'li-5555eeee', date: '2026-10-07T06:00:00Z', from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>', subject: '12 new jobs for you: Network Engineer Intern', snippet: 'Embervale and others are hiring', body: 'Embervale, Glenfield, Elmstone are hiring. Unfortunately you may not see all jobs.' },
  hsDigest: { id: 'hs-6666ffff', date: '2026-10-07T06:00:00Z', from: 'Handshake <notifications@joinhandshake.com>', subject: 'Your weekly digest', snippet: 'New jobs', body: 'Jobs for you' },
  both: { id: 'bo-7777gggg', date: '2026-10-07T10:00:00Z', from: 'Lindenstone <no-reply@us.greenhouse-mail.io>', subject: 'Thank you for applying to Lindenstone', snippet: '', body: 'We received your application. Unfortunately, we are not moving forward at this time.' },
  recruiter: { id: 'rc-8888hhhh', date: '2026-10-07T10:00:00Z', from: 'Sam Lee <sam@umberfield.com>', subject: 'Opportunity at Copperfield', snippet: '', body: 'I came across your profile and am reaching out about an internship.' },
  stranger: { id: 'zz-9999iiii', date: '2026-10-07T10:00:00Z', from: 'Acme HR <hr@acmecorp.example>', subject: 'Thank you for applying', snippet: '', body: 'We received your application.' },
};

const mk = (id, company, role, status, extra) => ({ id, version: 3, data: { company, role, status, notes: '', followUp: '', ...extra } });
const ROWS = [
  mk('embervale-1', 'Embervale', 'Network Engineer Intern', 'applied'),
  mk('glenfield-1', 'Glenfield', 'SRE Intern', 'applied'),
  mk('northfield-1', 'Northfield', 'Software Engineering Intern', 'applied'),
  mk('elmstone-1', 'Elmstone', 'SRE Intern', 'assessment'),
  mk('lindenstone-1', 'Lindenstone', 'Infra Intern', 'applied'),
  mk('copperfield-1', 'Umberfield', 'Software Intern', 'applied'),
];

test('classify: each fixture kind', () => {
  const k = (e) => I.classify(e).kind;
  assert.strictEqual(k(E.ghReject), 'rejection');
  assert.strictEqual(k(E.csOA), 'oa');
  assert.strictEqual(k(E.wdReceived), 'received');
  assert.strictEqual(k(E.gtInterview), 'interview');
  assert.strictEqual(k(E.liAlert), 'noise');
  assert.strictEqual(k(E.hsDigest), 'noise');
  assert.strictEqual(k(E.recruiter), 'recruiter');
  assert.strictEqual(k({ from: 'x@y.com', subject: 'hello', snippet: 'lunch?' }), 'other');
});

test('classify: rejection beats received; a confirmation mentioning an interview stays received', () => {
  assert.strictEqual(I.classify(E.both).kind, 'rejection');
  assert.strictEqual(I.classify(E.wdReceived).kind, 'received');
});

test('classify: other rejection phrasings and vendors', () => {
  assert.strictEqual(I.classify({ from: 'a@b.com', subject: 'Your application', body: 'We have chosen to pursue other candidates.' }).kind, 'rejection');
  assert.strictEqual(I.classify({ from: 'a@b.com', subject: 'Your candidacy', body: 'You will not be moving forward in the process' }).kind, 'rejection');
  assert.strictEqual(I.classify({ from: 'x@hackerrank.com', subject: 'Test invitation', body: 'Complete your test' }).kind, 'oa');
  assert.strictEqual(I.classify({ from: 'a@b.com', subject: 'Next step: online assessment', body: 'Please complete your assessment.' }).kind, 'oa');
  assert.strictEqual(I.classify({ from: 'a@b.com', subject: 'Chat?', body: 'Book a time on calendly.com/x' }).kind, 'interview');
});

test('classify: LinkedIn application confirmation is received, not noise', () => {
  const c = I.classify({ from: 'LinkedIn <jobs-noreply@linkedin.com>', subject: 'Your application was sent to Elmstone', body: '' });
  assert.strictEqual(c.kind, 'received');
});

test('deadlines: absolute, numeric, relative, none', () => {
  assert.strictEqual(I.classify(E.csOA).deadline, '2026-10-14');
  const d = (text, date) => I.extractDeadline(text, new Date(date || '2026-10-07T00:00:00Z'));
  assert.strictEqual(d('Please finish by October 14, 2026').date, '2026-10-14');
  assert.strictEqual(d('The link expires on 10/14/2026').date, '2026-10-14');
  assert.strictEqual(d('due by Oct 20th').date, '2026-10-20');
  assert.strictEqual(d('complete by 20 October').date, '2026-10-20');
  assert.strictEqual(d('within 7 days of this email').date, '2026-10-14');
  assert.strictEqual(d('within 48 hours').date, '2026-10-09');
  assert.strictEqual(d('by January 5', '2026-12-20T00:00:00Z').date, '2027-01-05'); // rolls into next year
  assert.strictEqual(d('by February 31'), null);
  assert.strictEqual(d('no dates here'), null);
});

test('deadlines: interview time is captured', () => {
  const c = I.classify(E.gtInterview);
  assert.strictEqual(c.deadline, '2026-10-13');
  assert.strictEqual(c.deadlineTime, '14:00');
});

test('matchCompany: ATS display name, ATS tenant sender, own domain, subject', () => {
  const id = (e) => { const r = I.matchCompany(e, ROWS); return r && r.id; };
  assert.strictEqual(id(E.ghReject), 'embervale-1');
  assert.strictEqual(id(E.csOA), 'glenfield-1'); // vendor sender, company in subject
  assert.strictEqual(id(E.wdReceived), 'northfield-1'); // tenant@myworkday.com
  assert.strictEqual(id(E.gtInterview), 'elmstone-1');
  assert.strictEqual(id(E.recruiter), 'copperfield-1'); // umberfield.com vs "Umberfield"
});

test('matchCompany: null for strangers, ambiguity and generic noise', () => {
  assert.strictEqual(I.matchCompany(E.stranger, ROWS), null);
  const amb = { from: 'x@us.greenhouse-mail.io', subject: 'Update', body: 'Embervale and Glenfield both reached out' };
  assert.strictEqual(I.matchCompany(amb, ROWS), null);
  // two rows, same company: role breaks the tie, otherwise null
  const two = [mk('a1', 'Embervale', 'Network Engineer Intern', 'applied'), mk('a2', 'Embervale', 'Security Analyst Intern', 'applied')];
  assert.strictEqual(I.matchCompany(E.ghReject, two).id, 'a1');
  assert.strictEqual(I.matchCompany({ from: 'Embervale <no-reply@greenhouse.io>', subject: 'Update', body: 'sorry' }, two), null);
});

test('matchCompany: aliases and short forms', () => {
  const rows = [mk('b1', 'Bank of America', 'Tech Intern', 'applied'), mk('f1', 'Lindenwick', 'Cyber Intern', 'applied')];
  assert.strictEqual(I.matchCompany({ from: 'Careers <no-reply@myworkday.com>', subject: 'BofA application received', body: '' }, rows).id, 'b1');
  assert.strictEqual(I.matchCompany({ from: 'x@lindenwick.com', subject: 'Hello', body: '' }, rows).id, 'f1');
});

test('plan: updates by kind, versions carried, deadline to followUp', () => {
  const ups = I.plan([E.ghReject, E.csOA, E.wdReceived, E.gtInterview, E.liAlert], ROWS, { today: '2026-10-07' });
  const by = Object.fromEntries(ups.map((u) => [u.rowId, u]));
  assert.strictEqual(ups.length, 4); // alert dropped
  assert.strictEqual(by['embervale-1'].set.status, 'rejected');
  assert.strictEqual(by['embervale-1'].version, 3);
  assert.strictEqual(by['glenfield-1'].set.status, 'assessment');
  assert.strictEqual(by['glenfield-1'].set.followUp, '2026-10-14');
  assert.strictEqual(by['northfield-1'].set.status, undefined); // received on "applied": note only
  assert.match(by['northfield-1'].set.notes, /Application received/);
  assert.strictEqual(by['elmstone-1'].set.status, 'interviewing'); // assessment -> interviewing (tracker enum)
  assert.strictEqual(by['elmstone-1'].set.followUp, '2026-10-13');
});

test('plan: never downgrades; received after interview is a note only', () => {
  const rows = [mk('northfield-1', 'Northfield', 'SWE Intern', 'interview')];
  const [u] = I.plan([E.wdReceived], rows, { today: '2026-10-07' });
  assert.strictEqual(u.set.status, undefined);
  const rows2 = [mk('glenfield-1', 'Glenfield', 'SRE', 'Interviewing')]; // free-form status normalised
  const [u2] = I.plan([E.csOA], rows2, { today: '2026-10-07' });
  assert.strictEqual(u2.set.status, undefined);
});

test('plan: interview after a rejection leaves status rejected and flags it', () => {
  const rows = [mk('elmstone-1', 'Elmstone', 'SRE Intern', 'rejected')];
  const [u] = I.plan([E.gtInterview], rows, { today: '2026-10-07' });
  assert.strictEqual(u.set.status, undefined);
  assert.match(u.set.notes, /after a rejection/);
});

test('plan: rejection clears followUp but never beats an offer', () => {
  const [u] = I.plan([E.ghReject], [mk('embervale-1', 'Embervale', 'NE', 'interview', { followUp: '2026-10-10' })], { today: '2026-10-07' });
  assert.strictEqual(u.set.status, 'rejected');
  assert.strictEqual(u.set.followUp, '');
  const [o] = I.plan([E.ghReject], [mk('embervale-1', 'Embervale', 'NE', 'offer')], { today: '2026-10-07' });
  assert.strictEqual(o.set.status, undefined);
});

test('plan: notes are appended, dated, and idempotent', () => {
  const rows = [mk('embervale-1', 'Embervale', 'NE', 'applied', { notes: 'Applied with jobbot.' })];
  const [u] = I.plan([E.ghReject], rows, { today: '2026-10-07' });
  assert.ok(u.set.notes.startsWith('Applied with jobbot. | [inbox 2026-10-07] Rejection'));
  assert.ok(!u.set.notes.includes('Unfortunately')); // no body text copied in
  // run again over a row that already carries the tag: nothing to do
  rows[0].data.notes = u.set.notes;
  rows[0].data.status = 'rejected';
  assert.deepStrictEqual(I.plan([E.ghReject], rows, { today: '2026-10-08' }), []);
});

test('plan: two emails for one row fold into one update in date order', () => {
  const rows = [mk('elmstone-1', 'Elmstone', 'SRE Intern', 'applied')];
  const oa = { ...E.csOA, id: 'af-oa-000001', from: 'Elmstone <no-reply@codesignal.com>', subject: 'Elmstone CodeSignal assessment' };
  const ups = I.plan([E.gtInterview, oa], rows, { today: '2026-10-07' });
  assert.strictEqual(ups.length, 1);
  assert.strictEqual(ups[0].set.status, 'interviewing');
  assert.strictEqual(ups[0].emails.length, 2);
});

test('planAll: counts, unmatched and sorted deadlines', () => {
  const r = I.planAll([E.stranger, E.gtInterview, E.csOA, E.liAlert, E.ghReject], ROWS, { today: '2026-10-07' });
  assert.strictEqual(r.counts.noise, 1);
  assert.strictEqual(r.counts.rejection, 1);
  assert.deepStrictEqual(r.unmatched.map((u) => u.id), ['zz-9999iiii']);
  assert.deepStrictEqual(r.deadlines.map((d) => d.date), ['2026-10-13', '2026-10-14']);
  assert.strictEqual(r.deadlines[0].company, 'Elmstone');
});

test('plan: flat rows (no data wrapper) and missing fields are tolerated', () => {
  const [u] = I.plan([E.ghReject], [{ doc_id: 'c', version: 9, company: 'Embervale', role: 'NE', status: 'applied' }], { today: '2026-10-07' });
  assert.strictEqual(u.rowId, 'c');
  assert.strictEqual(u.version, 9);
  assert.deepStrictEqual(I.plan([{ id: 'q' }], [{ id: 'x' }]), []);
});

test('buildQuery: since lastCheck, default 14 days, excludes alerts', () => {
  const now = new Date(2026, 9, 7, 12, 0, 0);
  assert.match(I.buildQuery({ lastCheck: new Date(2026, 9, 3, 8).toISOString() }, now), /^after:2026\/10\/03 /);
  assert.match(I.buildQuery({}, now), /^after:2026\/09\/23 /);
  assert.match(I.buildQuery({ lastCheck: 'garbage' }, now), /^after:2026\/09\/23 /);
  assert.match(I.buildQuery({ lastCheck: new Date(2027, 0, 1).toISOString() }, now), /^after:2026\/09\/23 /); // future: ignore
  const q = I.buildQuery({}, now);
  for (const s of ['greenhouse.io', 'myworkday.com', 'ashbyhq.com', 'lever.co', 'codesignal.com', '-category:promotions', 'jobalerts-noreply@linkedin.com', 'joinhandshake.com']) assert.ok(q.includes(s), s);
});

test('loadRows: file, wrapped list and directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-'));
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ docs: [ROWS[0], ROWS[1]] }));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(ROWS[2]));
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ unrelated: true }));
  assert.strictEqual(I.loadRows(dir).length, 3);
  assert.strictEqual(I.loadRows(path.join(dir, 'a.json')).length, 2);
});

test('jobctl inbox-query and inbox-plan run offline', () => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-'));
  fs.writeFileSync(path.join(dir, 'emails.json'), JSON.stringify([E.ghReject]));
  fs.writeFileSync(path.join(dir, 'rows.json'), JSON.stringify(ROWS));
  const env = { ...process.env, JOBBOT_DATA: dir };
  const q = spawnSync('node', [path.join(__dirname, '../bin/jobctl'), 'inbox-query'], { env, encoding: 'utf8' });
  assert.match(q.stdout, /after:/);
  const p = spawnSync('node', [path.join(__dirname, '../bin/jobctl'), 'inbox-plan', path.join(dir, 'emails.json'), path.join(dir, 'rows.json')], { env, encoding: 'utf8' });
  assert.strictEqual(JSON.parse(p.stdout).updates[0].rowId, 'embervale-1');
  const d = spawnSync('node', [path.join(__dirname, '../bin/jobctl'), 'inbox-done'], { env, encoding: 'utf8' });
  assert.ok(fs.existsSync(path.join(dir, 'inbox-state.json')), d.stderr);
});

test('loadRows: ArtifactData out_dir files (plain fields, id in the file name) keep their ids (2026-10-08 merged every email into one row)', () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rows-'));
  fs.writeFileSync(path.join(dir, 'brightco-2000262.json'), JSON.stringify({ company: 'Brightco', role: 'Support Engineer I (Intern)', reqId: '2000262', status: 'applied', notes: '' }));
  fs.writeFileSync(path.join(dir, 'northfield-cloud-security-intern.json'), JSON.stringify({ company: 'Northfield', role: 'Cloud Security Intern', status: 'applied', notes: '' }));
  const rows = I.loadRows(dir);
  assert.deepStrictEqual(rows.map(I.rowId).sort(), ['brightco-2000262', 'northfield-cloud-security-intern']);
  const ups = I.plan([{ id: 'm1', date: '2026-10-06T16:16:33Z', from: 'Brightco@myworkday.com', subject: 'Entry-level Talent Recruiting - Brightco Application Status Update', bodyExcerpt: 'Thank you for applying to the FY26 Support Engineer I (Intern) - United States (Req. 2000262) position at Cisco. Currently, we have a large pool of candidates and are unable to move you forward to the next step in the recruiting process.' }], rows, { today: '2026-10-08' });
  assert.strictEqual(ups.length, 1);
  assert.strictEqual(ups[0].rowId, 'brightco-2000262');
  assert.strictEqual(ups[0].set.status, 'rejected', '"unable to move you forward" is a rejection');
});
