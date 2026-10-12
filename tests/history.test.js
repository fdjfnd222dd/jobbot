'use strict';
// lib/history.js: iCIMS work history rewritten from the tailored resume (Driftmere / Thorngate, 2026-10-08).
// Field lists are the real snapshots of those two forms (values as the resume parser left them).
const test = require('node:test');
const assert = require('node:assert');
const H = require('../lib/history');

const resume = {
  experience: [
    { company: 'Quillstone', location: 'Smithtown, NC', title: 'Systems Reliability Engineer Intern (SRE)', dates: 'Jun 2026 - Aug 2026', bullets: ['Troubleshot clusters', 'Shipped an integration'] },
    { company: 'Gamma Project (Civic Lab, Civic Org)', location: 'Springfield, VA', title: 'Software Engineer', dates: 'Jan 2026 - Present', bullets: ['Built Gamma Project'] },
    { company: 'Example State University', location: 'Springfield, VA', title: 'Research Assistant, Industrial Cybersecurity', dates: 'Nov 2025 - Present', bullets: ['Built a twin'] },
    { company: 'Example State University', location: 'Springfield, VA', title: 'Research Assistant, Quantum Risk Modeling', dates: 'Aug 2026 - Present', bullets: ['Build attack graphs'] },
  ],
};
const profile = { profile: { school: 'Example State University', degree: 'Bachelor of Science', major: 'Information Technology', minor: 'Robotics', gradMonth: '12', gradYear: '2099' }, extras: { gpa: '3.7' } };

let n = 0;
const F = (label, value, kind) => ({ ref: '7:' + ++n, label, value: value || '', kind: kind || (/Country|State/.test(label) ? 'combobox' : /Month|Day/.test(label) ? 'select' : 'text') });
const driftmereBlock = (emp, title, city, m1, y1, m2, y2) => [F('Employer', emp), F('Title', title), F('Country'), F('City', city), F('State'), F('Month', m1), F('Day', '1'), F('Year', y1), F('Month', m2), F('Day', m2 ? '1' : ''), F('Year', y2)];

test('Driftmere: scrambled employers / titles / places rewritten, junk 5th block deleted', () => {
  n = 0;
  const fields = [F('First Name', 'Pat'), F('City', 'Shoreville'), F('Country', 'United States'),
    ...driftmereBlock('SRE', 'Systems Reliability Engineer', 'Shoreville', 'Jun', '2026', 'Aug', '2026'),
    ...driftmereBlock('Civic Org', 'Glean and Life Cycle Manager', 'Springfield', 'Jan', '2026', '', ''),
    ...driftmereBlock('ICS', 'Research Assistant', 'Shoreville', 'Nov', '2025', '', ''),
    ...driftmereBlock('Large-scale Data Center Threat', 'Research Assistant', 'Shoreville', 'Aug', '2026', '', ''),
    ...driftmereBlock('', '', 'Shoreville', 'Jan', '2026', 'Jan', '2026'),
    F('Would you like to receive SMS Text Messages?', '', 'combobox')];
  const buttons = [{ ref: '7:88', text: 'Delete Professional Experience (5)' }, { ref: '7:89', text: 'Create Profile' }];
  const plan = H.planHistory(fields, buttons, resume, profile);
  const byLabel = (label, i) => plan.sets.filter((s) => s.label === label)[i];
  assert.strictEqual(byLabel('Employer', 0).value, 'Quillstone');
  assert.strictEqual(byLabel('Title', 0).value, 'Systems Reliability Engineer Intern', '(SRE) is a resume abbreviation');
  assert.strictEqual(byLabel('City', 0).value, 'Smithtown');
  assert.strictEqual(byLabel('State', 0).value, 'North Carolina');
  assert.strictEqual(byLabel('Employer', 1).value, 'Gamma Project (Civic Lab)', 'the Civic Org is the customer, never the employer');
  assert.strictEqual(byLabel('Employer', 2).value, 'Example State University');
  assert.strictEqual(byLabel('Title', 3).value, 'Research Assistant, Quantum Risk Modeling');
  assert.deepStrictEqual(plan.deletes, ['Delete Professional Experience (5)']);
  assert.ok(!plan.sets.some((s) => /SMS|First Name/.test(s.label)), 'nothing outside the blocks');
  assert.ok(!plan.sets.some((s) => s.value === 'Shoreville'), 'home city never written into a job');
});

test('Thorngate: description from the bullets, education row fixed, second row deleted', () => {
  n = 0;
  const atl = (emp, title, desc) => [F('Employer', emp), F('Address'), F('City'), F('Zip'), F('Country'), F('State'), F('Title', title), F('Month'), F('Day'), F('Year'), F('Month'), F('Day'), F('Year'), F('Description', desc, 'textarea')];
  const fields = [
    F('School', 'EXAMPLE STATE UNIVERSITY', 'combobox'), F('School/Institution'), F('Degree', 'Masters', 'combobox'), F('Major', '', 'combobox'), F('GPA'), F('Minor'), F('Did You Graduate?', '', 'select'),
    F('School', 'EXAMPLE STATE UNIVERSITY', 'combobox'), F('School/Institution'), F('Degree', 'Bachelors', 'combobox'), F('Major', '', 'combobox'), F('GPA'), F('Minor'), F('Did You Graduate?', 'Yes', 'select'),
    ...atl('Civic Org', 'Glean and Life Cycle Manager', 'Shipped a Glean ... Gamma Project (Civic Lab, Civic Org) Software Engineer'),
    F('Have you ever been employed at Thorngate?', '', 'combobox'),
  ];
  const buttons = [{ ref: '7:108', text: 'Delete Education (2)' }];
  const plan = H.planHistory(fields, buttons, resume, profile);
  const v = (label) => (plan.sets.find((s) => s.label === label) || {}).value;
  assert.strictEqual(v('Employer'), 'Quillstone');
  assert.strictEqual(v('Description'), '- Troubleshot clusters\n- Shipped an integration');
  assert.strictEqual(v('Degree'), 'Bachelors');
  assert.strictEqual(v('Major'), 'Information Technology');
  assert.strictEqual(v('GPA'), '3.7');
  assert.strictEqual(v('Did You Graduate?'), 'No');
  assert.deepStrictEqual(plan.deletes, ['Delete Education (2)']);
  assert.ok(!plan.sets.some((s) => /Address|Zip|Thorngate/.test(s.label)), 'employer address and questions left alone');
});

test('nothing to do on a form without Employer + Title blocks; dates and places parse', () => {
  assert.deepStrictEqual(H.planHistory([F('Current company', 'Gamma Project')], [], resume, profile).sets, []);
  assert.deepStrictEqual(H.monthYear('Jun 2026'), { month: 'Jun', day: '1', year: '2026' });
  assert.strictEqual(H.monthYear('Present'), null);
  assert.deepStrictEqual(H.place('Springfield, VA'), { city: 'Springfield', state: 'Virginia' });
});

test('code review: present jobs lose a parsed end date, a trailing Date Available is not a job date, the school row is found by name', () => {
  n = 0;
  const fields = [
    F('School', 'Some High School', 'combobox'), F('Degree', 'High School', 'combobox'),
    F('School', 'EXAMPLE STATE UNIVERSITY', 'combobox'), F('Degree', 'Masters', 'combobox'), F('Did You Graduate?', 'Yes', 'select'),
    F('Employer', 'SRE'), F('Title', 'x'), F('Month', 'Jun'), F('Day', '1'), F('Year', '2026'), F('Month', 'Aug'), F('Day', '1'), F('Year', '2026'),
    F('Employer', 'Civic Org'), F('Title', 'y'), F('Month', 'Jan'), F('Day', '1'), F('Year', '2026'), F('Month', 'Jan'), F('Day', '1'), F('Year', '2026'),
    F('Month', ''), F('Day', ''), F('Year', ''), // "Date Available" right after the last block
  ];
  const plan = H.planHistory(fields, [{ ref: '7:90', text: 'Delete Education (2)' }, { ref: '7:91', text: 'Delete Education (1)' }], resume, profile);
  const avail = fields.slice(-3).map((f) => f.ref);
  assert.ok(!plan.sets.some((s) => avail.includes(s.ref)), 'Date Available untouched');
  const lastBlockEnd = fields.slice(-6, -3).filter((f) => f.value).map((f) => f.ref);
  assert.deepStrictEqual(plan.clears.map((c) => c.ref).sort(), lastBlockEnd.sort(), 'Gamma Project (Present) end date cleared');
  const deg = plan.sets.find((s) => s.label === 'Degree');
  assert.strictEqual(deg.ref, fields[3].ref, 'the EXU row, not the high-school row');
  assert.deepStrictEqual(plan.deletes, [], 'a different school is never deleted');
  const en = H.planHistory([F('Employer', 'SRE'), F('Title', 'x'), F('Month', ''), F('Day', ''), F('Year', '')], [], { experience: [{ ...resume.experience[0], dates: 'Jun 2026 – Aug 2026' }] }, profile);
  assert.strictEqual((en.sets.find((s) => s.label === 'Month') || {}).value, 'Jun', 'en dash dates parse');
  assert.strictEqual(H.resumeJsonFor('/nonexistent/x.pdf', '/nonexistent'), null);
});

test('Ravenhaven: Other School and Major/Area of Study stay in the education block; five parsed blocks rewritten', () => {
  n = 0;
  const cg = (emp, city, title, m1, y1, m2, y2, desc) => [F('Employer', emp), F('City', city), F('State'), F('Title', title), F('Month', m1), F('Day', m1 ? '1' : ''), F('Year', y1), F('Month', m2), F('Day', m2 ? '1' : ''), F('Year', y2), F('Description', desc, 'textarea'), F('Reason for Leaving', '', 'textarea'), F('May We Contact', '', 'combobox')];
  const fields = [
    F('School', 'Example State University', 'combobox'), F('Other School (if not listed)'), F('Degree', 'Masters', 'combobox'), F('Major/Area of Study', '', 'combobox'), F('GPA'), F('Minor'),
    F('Month', 'Dec'), F('Day', '1'), F('Year', '2027'), F('City', 'Springfield'), F('Country', 'United States'), F('State', 'Virginia'),
    ...cg('Civic Org', 'Springfield', 'Software Engineer', 'Jan', '2026', '', '', 'Gamma Project (Civic Lab, Civic Org) -------'),
    ...cg('Quantum Risk Modeling', '', 'Research Assistant', 'Aug', '2026', '', '', ''),
    ...cg('', 'Quillstone', '', 'Jan', '2026', 'Jan', '2026', ''),
    ...cg('SRE', '', 'Systems Reliability Engineer', 'Jun', '2026', 'Aug', '2026', ''),
    ...cg('ICS', '', 'Research Assistant', 'Nov', '2025', '', '', ''),
    F('Reference First Name'),
  ];
  const plan = H.planHistory(fields, [{ ref: '7:200', text: 'Delete Professional Experience (5)' }], resume, profile);
  const v = (label, i = 0) => (plan.sets.filter((s) => s.label === label)[i] || {}).value;
  assert.strictEqual(v('Degree'), 'Bachelors');
  assert.strictEqual(v('Major/Area of Study'), 'Information Technology');
  assert.strictEqual(v('GPA'), '3.7');
  assert.deepStrictEqual(plan.sets.filter((s) => s.label === 'Employer').map((s) => s.value),
    ['Quillstone', 'Gamma Project (Civic Lab)', 'Example State University', 'Example State University']);
  assert.strictEqual(v('City', 1), 'Springfield', 'the junk block\'s City "Quillstone" becomes the job\'s city');
  assert.deepStrictEqual(plan.deletes, ['Delete Professional Experience (5)']);
  assert.deepStrictEqual(plan.note, []);
  assert.ok(!plan.sets.some((s) => /Reason|May We|Reference|Other School/.test(s.label)));
});

test('Pinecrest: bracketed notes in labels, EXU as Other + Other School, Did You Graduate fixed', () => {
  n = 0;
  const fields = [
    F('School (If not applicable, select Other)', 'Other', 'combobox'), F('Other School (if not in school picklist)', 'Example State University'),
    F('Degree (If not applicable, select Other)', 'Masters', 'combobox'), F('Major', '', 'combobox'), F('Did You Graduate?', 'Yes', 'select'),
    F('Month', ''), F('Day', ''), F('Year', ''), F('Month', 'Dec'), F('Day', '1'), F('Year', '2027'), F('Country', 'United States'),
  ];
  const plan = H.planHistory(fields, [], resume, profile);
  const v = (label) => (plan.sets.find((s) => s.label === label) || {}).value;
  assert.strictEqual(v('Degree'), 'Bachelors');
  assert.strictEqual(v('Major'), 'Information Technology');
  assert.strictEqual(v('Did You Graduate?'), 'No');
  assert.strictEqual(H.blocks(fields)[0].fields.length, fields.length, 'one education block holds every field');
});

test('workdayJunkBlocks: a project parsed as a 5th work block is deleted (Elmbrook, 2026-10-09)', () => {
  const { workdayJunkBlocks } = require('../lib/history');
  const resume = {
    experience: [{ company: 'Gamma Project (Civic Lab, Civic Org)' }, { company: 'Quillstone' }, { company: 'Example State University' }],
    projects: [{ name: 'Widget Engine, Open Source Contributor' }, { name: 'Threat Intelligence Pipeline' }],
  };
  const f = (label, value, ref) => ({ label, value, ref });
  const fields = [
    f('Job Title*', 'Software Engineer', '0:35'), f('Company*', 'Gamma Project', '0:36'),
    f('Job Title*', 'Systems Reliability Engineer Intern', '0:39'), f('Company*', 'Quillstone', '0:40'),
    f('Job Title*', 'Research Assistant', '0:43'), f('Company*', 'Example State University', '0:44'),
    f('Job Title*', 'Research Assistant', '0:47'), f('Company*', 'Example State University', '0:48'),
    f('Job Title*', '', '0:51'), f('Company*', 'Threat Intelligence Pipeline', '0:52'),
  ];
  const buttons = ['0:57', '0:59', '0:62', '0:64', '0:66', '0:78'].map((ref) => ({ ref, text: 'Delete' })).concat([{ ref: '0:72', text: 'Delete PatExample_Resume_Elmbrook.pdf' }]);
  assert.deepStrictEqual(workdayJunkBlocks(fields, buttons, resume), ['0:66']);
  assert.deepStrictEqual(workdayJunkBlocks(fields.slice(0, 8), buttons, resume), []);
});

/* Every application lists the real jobs / school / certifications (the owner, 2026-10-09). */
const master = {
  education: { school: 'Example State University', location: 'Springfield, VA', degree: 'Bachelor of Science in Information Technology', date: 'Dec 2027' },
  experience: [
    { company: 'Quillstone', location: 'Smithtown, NC', title: 'Systems Reliability Engineer Intern (SRE)', dates: 'Jun 2026 - Aug 2026', bullets: ['A', 'B'] },
    { company: 'Example State University', location: 'Springfield, VA', title: 'Research Assistant, Quantum Risk Modeling', dates: 'Aug 2026 - Present', bullets: ['C'] },
    { company: 'Example State University', location: 'Springfield, VA', title: 'Research Assistant, Grant-Funded Industrial Cybersecurity', dates: 'Nov 2025 - Present', bullets: ['D'] },
    { company: 'Gamma Project (Civic Lab, Civic Org)', location: 'Springfield, VA', title: 'Software Engineer', dates: 'Jan 2026 - Present', bullets: ['E'] },
  ],
  certifications: [
    { label: 'Quillstone: ', text: 'VCM-A, VCP-A 6.10, VCP-B 6.10, VSS', date: '2026' },
    { label: 'CompTIA: ', text: 'Security+, Network+', date: '2025 - 2026' },
    { label: 'Eagle Scout, ', text: '200-hour community service project leading 20 Scouts', date: 'Jul 2023' },
  ],
};
const prof2 = { profile: { ...profile.profile, gradYear: '2027' }, extras: { gpa: '3.7', eduStart: 'Aug 2023' } };

test('form facts: employer without the Civic Org, SRE title spelled out, current jobs have no end, CompTIA certs first, no Eagle Scout', () => {
  const f = H.formFacts(master, prof2);
  assert.deepStrictEqual(f.work.map((j) => [j.company, j.title, j.current, j.from.mm + '/' + j.from.year, j.to && j.to.mm]), [
    ['Quillstone', 'Systems Reliability Engineer Intern', false, '06/2026', '08'],
    ['Example State University', 'Research Assistant, Quantum Risk Modeling', true, '08/2026', null],
    ['Example State University', 'Research Assistant, Grant-Funded Industrial Cybersecurity', true, '11/2025', null],
    ['Gamma Project (Civic Lab)', 'Software Engineer', true, '01/2026', null],
  ]);
  assert.strictEqual(f.work[1].short, 'Research Assistant');
  assert.deepStrictEqual(f.cert.map((c) => c.name), ['CompTIA Security+', 'CompTIA Network+', 'Quillstone VCM-A', 'Quillstone VCP-A 6.10', 'Quillstone VCP-B 6.10', 'Quillstone VSS']);
  const e = f.edu[0];
  assert.deepStrictEqual([e.school, e.bachelor, e.major, e.gpa, e.from.name, e.from.year, e.to.name, e.to.year, e.graduated], ['Example State University', true, 'Information Technology', '3.7', 'August', '2023', 'December', '2027', false]);
  assert.strictEqual(H.formEmployer('Gamma Project (Civic Org)'), 'Gamma Project');
});

test('IRONFIELD iCIMS: a block that starts at Title with "Employer name" is a job; Add for the missing ones; education start + grad dates', () => {
  n = 0;
  const date = (m, d, y) => [F('Month', m, 'select'), F('Day', d, 'select'), F('Year', y)];
  const fields = [
    F('School', 'EXAMPLE STATE UNIVERSITY', 'combobox'), F('Degree', 'Masters', 'select'), ...date('', '', ''), ...date('Dec', '1', '2027'), F('Did You Graduate?', '', 'select'),
    F('Title*', 'Research Assistant'), F('Employer name', 'Large-scale Data Center Threat Mo'), F('City'), F('Country', '', 'select'), F('State', '', 'select'),
    ...date('Aug', '1', '2026'), ...date('', '', ''), F('Description of work', 'Large-scale ... -------', 'textarea'),
    F('Title', 'Mr', 'select'), F('First Name', 'Pat'),
  ];
  const plan = H.planHistory(fields, [{ ref: '7:300', text: 'Add Work Experience' }], master, prof2);
  const v = (label, i = 0) => (plan.sets.filter((s) => s.label === label)[i] || {}).value;
  assert.strictEqual(v('Title'), 'Systems Reliability Engineer Intern');
  assert.strictEqual(v('Employer name'), 'Quillstone');
  assert.strictEqual(v('Description of work'), '- A\n- B');
  assert.strictEqual(plan.adds, 3);
  assert.strictEqual(plan.addButton, 'Add Work Experience');
  assert.strictEqual(H.blocks(fields).filter((b) => b.kind === 'exp').length, 1, 'the salutation "Title" is no job');
  const at = (f) => (plan.sets.find((s) => s.ref === f.ref) || {}).value;
  assert.deepStrictEqual([at(fields[2]), at(fields[3]), at(fields[4])], ['Aug', '1', '2023'], 'education start Aug 2023 (typed by hand on the IRONFIELD run)');
  assert.deepStrictEqual([at(fields[5]), at(fields[7])], [undefined, undefined], 'the expected graduation already reads Dec 2027');
  assert.strictEqual(v('Did You Graduate?'), 'No');
  assert.strictEqual(v('Degree'), 'Bachelors');
  // No block, no add button: nothing to do, as before.
  assert.strictEqual(H.planHistory([F('First Name', 'x')], [], master, prof2).adds, 0);
});

test('nextRepeaterAction: empty Workday section -> Add; Oracle junk tiles deleted, then Add; a stray open form is cancelled; never loops', () => {
  const facts = H.formFacts(master, prof2);
  // Workday: no work panels yet.
  let memo = {};
  const wd = [{ kind: 'work', ats: 'workday', add: '0:9', entries: [], open: null }, { kind: 'cert', ats: 'workday', add: '0:10', entries: [], open: null }];
  assert.deepStrictEqual(H.nextRepeaterAction(wd, facts, memo), { do: 'click', ref: '0:9', why: 'add', kind: 'work', item: 0, note: 'Systems Reliability Engineer Intern @ Quillstone' });
  // Unchanged page: Add again for the same job only a bounded number of times, Workday certifications never.
  let k = 0;
  while (H.nextRepeaterAction(wd, facts, memo) && k < 50) k++;
  assert.ok(k < 10, 'terminates: ' + k);
  // Oracle: two "Unnamed License" tiles with made-up dates are deleted (last first) before any cert is added.
  memo = {};
  const tile = (title, del) => ({ title, subtitle: '', invalid: true, del, edit: del + 'e', fields: [] });
  const ora = [{ kind: 'cert', ats: 'oracle', add: '0:50', entries: [tile('Unnamed License', '0:41'), tile('Unnamed License', '0:42')], open: null }];
  assert.strictEqual(H.nextRepeaterAction(ora, facts, memo).ref, '0:42');
  assert.strictEqual(H.nextRepeaterAction(ora, facts, memo).ref, '0:41');
  const add = H.nextRepeaterAction([{ ...ora[0], entries: [] }], facts, memo);
  assert.deepStrictEqual([add.why, add.item, add.note], ['add', 0, 'CompTIA Security+']);
  // Oracle education tile "Unnamed Major" at EXU: Edit it (it is the school's entry), never delete it.
  memo = {};
  const edu = [{ kind: 'edu', ats: 'oracle', add: '0:60', entries: [{ title: 'Unnamed Major', subtitle: 'Example State University', invalid: true, del: '0:61', edit: '0:62', fields: [] }], open: null }];
  assert.deepStrictEqual([H.nextRepeaterAction(edu, facts, memo).why, memo.pending.edu], ['edit', 0]);
  // A right tile is left alone.
  assert.strictEqual(H.nextRepeaterAction([{ ...edu[0], entries: [{ title: 'Information Technology', subtitle: 'Example State University', invalid: false, del: '0:61', edit: '0:62', fields: [] }] }], facts, {}), null);
  // An open form that is none of the facts: Cancel once.
  memo = {};
  const stray = [{ kind: 'work', ats: 'oracle', add: null, entries: [], open: { fields: [{ ref: '0:70', label: 'Employer Name', kind: 'text', value: 'Acme' }], save: '0:71', cancel: '0:72' } }];
  assert.strictEqual(H.nextRepeaterAction(stray, facts, memo).ref, '0:72', 'Acme names no job: Cancel');
  assert.strictEqual(H.nextRepeaterAction(stray, facts, memo), null, 'once');
});

test('two EXU "Research Assistant" entries keep their own facts: the start date decides (DUNVALE 2026-10-09)', () => {
  const facts = H.formFacts(resume, profile);
  const ot = facts.work.findIndex((w) => /Industrial/.test(w.title));
  const dc = facts.work.findIndex((w) => /Quantum/.test(w.title));
  // Workday My Experience as "Use My Last Application" left it: both titles shortened, dates right, page order Aug 2026 first.
  const wdEntry = (from, ref) => ({ fields: [
    { ref: ref + 'a', key: 'jobTitle', label: 'Job Title', value: 'Research Assistant', kind: 'text' },
    { ref: ref + 'b', key: 'companyName', label: 'Company', value: 'Example State University', kind: 'text' },
    { ref: ref + 'c', key: 'startDate', label: 'From', value: from, kind: 'date' },
  ] });
  assert.deepStrictEqual(H.assign([wdEntry('08/2026', '1'), wdEntry('11/2025', '2')], facts.work, 'work'), [dc, ot]);
  assert.deepStrictEqual(H.assign([wdEntry('11/2025', '1'), wdEntry('08/2026', '2')], facts.work, 'work'), [ot, dc]);
  // Month + Year boxes (iCIMS / Greenhouse) work the same way.
  const split = (mon, yr) => ({ fields: [F('Employer', 'Example State University'), F('Title', 'Research Assistant'), F('Start Month', mon), F('Start Year', yr)] });
  assert.deepStrictEqual(H.assign([split('Aug', '2026'), split('Nov', '2025')], facts.work, 'work'), [dc, ot]);
});

test('form certs from the 2026-10-12 resume: exam codes dropped, names inside parentheses split, courses left out', () => {
  const r = { certifications: [
    { label: 'Quillstone: ', text: 'Certified Master (VCM-A), Certified Professional (VCP-A, VCP-B), Support Specialist (VSS)' },
    { label: 'CompTIA: ', text: 'Security+ (SY0-701), Network+ (N10-009)' },
    { label: 'Glenstone Academy courses: ', text: 'Claude Code in Action, Model Context Protocol' },
  ] };
  assert.deepStrictEqual(H.formCerts(r).map((c) => c.name), ['CompTIA Security+', 'CompTIA Network+', 'Quillstone VCM-A', 'Quillstone VCP-A', 'Quillstone VCP-B', 'Quillstone VSS']);
});
