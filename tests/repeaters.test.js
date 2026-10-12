/*
 * History sections on every application (the owner 2026-10-09: the four jobs, the school and the certifications, even in
 * an optional empty section). The driver's fillRepeaters loop (lib/apply.js) + lib/history.js nextRepeaterAction run
 * against JB.repeaters / set / click in Playwright's Firefox on offline fixtures: lib/client is stubbed to call the
 * page directly. The facts come from a test resume JSON (a sidecar next to a fake resume file), not data/.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { firefox } = require(path.join(process.env.HOME, 'autofill', 'node_modules', 'playwright'));
const A = require('../lib/apply');
const C = require('../lib/client');
const Data = require('../lib/data');

const EXT = path.join(__dirname, '..', 'extension');
const FILES = fs.readFileSync(path.join(EXT, 'agent', 'background.js'), 'utf8').match(/const FILES = \[([\s\S]*?)\];/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
const OWN = path.join(__dirname, 'fixtures');

const RESUME = {
  education: { school: 'Example State University', location: 'Springfield, VA', degree: 'Bachelor of Science in Information Technology', date: 'Dec 2027' },
  experience: [
    { company: 'Quillstone', location: 'Smithtown, NC', title: 'Systems Reliability Engineer Intern (SRE)', dates: 'Jun 2026 - Aug 2026', bullets: ['Resolved 100+ cases', 'Shipped an integration'] },
    { company: 'Example State University', location: 'Springfield, VA', title: 'Research Assistant, Quantum Risk Modeling', dates: 'Aug 2026 - Present', bullets: ['Model attacker pivots'] },
    { company: 'Example State University', location: 'Springfield, VA', title: 'Research Assistant, Grant-Funded Industrial Cybersecurity', dates: 'Nov 2025 - Present', bullets: ['Built a digital twin'] },
    { company: 'Gamma Project (Civic Lab, Civic Org)', location: 'Springfield, VA', title: 'Software Engineer', dates: 'Jan 2026 - Present', bullets: ['Built Gamma Project'] },
  ],
  projects: [{ name: 'Threat Intelligence Pipeline' }],
  certifications: [
    { label: 'Quillstone: ', text: 'VCM-A, VCP-A 6.10, VCP-B 6.10, VSS', date: '2026' },
    { label: 'CompTIA: ', text: 'Security+, Network+', date: '2025 - 2026' },
    { label: 'Eagle Scout, ', text: '200-hour community service project', date: 'Jul 2023' },
  ],
};
const PROFILE = {
  profile: { school: 'Example State University', degree: 'Bachelor of Science', major: 'Information Technology', minor: 'Robotics', gradMonth: '12', gradYear: '2027' },
  extras: { gpa: '3.7', eduStart: 'Aug 2023' },
  policy: { autoConsent: true, autoSubmit: true },
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-rep-'));
const RESUME_FILE = path.join(dir, 'PatExample_Resume_Test.pdf');
fs.writeFileSync(path.join(dir, 'PatExample_Resume_Test.json'), JSON.stringify(RESUME));

let browser;
test.before(async () => {
  browser = await firefox.launch();
});
test.after(async () => {
  if (browser) await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function load(file) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/*', (r) => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await page.goto('file://' + file);
  for (const f of FILES) await page.addScriptTag({ path: path.join(EXT, f) });
  return page;
}

/** Run fillRepeaters on `file` with lib/client calling the Playwright page. */
async function run(file) {
  const page = await load(file);
  const saved = { page: C.page, send: C.send, profile: Data.profile };
  C.page = async (tabId, fn, args) => [{ frameId: 0, result: await page.evaluate(([n, a]) => globalThis.JB[n](a), [fn, args || {}]) }];
  C.send = async () => [];
  Data.profile = () => PROFILE;
  const r = { tabId: 1, steps: [], uploads: {} };
  try {
    const snap = await A.snapshot(1);
    const out = await A.fillRepeaters(r, snap, RESUME_FILE, PROFILE);
    return { page, out, run: r };
  } finally {
    Object.assign(C, { page: saved.page, send: saved.send });
    Data.profile = saved.profile;
  }
}

test('Workday My Experience: parsed blocks rewritten, missing jobs added, education added (UMBERMOOR / Elmbrook 2026-10-09)', async () => {
  const { page, out, run: r } = await run(path.join(OWN, 'workday-my-experience.html'));
  const panels = await page.evaluate(() => Array.from(document.querySelectorAll('#work-panels > [role="group"]')).map((p) => {
    const v = (n) => (p.querySelector(`[name="${n}"]`) || {}).value;
    const d = (n) => Array.from(p.querySelectorAll(`[data-automation-id="formField-${n}"] input`)).map((i) => i.value).join('/');
    const end = p.querySelector('[data-automation-id="formField-endDate"]');
    return { title: v('jobTitle'), company: v('companyName'), location: v('location'), current: p.querySelector('[name="currentlyWorkHere"]').checked, from: d('startDate'), to: end.style.display === 'none' ? null : d('endDate'), desc: p.querySelector('textarea').value };
  }));
  assert.strictEqual(panels.length, 4, JSON.stringify(panels));
  const by = (t) => panels.find((x) => x.title === t);
  const nut = by('Systems Reliability Engineer Intern');
  assert.ok(nut, 'the scrambled "SRE" block is the Quillstone job again');
  assert.deepStrictEqual([nut.company, nut.location, nut.current, Number(nut.from.split('/')[0]), nut.from.split('/')[1], Number(nut.to.split('/')[0])], ['Quillstone', 'Smithtown, NC', false, 6, '2026', 8]);
  assert.match(nut.desc, /^- Resolved 100\+ cases\n- Shipped an integration$/);
  const locus = by('Software Engineer');
  assert.strictEqual(locus.company, 'Gamma Project (Civic Lab)', 'never "Civic Org" as the employer');
  assert.strictEqual(locus.current, true);
  assert.strictEqual(locus.to, null, 'a current job has no end date');
  assert.deepStrictEqual(panels.map((x) => x.from.split('/').map(Number).join('/')).sort(), ['1/2026', '11/2025', '6/2026', '8/2026'], 'every start date typed');
  assert.ok(by('Research Assistant, Quantum Risk Modeling'));
  assert.ok(by('Research Assistant, Grant-Funded Industrial Cybersecurity'));
  assert.ok(!panels.some((x) => /Pipeline/.test(x.company)), 'the project block is gone');
  const edu = await page.evaluate(() => Array.from(document.querySelectorAll('#edu-panels > [role="group"]')).map((p) => ({
    school: p.querySelector('[id$="--school"]').value,
    degree: p.querySelector('select').value,
    major: p.querySelector('[id$="--fieldOfStudy"]').value,
    gpa: p.querySelector('[id$="--gradeAverage"]').value,
    years: Array.from(p.querySelectorAll('[data-automation-id="dateSectionYear-input"]')).map((i) => i.value),
  })));
  assert.deepStrictEqual(edu, [{ school: 'Example State University', degree: "Bachelor's Degree", major: 'Information Technology', gpa: '3.7', years: ['2023', '2027'] }]);
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('#cert-panels > *').length), 0, 'Workday certifications are left to the owner');
  assert.ok(out.touched);
  assert.match(r.steps.map((s) => s.msg).join('\n'), /history sections \(workday\)/);
  await page.close();
});

test('Oracle profile tiles: 4 jobs added, "Unnamed Major" fixed, "Unnamed License" tiles replaced by real certs (Fernhaven 2026-10-09)', async () => {
  const { page, run: r } = await run(path.join(OWN, 'oracle-profile-items.html'));
  const tiles = await page.evaluate(() => Array.from(document.querySelectorAll('.apply-flow-block--tile-profile-items')).map((b) => ({
    kind: b.dataset.kind,
    open: !!b.querySelector('.apply-flow-profile-item-form'),
    tiles: Array.from(b.querySelectorAll('article')).map((a) => ({ title: a.querySelector('[class*="summary-title"]').textContent.trim(), sub: a.querySelector('[class*="summary-subtitle"]').textContent.trim(), invalid: /--invalid/.test(a.className), v: a.values })),
  })));
  const [exp, edu, cert] = tiles;
  assert.ok(!tiles.some((b) => b.open), 'no form left open');
  assert.deepStrictEqual(exp.tiles.map((t) => `${t.title} @ ${t.sub}`).sort(), [
    'Research Assistant, Grant-Funded Industrial Cybersecurity @ Example State University',
    'Research Assistant, Quantum Risk Modeling @ Example State University',
    'Software Engineer @ Gamma Project (Civic Lab)',
    'Systems Reliability Engineer Intern @ Quillstone',
  ]);
  const nut = exp.tiles.find((t) => t.sub === 'Quillstone').v;
  assert.deepStrictEqual([nut['Start Date Month'], nut['Start Date Year'], nut['End Date Month'], nut['End Date Year'], nut['Currently employed here'], nut.City, nut.State, nut.Country], ['June', '2026', 'August', '2026', '', 'Smithtown', 'North Carolina', 'United States']);
  const locus = exp.tiles.find((t) => /Gamma Project/.test(t.sub)).v;
  assert.deepStrictEqual([locus['Currently employed here'], locus['End Date Month'], locus['End Date Year']], ['yes', '', ''], 'current job: ticked, no end date');
  assert.strictEqual(edu.tiles.length, 1);
  assert.deepStrictEqual([edu.tiles[0].title, edu.tiles[0].sub, edu.tiles[0].invalid], ['Information Technology', 'Example State University', false]);
  const e = edu.tiles[0].v;
  assert.deepStrictEqual([e.Degree, e['Start Date Month'], e['Start Date Year'], e.Graduated, e['Date Acquired Month'], e['Date Acquired Year']], ['Bachelors', 'August', '2023', '', 'December', '2027'], 'the made-up January 2020 start is replaced');
  assert.deepStrictEqual(cert.tiles.map((t) => t.title), ['CompTIA Security+', 'CompTIA Network+'], 'Unnamed License tiles gone; the certs the catalogue lists are added');
  assert.ok(cert.tiles.every((t) => !t.v['Date Acquired Year']), 'no made-up acquisition dates');
  const log = r.steps.map((s) => s.msg).join('\n');
  assert.match(log, /cert delete x2/);
  assert.match(log, /VCM-A: the form would not take it/);
  await page.close();
});

test('generic Employment repeater: the empty entry gets job 1, "+ Add another" for the rest', async () => {
  const { page } = await run(path.join(OWN, 'employment-repeater.html'));
  const jobs = await page.evaluate(() => Array.from(document.querySelectorAll('.employment-entry')).map((d) => Array.from(d.querySelectorAll('input, select')).map((i) => (i.type === 'checkbox' ? String(i.checked) : i.value))));
  assert.deepStrictEqual(jobs, [
    ['Quillstone', 'Systems Reliability Engineer Intern', 'June', '2026', 'August', '2026', 'false'],
    ['Example State University', 'Research Assistant, Quantum Risk Modeling', 'August', '2026', '', '', 'true'],
    ['Example State University', 'Research Assistant, Grant-Funded Industrial Cybersecurity', 'November', '2025', '', '', 'true'],
    ['Gamma Project (Civic Lab)', 'Software Engineer', 'January', '2026', '', '', 'true'],
  ]);
  assert.strictEqual(await page.evaluate(() => document.getElementById('fn').value), 'Pat', 'fields outside the section untouched');
  await page.close();
});

test('JB.repeaters on the real Workday My Experience capture (Vanguard): three work panels with formField keys', async () => {
  const file = path.join(process.env.HOME, 'autofill', 'fixtures', 'stripped', 'workday', 'vanguard_wd5_myworkdayjobs_com_1790993112312.html');
  if (!fs.existsSync(file)) return;
  const page = await load(file);
  const r = await page.evaluate(() => JB.repeaters());
  assert.strictEqual(r.ats, 'workday');
  const work = r.sections.find((s) => s.kind === 'work');
  assert.strictEqual(work.entries.length, 3);
  assert.ok(work.add, 'Add Another found');
  assert.ok(work.entries.every((e) => e.del), 'each panel has its Delete');
  assert.deepStrictEqual(work.entries[0].fields.map((f) => f.key), ['jobTitle', 'companyName', 'location', 'currentlyWorkHere', 'startDate', 'endDate', 'roleDescription']);
  assert.strictEqual(work.entries[0].fields.find((f) => f.key === 'startDate').kind, 'date');
  assert.ok(r.sections.some((s) => s.kind === 'edu'));
  await page.close();
});

test('iCIMS (IRONFIELD shape): Title-first blocks rewritten, "Add Work Experience" until all four jobs are there, education dates [slow]', async () => {
  const page = await load(path.join(OWN, 'icims-work-experience.html'));
  const saved = { page: C.page, send: C.send, profile: Data.profile };
  // The driver only rewrites history on iCIMS hosts: the saved page answers as one.
  C.page = async (tabId, fn, args) => {
    const result = await page.evaluate(([n, a]) => globalThis.JB[n](a), [fn, args || {}]);
    if (fn === 'snapshot') result.url = 'https://studentcareers-ironfield.icims.com/jobs/59576/candidate?csrf=1';
    return [{ frameId: 0, result }];
  };
  C.send = async () => [];
  Data.profile = () => PROFILE;
  const r = { tabId: 1, steps: [], uploads: {} };
  try {
    const out = await A.fixParsedHistory(r, await A.snapshot(1), RESUME_FILE, PROFILE);
    assert.ok(out.touched);
  } finally {
    Object.assign(C, { page: saved.page, send: saved.send });
    Data.profile = saved.profile;
  }
  const jobs = await page.evaluate(() => Array.from(document.querySelectorAll('.job')).map((d) => Array.from(d.querySelectorAll('input, select, textarea')).map((i) => i.value)));
  assert.deepStrictEqual(jobs.map((j) => [j[0], j[1], j[2], j[3], j[4], j[5], j[7], j[8], j[10]]), [
    ['Systems Reliability Engineer Intern', 'Quillstone', 'Smithtown', 'United States', 'North Carolina', 'Jun', '2026', 'Aug', '2026'],
    ['Research Assistant, Quantum Risk Modeling', 'Example State University', 'Springfield', 'United States', 'Virginia', 'Aug', '2026', '', ''],
    ['Research Assistant, Grant-Funded Industrial Cybersecurity', 'Example State University', 'Springfield', 'United States', 'Virginia', 'Nov', '2025', '', ''],
    ['Software Engineer', 'Gamma Project (Civic Lab)', 'Springfield', 'United States', 'Virginia', 'Jan', '2026', '', ''],
  ]);
  assert.strictEqual(jobs[0][11], '- Resolved 100+ cases\n- Shipped an integration', 'the parsed description is replaced by the bullets');
  const edu = await page.evaluate(() => ['d1', 'm1', 'g1', 'dg'].map((id) => document.getElementById(id).value).concat(Array.from(document.querySelectorAll('.dates select, .dates input')).map((i) => i.value)));
  assert.deepStrictEqual(edu, ['Bachelors', 'Information Technology', '3.7', 'No', 'Aug', '1', '2023', 'Dec', '1', '2027']);
  assert.match(r.steps.map((s) => s.msg).join('\n'), /3 job block\(s\) added/);
  await page.close();
});
