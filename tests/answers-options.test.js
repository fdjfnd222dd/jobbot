// Fewer driver stops (2026-10-09): standing answers that failed to match the real option lists.
// Labels come from data/friction.jsonl + data/hiccups.jsonl (State, Country, Discipline, how heard, right-to-work
// restrictions, grad date, term, previously employed, Address Line 2 / Care Of). Fake profile, never data/.
const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib/apply');
const C = require('../lib/client');
const Data = require('../lib/data');

const p = {
  profile: { state: 'VA', country: 'United States', postalCode: '00000', city: 'Springfield', major: 'Information Technology', school: 'State U', phoneType: 'Mobile' },
  extras: { howHeard: 'LinkedIn', citizenship: 'U.S. citizen', relocation: 'Yes', workMode: 'Onsite or hybrid', earliestStart: 'May 2027', graduation: 'December 2027', gradYear: '2027', gradDateExact: '12/01/2027', over18: 'Yes', internTerm: 'Summer 2027' },
  standardAnswers: { workAuth: 'yes', sponsorship: 'no' },
  policy: { autoConsent: true, autoSubmit: false },
};
const ans = (n, prof = p) => {
  const r = A.profileAnswer(n, prof);
  return r && r.value;
};
const YN = ['Yes', 'No'];

test('Country: the U.S. under any decoration (dial code, abbreviation, "US - United States")', () => {
  const us = (opts) => ans({ label: 'Country', kind: 'select', options: opts });
  assert.strictEqual(us(['— Make a Selection —', 'United States of America (+1)', 'Canada (+1)']), 'United States of America (+1)');
  assert.strictEqual(us(['US - United States', 'CA - Canada']), 'US - United States');
  assert.strictEqual(us(['United States (US)', 'Canada (CA)']), 'United States (US)');
  assert.strictEqual(us(['United States of America (USA)', 'Canada']), 'United States of America (USA)');
  assert.strictEqual(us(['UNITED  STATES', 'CANADA']), 'UNITED  STATES');
  assert.strictEqual(us(['United States Minor Outlying Islands (+1)', 'Canada (+1)']), null);
  assert.strictEqual(A.isUsOption('United States Virgin Islands'), false);
});

test('State: code, name and every way a list joins them', () => {
  const st = (opts) => ans({ label: 'State', kind: 'select', options: opts });
  assert.strictEqual(st(['— Make a Selection —', 'VA - Virginia', 'WV - West Virginia']), 'VA - Virginia');
  assert.strictEqual(st(['Virginia (VA)', 'West Virginia (WV)']), 'Virginia (VA)');
  assert.strictEqual(st(['Virginia - VA', 'West Virginia - WV']), 'Virginia - VA');
  assert.strictEqual(st(['VA – Virginia', 'WV – West Virginia']), 'VA – Virginia');
  assert.strictEqual(st(['US-VA', 'US-WV']), 'US-VA');
  assert.strictEqual(st(['Virginia, United States', 'Vermont, United States']), 'Virginia, United States');
  assert.strictEqual(st(['Virginia (US)', 'Vermont (US)']), 'Virginia (US)');
  assert.strictEqual(st(['VA  -  Virginia']), 'VA  -  Virginia', 'double spaces');
  assert.strictEqual(st(['West Virginia', 'Vermont']), null, 'West Virginia is not Virginia');
  assert.strictEqual(ans({ label: 'State/Territory', kind: 'select', options: ['Virginia'] }), 'Virginia');
});

test('Phone code and phone type lists (Workday)', () => {
  assert.strictEqual(ans({ label: 'Country Phone Code*', kind: 'combobox', options: ['Afghanistan (+93)', 'United States of America (+1)'] }), 'United States of America (+1)');
  assert.strictEqual(ans({ label: 'Phone Device Type', kind: 'select', options: ['Home', 'Mobile', 'Work'] }), 'Mobile');
  assert.strictEqual(ans({ label: 'Phone Device Type', kind: 'select', options: ['Fax'] }), null);
});

test('City: a plain text box gets the city, the picker gets "City, ST"', () => {
  assert.deepStrictEqual(A.profileAnswer({ label: 'City *', kind: 'text' }, p), { value: 'Springfield' });
  assert.deepStrictEqual(A.profileAnswer({ label: 'Location (City)*', kind: 'combobox' }, p), { value: 'Springfield, VA', query: 'Springfield' });
  assert.deepStrictEqual(A.profileAnswer({ label: 'City', kind: 'combobox' }, p), { value: 'Springfield, VA', query: 'Springfield' });
  // Never the home city in an employer's or school's block.
  assert.strictEqual(A.profileAnswer({ label: 'City', kind: 'text', section: 'Professional Experience' }, p), null);
  assert.strictEqual(A.profileAnswer({ label: 'City *', kind: 'text', section: 'Education' }, p), null);
});

test('School re-confirmation question (Greenhouse)', () => {
  assert.strictEqual(ans({ label: 'Please re-confirm the university you currently attend *', kind: 'combobox' }), 'State U');
});

test('how heard: the ways a list words LinkedIn; where/how phrasing', () => {
  const hh = (opts) => ans({ label: 'How Did You Hear About Us?', kind: 'select', options: opts });
  assert.strictEqual(hh(['Job Board  - Linkedin', 'Social Media - LinkedIn']), 'Job Board  - Linkedin');
  assert.strictEqual(hh(['LinkedIn Job Board', 'Indeed Job Board']), 'LinkedIn Job Board');
  assert.strictEqual(hh(['Job Board - LinkedIn', 'Job Board - Other']), 'Job Board - LinkedIn');
  assert.strictEqual(hh(['Internet Job Board', 'Friend']), 'Internet Job Board');
  assert.ok(A.isHowHeard('Where did you hear about this opportunity?'));
  assert.ok(A.isHowHeard('How did you find this job?'));
  assert.ok(!A.isHowHeard('How did you find your way around the codebase in your last internship and what did you learn?'));
});

test('optionFor: only an option that safely means the value (the page picked May for "Fall 2027")', () => {
  assert.strictEqual(A.optionFor('Fall 2027', ['May 2027', 'December 2027', 'May 2028']), null, 'only the year in common: ambiguous');
  assert.strictEqual(A.optionFor('Fall 2027', ['Spring 2027', 'Fall 2027 (Aug - Dec)']), 'Fall 2027 (Aug - Dec)');
  assert.strictEqual(A.optionFor('LinkedIn', ['Job Board  - Linkedin', 'Indeed']), 'Job Board  - Linkedin');
  assert.strictEqual(A.optionFor('No', ['Yes', 'No']), 'No');
  assert.strictEqual(A.optionFor('No', ['Yes, I do', 'No, I do not']), 'No, I do not');
  assert.strictEqual(A.optionFor('Prefer not to say', ['Male', 'Female', "I don't wish to answer"]), "I don't wish to answer");
  assert.strictEqual(A.optionFor('Yes', ['Yes, in the US', 'Yes, in Canada']), null, 'two options start with Yes');
  assert.strictEqual(A.optionFor('Summer', []), null);
});

test('optionFor is not negation-blind and never maps yes / no to a decline (review 2026-10-09)', () => {
  assert.strictEqual(A.optionFor('I am not a veteran', ['Veteran', 'I am a veteran']), null);
  assert.strictEqual(A.optionFor('U.S. Citizen', ['Non-U.S. Citizen', 'Permanent Resident']), null);
  assert.strictEqual(A.optionFor('Not Hispanic or Latino', ['Hispanic or Latino']), null);
  assert.strictEqual(A.optionFor('No', ['I do not want to answer', 'No answer', 'No longer a student', 'Yes']), null);
  assert.strictEqual(A.optionFor('Yes', ['Yes', 'No']), 'Yes');
  assert.strictEqual(A.optionFor('Information Technology', ['Information Technology Management', 'Other']), null, 'a prefix that adds words is another major');
  assert.strictEqual(A.optionFor('Information Technology', ['Information Technology', 'Information Technology Management']), 'Information Technology');
  assert.strictEqual(A.optionFor('I am not a veteran', ['I am not a protected veteran', 'I am a veteran']), null, 'a sentence is not "the one option that says no"');
});

/* The logistics rules the stops were waiting on. */
const L = (label, kind, options, ctx, prof = p) => A.logisticsAnswer({ label, kind, options }, prof, ctx);

test('right-to-work RESTRICTIONS: the U.S. citizen has none (standard work-authorization "yes" is backwards here)', () => {
  const label = 'Are there any restrictions or limitations on your right to work in the country for which you are applying for a job?';
  assert.strictEqual(L(label, 'radio', YN), 'No');
  assert.strictEqual(L(label, 'radio', YN, null, { extras: {} }), null, 'no citizenship on file: ask');
  assert.strictEqual(A.standardAnswer({ label, kind: 'radio', options: YN }, p), null, 'standardAnswer no longer says Yes');
  assert.strictEqual(A.standardAnswer({ label: 'Are you legally authorized to work in the United States?', kind: 'radio', options: YN }, p).value, 'Yes');
  // The positive phrasing keeps its answer: "without restrictions" is not a restriction question.
  const positive = 'Are you legally authorized to work in the United States without restrictions?';
  assert.strictEqual(A.standardAnswer({ label: positive, kind: 'radio', options: YN }, p).value, 'Yes');
  assert.strictEqual(L('Do you have the right to work in the United States without restrictions?', 'radio', YN), null, 'not answered No by the restriction rule');
});

test('previously employed / worked with us before: No, except where he worked', () => {
  assert.strictEqual(L('I was previously employed directly by Quarrymere or a subsidiary of Quarrymere, not as a subcontractor.', 'radio', YN), 'No');
  assert.strictEqual(L('Have you worked with us before?*', 'radio', YN, { company: 'Acme Corp' }), 'No');
  assert.strictEqual(L('Have you worked with us before?*', 'radio', YN, { company: 'Quillstone' }), null);
  assert.strictEqual(L('Have you worked with us before?*', 'radio', YN), null, 'whose form it is stays unknown: ask');
  assert.strictEqual(L('Have you previously been employed by this company?', 'radio', YN, { company: 'Gamma Project Robotics' }), null);
});

test('employment-history questions: worked for X before, never-worked option, relatives employed there, federal employee', async () => {
  assert.strictEqual(L('Have you worked for Ravenhaven before?', 'radio', YN), 'No');
  assert.strictEqual(L('Have you worked for Quillstone before?', 'radio', YN), null);
  const brookvale = ['I currently work at Brookvale as a full-time employee or intern', 'I have previously worked at Brookvale as a full-time employee or intern (Hoodie Alumni)', 'I currently work at Brookvale in a contractor role', 'I have never worked at Brookvale'];
  assert.strictEqual(L('Have you ever worked for Brookvale as an employee, intern or contractor? Note that this includes contract work.', 'select', brookvale), 'I have never worked at Brookvale');
  assert.strictEqual(L('Have you ever worked for Quillstone as an employee?', 'select', ['I have never worked at Quillstone', 'I have previously worked at Quillstone']), null);
  assert.strictEqual(L('Have you ever worked at Driftmere as an employee, intern or contingent worker?', 'radio', YN), 'No');
  assert.strictEqual(L('Are you a current U.S. federal government employee who left government service within the last two (2) years?', 'radio', YN, null, { extras: { govEmployee: 'No' } }), 'No');
  // relatives employed there: the owner's standing conflict answer (No), via autoResolve's conflict rule
  const { isConflictQuestion } = A;
  assert.ok(isConflictQuestion('Do you have any relatives employed at Ravenhaven?'));
});

test('work/live in the U.S. (or Canada), 18 or older, the whole internship, NDAs, term month, grad semester', () => {
  assert.strictEqual(L('Are you able to work/live within the United States or Canada for the duration of your internship?', 'radio', YN), 'Yes');
  assert.strictEqual(L('Are you able to work in the United States without sponsorship?', 'radio', YN), null);
  assert.strictEqual(L('Will you be at least 18 years old at or before the start of your internship?', 'radio', YN), 'Yes');
  assert.strictEqual(L("Please confirm you're able to commit to the entire duration of the program as stated in the job description?", 'radio', YN), 'Yes');
  assert.strictEqual(L('Are you available and willing to work for the entire duration of the internship program?', 'radio', YN), 'Yes');
  assert.strictEqual(L('Do you have a signed Non-Compete with a previous or current employer?', 'radio', YN), 'No');
  assert.strictEqual(L('Are you subject to any non-competition, non-disclosure or other agreement that would preclude or restrict your employment at Coppermoor?', 'radio', YN), 'No');
  assert.strictEqual(L('Would you be willing to sign a non-disclosure agreement?', 'radio', YN), null);
  assert.strictEqual(L('Will you sign our NDA?', 'radio', YN), null);
  assert.strictEqual(L('Please select the month you will be able to start your internship.*', 'select', ['January', 'February', 'May', 'June']), 'May');
  assert.strictEqual(L('Please select the month you will be able to start your internship.*', 'select', ['January', 'February', 'March']), null);
  assert.strictEqual(L('What semester are you on track to graduate?*', 'select', ['Spring 2027', 'Fall 2027', 'Spring 2028']), 'Fall 2027');
  assert.strictEqual(L('What is your expected degree completion date?', 'date'), '12/01/2027');
  assert.strictEqual(L('Please select date that you will complete your current degree. In case you are n … date of your most recent graduation', 'date'), '12/01/2027');
});

/* autoResolve end to end against a stubbed page. */
async function withStubs(page, prof, lookup, fn) {
  const saved = { page: C.page, send: C.send, profile: Data.profile, lookup: Data.lookup };
  C.page = page;
  C.send = async () => [];
  Data.profile = () => prof;
  Data.lookup = lookup || (() => null);
  try {
    return await fn();
  } finally {
    Object.assign(C, { page: saved.page, send: saved.send });
    Object.assign(Data, { profile: saved.profile, lookup: saved.lookup });
  }
}
const resolve = (need, o = {}) => {
  const sets = [];
  const reads = [];
  const page = async (tabId, fn, args) => {
    if (fn === 'set') {
      sets.push(args);
      const res = o.set ? o.set(args) : { ok: true, value: args.value };
      return [{ frameId: 0, result: res }];
    }
    if (fn === 'options') {
      reads.push(args.query || null);
      return [{ frameId: 0, result: o.options ? o.options(args) : [] }];
    }
    return [{ frameId: 0, result: null }];
  };
  return withStubs(page, p, o.lookup, async () => ({ left: await A.autoResolve({ tabId: 1, company: o.company || 'Acme Corp' }, [{ ref: '0:5', required: true, ...need }]), sets, reads }));
};

test('autoResolve: a bank answer that is not on the list does not become the first fuzzy match (Fall 2027 vs May 2027)', async () => {
  const bank = () => ({ answer: 'Fall 2027', confidence: 1, source: 'qa-exact', id: 'x' });
  const r = await resolve({ label: 'What is your expected graduation date?*', kind: 'combobox', options: ['May 2027', 'December 2027', 'May 2028'] }, { lookup: bank });
  assert.strictEqual(r.left.length, 0);
  assert.strictEqual(r.sets[0].value, 'December 2027', 'the grad-date rule picks the December option instead');
  // Nothing else can answer it: stop with the stored answer shown, not a wrong pick.
  const q = await resolve({ label: 'Which flavour do you like most?*', kind: 'select', options: ['Vanilla', 'Chocolate'] }, { lookup: () => ({ answer: 'Mint', confidence: 1, source: 'qa-exact', id: 'y' }) });
  assert.strictEqual(q.sets.length, 0);
  assert.strictEqual(q.left[0].bank, 'Mint');
});

test('autoResolve: a bank answer that names an option goes in as that exact option', async () => {
  const bank = () => ({ answer: 'LinkedIn', confidence: 1, source: 'qa-exact', id: 'x' });
  const r = await resolve({ label: 'Where did you learn about the role?', kind: 'select', options: ['Job Board  - Linkedin', 'Other'] }, { lookup: bank });
  assert.strictEqual(r.sets[0].value, 'Job Board  - Linkedin');
});

test('autoResolve: a date input never gets "Fall 2027" from the bank', async () => {
  const bank = () => ({ answer: 'Fall 2027', confidence: 1, source: 'qa-exact', id: 'x' });
  const r = await resolve({ label: 'Expected graduation date', kind: 'date' }, { lookup: bank });
  assert.strictEqual(r.sets[0].value, '12/01/2027');
});

test('autoResolve: right-to-work restrictions answered No (Elmbrook stopped 4 times)', async () => {
  const r = await resolve({ label: 'Are there any restrictions or limitations on your right to work in the country for which you are applying for a job?', kind: 'radio', options: YN });
  assert.strictEqual(r.left.length, 0);
  assert.strictEqual(r.sets[0].value, 'No');
});

test('autoResolve: a long State list is searched by name when its first entries lack Virginia (iCIMS)', async () => {
  const r = await resolve(
    { label: 'State', kind: 'combobox' },
    { options: (a) => (a.query ? ['Vermont', 'Virginia', 'West Virginia'] : ['Alabama', 'Alaska', 'Arizona']) }
  );
  assert.strictEqual(r.left.length, 0);
  assert.deepStrictEqual(r.reads, [null, 'Virginia']);
  assert.strictEqual(r.sets[0].value, 'Virginia');
  assert.strictEqual(r.sets[0].query, 'Virginia');
});

test('autoResolve: Discipline searches the real major, then Other, on a list that hides it (Greenhouse)', async () => {
  const r = await resolve(
    { label: 'Discipline*', kind: 'combobox' },
    { options: (a) => (a.query === 'Other' ? ['Other'] : a.query ? ['Information Systems'] : ['Accounting', 'Aerospace']) }
  );
  assert.strictEqual(r.left.length, 0);
  assert.deepStrictEqual(r.reads, [null, 'Information Technology', 'Other']);
  assert.strictEqual(r.sets[0].value, 'Other');
  assert.strictEqual(r.sets[0].query, 'Other');
});

test('autoResolve: Workday how-heard search box that lists nothing until typed (UMBERMOOR)', async () => {
  const r = await resolve(
    { label: 'How Did You Hear About Us?', kind: 'combobox' },
    { options: (a) => (a.query ? ['Job Board  - Linkedin', 'Social Media - LinkedIn'] : []) }
  );
  assert.strictEqual(r.left.length, 0);
  assert.strictEqual(r.sets[0].value, 'Job Board  - Linkedin');
  assert.strictEqual(r.sets[0].query, 'LinkedIn');
});

test('autoResolve: a value the page refused is mapped onto the options the page named, once', async () => {
  const bank = () => ({ answer: 'LinkedIn', confidence: 1, source: 'qa-exact', id: 'x' });
  const r = await resolve(
    { label: 'Source', kind: 'combobox' },
    {
      lookup: bank,
      set: (a) => (a.value === 'LinkedIn' ? { ok: false, error: 'no option matches', options: ['Other', 'Job Board  - Linkedin'] } : { ok: true, value: a.value }),
    }
  );
  assert.strictEqual(r.left.length, 0);
  assert.deepStrictEqual(r.sets.map((s) => s.value), ['LinkedIn', 'Job Board  - Linkedin']);
  // Nothing maps: one failed set, reported with the page's options.
  const f = await resolve({ label: 'Nationality', kind: 'combobox' }, { lookup: bank, set: () => ({ ok: false, error: 'no option matches', options: ['Canada', 'Mexico'] }) });
  assert.strictEqual(f.sets.length, 1);
  assert.deepStrictEqual(f.left[0].options, ['Canada', 'Mexico']);
});

test('waitAddressFilled: polls until ZIP / City / State / County behind the Address Line 1 suggestion hold values', async () => {
  const frames = [
    [['ZIP Code *', ''], ['City *', ''], ['State *', ''], ['County *', '']],
    [['ZIP Code *', '00000'], ['City *', ''], ['State *', 'VA'], ['County *', '']],
    [['ZIP Code *', '00000'], ['City *', 'Springfield'], ['State *', 'VA'], ['County *', 'Fairfax']],
  ];
  let i = 0;
  const page = async () => {
    const rows = frames[Math.min(i++, frames.length - 1)];
    return [{ frameId: 0, result: { top: true, url: 'https://x', fields: rows.map(([label, value], k) => ({ ref: String(k), label, kind: 'text', required: true, value })), buttons: [], signals: {} } }];
  };
  const t0 = Date.now();
  const snap = await withStubs(page, p, null, () => A.waitAddressFilled({ tabId: 1 }));
  assert.strictEqual(i, 3, 'looked three times, stopped when everything was filled');
  assert.ok(snap.fields.every((f) => f.value));
  assert.ok(Date.now() - t0 < 3000);
  // A county the profile does not know stays empty: stop waiting once nothing changes.
  const stuck = async () => [{ frameId: 0, result: { top: true, url: 'https://x', fields: [{ ref: '1', label: 'ZIP Code *', kind: 'text', value: '00000' }, { ref: '2', label: 'County *', kind: 'combobox', value: '' }], buttons: [], signals: {} } }];
  const s2 = await withStubs(stuck, p, null, () => A.waitAddressFilled({ tabId: 1 }));
  assert.strictEqual(s2.fields[1].value, '');
});

test('autoResolve: a typed Address Line 1 suggestion passes the street as the search query', async () => {
  const q = { ...p, profile: { ...p.profile, addressLine1: '1 Main St' } };
  const sets = [];
  const page = async (t, fn, args) => {
    if (fn === 'set') sets.push(args);
    return [{ frameId: 0, result: fn === 'set' ? { ok: true } : [] }];
  };
  const left = await withStubs(page, q, null, () => A.autoResolve({ tabId: 1, company: 'Acme' }, [{ ref: '0:7', label: 'Address Line 1 *', kind: 'combobox', required: true }]));
  assert.strictEqual(left.length, 0);
  assert.deepStrictEqual([sets[0].value, sets[0].query], ['1 Main St', '1 Main St']);
});

test('Oracle: Address Line 2 / Care Of are optional whatever aria-required says; real required ones are not', () => {
  const url = 'https://x.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/1/apply/section/2';
  for (const l of ['Address Line 2', 'Address Line 3', '2nd address line', 'Care Of', 'Tax District']) assert.ok(A.oracleOptional({ label: l, required: true }, url), l);
  for (const l of ['Address Line 1 *', 'ZIP Code *', 'State *', 'First Name']) assert.ok(!A.oracleOptional({ label: l, required: true }, url), l);
  assert.ok(!A.oracleOptional({ label: 'Address Line 2', required: true }, 'https://boards.greenhouse.io/x/jobs/1'), 'Oracle only');
  assert.ok(!A.oracleOptional({ label: 'Address Line 2', required: true, type: 'validation' }, url), 'a typed need is never dropped');
});

test('dropFilled: needs whose field filled in while the address suggestion settled are gone (Zephyrhaven)', () => {
  const needs = [
    { ref: '0:76', label: 'ZIP Code *', kind: 'text', required: true },
    { ref: '0:77', label: 'City *', kind: 'text', required: true },
    { ref: '0:78', label: 'County *', kind: 'combobox', required: true },
    { ref: '0:90', label: 'Why us?', kind: 'textarea', required: true },
  ];
  // The refs re-rendered (0:76 -> 0:88): matched by their unique labels.
  const snap = {
    url: 'https://x',
    fields: [
      { ref: '0:88', label: 'ZIP Code *', kind: 'text', value: '00000' },
      { ref: '0:89', label: 'City *', kind: 'text', value: 'Springfield' },
      { ref: '0:91', label: 'County *', kind: 'combobox', value: '' },
      { ref: '0:90', label: 'Why us?', kind: 'textarea', value: '' },
    ],
    buttons: [],
    signals: {},
  };
  assert.deepStrictEqual(A.dropFilled(needs, snap).map((n) => n.label), ['County *', 'Why us?']);
  assert.strictEqual(A.dropFilled(needs, null).length, 4);
  const dup = { ...snap, fields: [{ ref: '0:1', label: 'State', value: 'x' }, { ref: '0:2', label: 'State', value: '' }] };
  assert.strictEqual(A.dropFilled([{ ref: '0:2', label: 'State', kind: 'select', required: true }], dup).length, 1, 'same label twice: only the ref decides');
});

test('history: the education row gets the school location from the resume (Country / State / City required on iCIMS)', () => {
  const H = require('../lib/history');
  const f = (label, ref, extra) => ({ ref, label, kind: 'text', value: '', ...(extra || {}) });
  const fields = [
    f('Employer', '0:1'), f('Title', '0:2'), f('City', '0:3'), f('Country', '0:4', { kind: 'combobox' }), f('State', '0:5', { kind: 'combobox' }),
    f('School', '0:10', { kind: 'combobox', value: 'State U' }), f('Degree', '0:11'), f('Major', '0:12'), f('City', '0:13'), f('Country', '0:14', { kind: 'combobox' }), f('State', '0:15', { kind: 'combobox' }),
  ];
  const resume = { experience: [{ company: 'Acme', title: 'Intern', location: 'Smithtown, NC', dates: 'Jun 2025 - Aug 2025' }], education: { school: 'State U', location: 'Springfield, VA', degree: 'BS' } };
  const plan = H.planHistory(fields, [], resume, { profile: { school: 'State U', major: 'IT', degree: 'Bachelor of Science' }, extras: {} });
  const set = Object.fromEntries(plan.sets.map((x) => [x.ref, x.value]));
  assert.strictEqual(set['0:13'], 'Springfield');
  assert.strictEqual(set['0:14'], 'United States');
  assert.strictEqual(set['0:15'], 'Virginia');
  assert.strictEqual(set['0:3'], 'Smithtown', 'job rows unchanged');
});

/* ---- Independent review 2026-10-09: an auto-answer must be provably true for THIS question; else the owner. ---- */
const ctxAcme = { company: '', url: 'https://quillstone.wd5.myworkdayjobs.com/en-US/External/job/Smithtown/x' };

test('review 1: a stored Yes never becomes a rule\'s No (Quillstone interned)', async () => {
  const bank = () => ({ answer: 'Yes', confidence: 1, source: 'qa-exact', id: 'x' });
  const acme = ['I currently work at Quillstone as a full-time employee or intern', 'I have never worked at Quillstone'];
  const r = await resolve({ label: 'Have you previously been employed by Quillstone?', kind: 'select', options: acme }, { lookup: bank, company: 'Quillstone' });
  assert.strictEqual(r.sets.length, 0);
  assert.strictEqual(r.left[0].bank, 'Yes');
  // Same for a company that is not one of his: bank Yes vs the rule's never-worked option still stops (they disagree) ...
  const rh = ['I currently work at Brookvale', 'I have never worked at Brookvale'];
  const x = await resolve({ label: 'Have you ever worked for Brookvale as an employee, intern or contractor?', kind: 'select', options: rh }, { lookup: bank, company: 'Brookvale' });
  assert.strictEqual(x.sets.length, 0);
  // ... and a stored No agrees with it.
  const no = await resolve({ label: 'Have you ever worked for Brookvale as an employee, intern or contractor?', kind: 'select', options: rh }, { lookup: () => ({ answer: 'No', confidence: 1, source: 'qa-exact', id: 'y' }), company: 'Brookvale' });
  assert.strictEqual(no.sets[0].value, 'I have never worked at Brookvale');
  // The standard "previously employed: no" answer has the same guard.
  const prof = { ...p, standardAnswers: { ...p.standardAnswers, previouslyEmployed: 'no' } };
  assert.strictEqual(A.standardAnswer({ label: 'Have you previously been employed by Quillstone?', kind: 'radio', options: YN }, prof, { company: 'Quillstone' }), null);
  assert.strictEqual(A.standardAnswer({ label: 'Have you previously been employed by this company?', kind: 'radio', options: YN }, prof, ctxAcme), null);
});

test('review 2: "worked with / at / for X before" only about this company; never-worked option checks options and host', () => {
  for (const l of ['Have you worked with Python before?', 'Have you worked with Kubernetes before?', 'Have you worked at a university before?', 'Have you worked with the Grant Agency before?', 'Have you worked for Civic Lab before?', 'Have you worked for ECI before?', 'Have you ever worked with Python?', 'Have you ever worked for the Civic Org?'])
    assert.strictEqual(L(l, 'radio', YN, { company: 'Acme Corp' }), null, l);
  assert.strictEqual(L('Have you worked for Ravenhaven before?', 'radio', YN, { company: 'Ravenhaven' }), 'No');
  assert.strictEqual(L('Have you worked with us before?', 'radio', YN, { company: 'Acme Corp' }), 'No');
  assert.strictEqual(L('Have you worked with Acme before?', 'radio', YN, { company: 'Acme Corp' }), 'No', 'the run\'s company by name');
  // the never-worked option: not when the options, the label or the form's host name a place he worked, even with no company known
  const nut = ['I currently work at Quillstone', 'I have never worked at Quillstone'];
  assert.strictEqual(L('Have you ever worked for this company as an employee, intern or contractor?', 'select', nut, { company: '' }), null);
  assert.strictEqual(L('Have you ever worked for us?', 'select', nut, { company: '', url: 'https://quillstone.wd5.myworkdayjobs.com/x' }), null);
  assert.strictEqual(L('Have you previously been employed by this company?', 'radio', YN, ctxAcme), null);
  assert.strictEqual(L('Have you previously been employed by this company?', 'radio', YN, { company: '', url: 'https://jobs.lever.co/exu/1' }), null);
  assert.ok(A.workedAt('Gamma Project (Civic Lab, Civic Org)') && A.workedAt('Example Cyber Institute') && A.workedAt('Grant Agency') && A.workedAt('Civic Lab') && A.workedAt('ECI'));
  assert.ok(!A.workedAt('Acme Corp'));
  // an employment question with a generic object is not answered
  assert.strictEqual(L('Have you ever been employed by a university?', 'radio', YN, { company: 'Acme' }), null);
  assert.strictEqual(L('Have you ever been employed in the field of cybersecurity?', 'radio', YN, { company: 'Acme' }), null);
});

test('review 3: "any family members ever worked for Quillstone" is not a conflict question', () => {
  assert.strictEqual(A.isConflictQuestion('Have you or any family members ever worked for Quillstone?'), false);
  assert.strictEqual(A.isConflictQuestion('Have you or any family members ever been employed by Acme?'), false);
  assert.strictEqual(A.isConflictQuestion('Do you have any relatives employed at Ravenhaven?'), true);
  assert.strictEqual(A.isConflictQuestion('Are you related to anyone who is currently employed here?'), true);
});

test('review 4: able to work in the U.S. -- only the "or" wording', () => {
  assert.strictEqual(L('Are you able to work/live within the United States or Canada for the duration of your internship?', 'radio', YN), 'Yes');
  assert.strictEqual(L('Are you eligible to work in the United States?', 'radio', YN), 'Yes');
  for (const l of ['Are you eligible to work in Canada and the United States?', 'Are you eligible to work in the EU and the US?', 'Are you eligible to work in the US and UK?', 'Are you able to work in both the US and Canada?'])
    assert.strictEqual(L(l, 'radio', YN), null, l);
});

test('review 5: committing to the entire duration -- only when the question names no other term', () => {
  const q = 'Are you available and willing to work for the entire duration of the internship program?';
  assert.strictEqual(L(q, 'radio', YN), 'Yes');
  assert.strictEqual(L('Are you able to commit to the full duration of the program (June - August 2027)?', 'radio', YN), 'Yes');
  for (const l of ['Are you able to commit to the full duration of the program, Jan - Aug 2027?', 'Are you able to commit to the fall co-op (Aug - Dec 2026) for its entire duration?', 'Are you available for the entire duration of the internship, May - August 2026?'])
    assert.strictEqual(L(l, 'radio', YN), null, l);
  assert.strictEqual(L('Are you able to commit to the entire duration of the internship and will you require sponsorship?', 'radio', YN), null, '"sponsorship" is caught now');
  assert.strictEqual(L('Can you confirm you will commit to the entire duration of the internship, with relocation covered by you?', 'radio', YN), null, '"relocation" is caught now (no \\b)');
});

test('review 6: a completion date is the degree\'s, not a job\'s, certification\'s or project\'s', () => {
  for (const l of ['What is the date you will finish your current job?', 'Expected completion date of your CompTIA certification', 'Expected completion date of your current role', 'Expected completion date of your current project', 'What is the date you will complete your internship?'])
    assert.strictEqual(L(l, 'date'), null, l);
  assert.strictEqual(L('What is your expected degree completion date?', 'date'), '12/01/2027');
  assert.strictEqual(L('Please select date that you will complete your current degree.', 'date'), '12/01/2027');
});

test('review 7: restrictions on the LEGAL right to work only', () => {
  for (const l of ['Are there any restrictions on your ability to work weekends?', 'Do you have any restrictions on your ability to work night shifts?', 'Are there restrictions on your ability to work on-site?', 'Any limitations on your ability to work overtime?'])
    assert.strictEqual(L(l, 'radio', YN), null, l);
  assert.strictEqual(L('Are there any restrictions or limitations on your right to work in the country for which you are applying for a job?', 'radio', YN), 'No');
  assert.strictEqual(L('Do you have any restrictions on your authorization to work in the United States?', 'radio', YN), 'No');
});

test('review 8: 18 or older -- the whole question is the age', () => {
  for (const l of ['Are you at least 18 and have a valid driver license?', 'Are you at least 18 years old with 3 years of experience?', 'Are you at least 18 years old, and have you ever been convicted of a felony?', 'Are you over 18 and legally authorized to work?'])
    assert.strictEqual(L(l, 'radio', YN), null, l);
  assert.strictEqual(L('Are you at least 18 years of age?', 'radio', YN), 'Yes');
  assert.strictEqual(L('Will you be at least 18 years old at or before the start of your internship?', 'radio', YN), 'Yes');
});

test('review 10: NDA rule -- only "have you signed / are you bound by" with an employer', () => {
  for (const l of ['Have you read and accepted the confidentiality agreement?', 'Have you reviewed and signed the NDA?', 'Have you signed the NDA?', 'Do you acknowledge the non-disclosure agreement?'])
    assert.strictEqual(L(l, 'radio', YN), null, l);
  assert.strictEqual(L('Do you have a signed Non-Compete with a previous or current employer?', 'radio', YN), 'No');
  assert.strictEqual(L('Are you subject to any non-competition, non-disclosure or other agreement that would preclude or restrict your employment at Coppermoor?', 'radio', YN), 'No');
});

test('review 16: how-heard needs the job / company / us', () => {
  assert.ok(!A.isHowHeard('How did you discover the field of cybersecurity and what drew you to it?'));
  assert.ok(!A.isHowHeard('How did you find the application process?'));
  assert.ok(!A.isHowHeard('How did you hear about the field of cybersecurity?'));
  assert.ok(A.isHowHeard('How did you hear about us?'));
  assert.ok(A.isHowHeard('How did you find this job?'));
  assert.ok(A.isHowHeard("How'd you hear about Thornhaven?"));
});

test('review 17: start month matches the year too', () => {
  const q = 'Please select the month you will be able to start your internship.*';
  assert.strictEqual(L(q, 'select', ['May 2026', 'May 2027']), 'May 2027');
  assert.strictEqual(L(q, 'select', ['May 2026', 'June 2026']), null);
  assert.strictEqual(L(q, 'select', ['May', 'June']), 'May');
  assert.strictEqual(L(q + ' (2026)', 'select', ['May', 'June']), null, 'the question names another year');
});

test('review LOW: City in a Position / Supervisor block, phone code in Emergency Contact, Internet / Web Search is not LinkedIn', () => {
  assert.strictEqual(A.profileAnswer({ label: 'City', kind: 'text', section: 'Position 1' }, p), null);
  assert.strictEqual(A.profileAnswer({ label: 'City', kind: 'text', section: 'Supervisor' }, p), null);
  assert.strictEqual(ans({ label: 'Country Phone Code*', kind: 'combobox', options: ['United States of America (+1)'], section: 'Emergency Contact' }), null);
  assert.strictEqual(ans({ label: 'Phone Device Type', kind: 'select', options: ['Mobile', 'Home'], section: 'Emergency Contact' }), null);
  const hh = (opts) => ans({ label: 'How Did You Hear About Us?', kind: 'select', options: opts });
  assert.strictEqual(hh(['Internet Search', 'Web Search', 'Friend']), 'Internet Search', 'owner 2026-10-09: any non-person option');
  assert.strictEqual(hh(['Job Board', 'Friend']), 'Job Board');
  assert.strictEqual(hh(['Internet Job Board', 'Friend']), 'Internet Job Board');
  assert.strictEqual(A.isWorkRestriction ? A.isWorkRestriction('Are you authorized to work in the US with no limitations?') : false, false);
});

test('review 2 (2026-10-09): plain Yes only, trailing notes allowed, enrolled and start month not fooled', () => {
  assert.strictEqual(A.optionFor('Yes', ['Yes, but I require sponsorship', 'No']), null, 'a qualified yes is another answer');
  assert.strictEqual(A.optionFor('Yes', ['Yes, I am authorized', 'No']), 'Yes, I am authorized');
  assert.strictEqual(A.optionFor('No', ['Yes, I will require sponsorship', 'No, I do not require sponsorship']), 'No, I do not require sponsorship');
  assert.strictEqual(A.optionFor('No', ['Yes', 'No, but I will in the future']), null);
  assert.strictEqual(A.optionFor('United States', ['United States of America', 'Canada']), 'United States of America');
  assert.strictEqual(A.optionFor('U.S. Citizen', ['U.S. Citizen or National', 'Non-U.S. Citizen']), 'U.S. Citizen or National');
  assert.strictEqual(A.optionFor('Asian', ['Asian (Not Hispanic or Latino)', 'White (Not Hispanic or Latino)']), 'Asian (Not Hispanic or Latino)');
  assert.strictEqual(A.optionFor('U.S. Citizen', ['Non-U.S. Citizen', 'Permanent resident']), null);
  const la = (label, options) => {
    const r = A.logisticsAnswer({ label, kind: 'radio', options }, p);
    return r && (r.value !== undefined ? r.value : r);
  };
  assert.strictEqual(la('Are you at least 18 years old and not currently enrolled in school?', YN), null);
  assert.strictEqual(la('What month can you start?', ['Maybe', 'June']), null, '"May" is not "Maybe"');
});

test('Oracle Preferred First / Last Name (Fernhaven 2026-10-09)', () => {
  const q = { profile: { firstName: 'Jane', preferredName: 'Janie', lastName: 'Doe' } };
  assert.deepStrictEqual(A.profileAnswer({ label: 'Preferred First Name', kind: 'text' }, q), { value: 'Janie' });
  assert.deepStrictEqual(A.profileAnswer({ label: 'Preferred Last Name *', kind: 'text' }, q), { value: 'Doe' });
  assert.deepStrictEqual(A.profileAnswer({ label: 'Preferred First Name', kind: 'text' }, { profile: { firstName: 'Jane' } }), { value: 'Jane' });
  assert.strictEqual(A.profileAnswer({ label: 'Preferred Middle Name', kind: 'text' }, q), null);
});

test('Workday CC-305 "Please check one of the boxes below" takes the stored disability answer (DUNVALE 2026-10-09)', () => {
  const n = { label: 'Please check one of the boxes below:*', kind: 'checkboxes', options: ['Yes, I have a disability, or have had one in the past', 'No, I do not have a disability and have not had one in the past', 'I do not want to answer'] };
  assert.deepStrictEqual(A.standardAnswer(n, { standardAnswers: { disability: 'no' } }, {}), { value: 'No, I do not have a disability and have not had one in the past', source: 'standard:disability' });
  assert.strictEqual(A.standardAnswer(n, { standardAnswers: { disability: 'decline' } }, {}).value, 'I do not want to answer');
  assert.strictEqual(A.standardAnswer({ label: 'Please check one of the boxes below:', kind: 'checkboxes', options: ['A', 'B'] }, { standardAnswers: { disability: 'no' } }, {}), null);
});
