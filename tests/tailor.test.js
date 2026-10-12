'use strict';
// lib/tailor.js + tailor/lint.js: the never-untrue lint, the starting-point choice, skills reorder, grad-date rule and
// `jobctl tailor --build` (render stubbed). Offline; fixtures are synthetic (tests/fixtures/tailor, no personal data).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const T = require('../lib/tailor');
const L = require('../tailor/lint');

const FIX = path.join(__dirname, 'fixtures', 'tailor');
const FACTS_FILE = path.join(FIX, 'facts.md');
const facts = T.readFacts(FACTS_FILE);
const clone = (x) => JSON.parse(JSON.stringify(x));

/** A temp copy of the fixture resumes dir (build writes there), plus empty PDFs that name "companies sent to". */
function tmpDir(companies = ['Delta', 'Gamma']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-test-'));
  fs.cpSync(path.join(FIX, 'resumes'), dir, { recursive: true });
  for (const c of companies) fs.writeFileSync(path.join(dir, `PatExample_Resume_${c}.pdf`), '');
  return dir;
}
const dir = tmpDir();
const loaded = T.loadResumes(dir);
const master = loaded.master;
const lintOf = (r, extra = {}) => T.checkResume(r, { dir, loaded, factsFile: FACTS_FILE, facts, company: 'Beta', ...extra });
const errTypes = (res) => res.errors.map((e) => e.type);

test('readFacts: quoted alternates (even across lines), skill lists, claim items and the grad rule', () => {
  const texts = facts.alternates.map((a) => a.text);
  assert.ok(texts.includes('Shipped a lookup integration to production, cutting case lookup time 40%'));
  assert.ok(texts.some((t) => /^Built an n8n automation pipeline pulling daily threat data from 20 sources via APIs$/.test(t)), 'a quote that wraps onto the next line');
  assert.ok(!texts.some((t) => /Dec 2027|real\)/.test(t)), 'grad-date rule text is not a bullet');
  assert.ok(!texts.some((t) => /IT 160|Elementary/.test(t)), 'coursework is not a bullet');
  assert.strictEqual(facts.alternates.find((a) => /Widget Engine, an open/.test(a.text)).section, 'Widget Engine');
  assert.deepStrictEqual(facts.skillsRowOnly, ['Go']);
  assert.ok(facts.doNotClaimRaw.includes('Python backend work on Widget Engine') && facts.neverConfirmedRaw.includes('Glenfield'));
  assert.ok(facts.lightUse.includes('Northstone Foundry') && facts.confirmed.includes('Linux'));
  assert.deepStrictEqual([facts.gradDefault, facts.gradAlt], ['Dec 2027', 'May 2028']);
  assert.match(facts.clearanceLine, /eligible for Secret clearance/);
});

test('readFacts: the real facts.md still parses (alternates, claim lists, grad rule)', () => {
  const real = T.readFacts();
  assert.ok(real.alternates.length >= 3);
  assert.ok(!real.alternates.some((a) => /real\)\. It already/.test(a.text)));
  assert.ok(real.doNotClaimRaw.includes('Java') && real.neverConfirmedRaw.includes('Terraform'));
  assert.deepStrictEqual(real.skillsRowOnly, ['Go']);
  assert.deepStrictEqual([real.gradDefault, real.gradAlt], ['Dec 2027', 'May 2028']);
});

test('loadResumes: master apart, cover-letter JSON ignored, render.sh sidecar copies de-duplicated', () => {
  assert.deepStrictEqual(loaded.priors.map((p) => p.name), ['alpha-security', 'beta-software']);
  assert.ok(T.isResume(master) && !T.isResume({ closing: 'x', paragraphs: [] }));
});

test('lint: the fixture master and its priors are clean (no errors)', () => {
  assert.deepStrictEqual(lintOf(master).errors, []);
  assert.deepStrictEqual(lintOf(master).warnings, [], 'master lines are all sourced');
  for (const p of loaded.priors) assert.deepStrictEqual(lintOf(p.resume).errors, [], p.name);
});

test('lint: DO NOT CLAIM and never-confirmed items fail, in bullets and skills rows, any case', () => {
  const r = clone(master);
  r.experience[0].bullets[0] = 'Ran docker builds on kubernetes with Terraform for Glenfield dashboards';
  r.skills[1].items += ', Java, Splunk, Dockerfile, k8s, Jenkins';
  const res = lintOf(r, { company: 'Beta' });
  const items = res.errors.filter((e) => e.type === 'do-not-claim').map((e) => e.item).sort();
  assert.deepStrictEqual(items, ['Glenfield', 'Docker', 'Docker', 'Java', 'Kubernetes', 'Kubernetes', 'Splunk', 'Terraform'].sort());
  assert.strictEqual(res.ok, false);
});

test('lint: short tokens are matched as standalone, case-sensitive tokens', () => {
  const r = clone(master);
  r.experience[0].bullets[0] = 'Let teams go faster with C and JavaScript, storage and leverage tuning, and a ragged edge';
  r.skills[1].items += ', C, JavaScript';
  // (C and JavaScript are not in this fixture's sources, so they are skill-not-in-sources errors; this test is about
  // the DO NOT CLAIM token match only.)
  const claims = () => lintOf(r).errors.filter((e) => e.type !== 'skill-not-in-sources');
  assert.deepStrictEqual(claims(), [], '"go", "C", JavaScript, storage, leverage, ragged are not claims');
  r.experience[0].bullets[1] = 'Built RAG search and C# plugins';
  assert.deepStrictEqual(claims().map((e) => e.item).sort(), ['C#', 'RAG']);
});

test('lint: Go is a skill only (skills rows), never in a bullet; a Python backend claim is only caught on that project', () => {
  const r = clone(master);
  assert.ok(r.skills[1].items.includes('Go'));
  assert.deepStrictEqual(lintOf(r).errors, []);
  r.experience[0].bullets[0] = 'Wrote Go services that cut ticket volume';
  r.projects[0].bullets[0] = 'Contributed 12 pull requests to the Python backend of Widget Engine';
  r.projects[1].bullets[0] = 'Scripted Python backups for the home network';
  const errs = lintOf(r).errors;
  assert.deepStrictEqual(errs.map((e) => e.type).sort(), ['do-not-claim', 'skills-row-only']);
  assert.match(errs.find((e) => e.type === 'do-not-claim').where, /Widget Engine/);
});

test('lint: em dash and "Site Reliability" fail', () => {
  const r = clone(master);
  r.experience[0].bullets[1] = 'Earned a 33% survey response rate — and two vendor certifications';
  r.experience[0].title = 'Site Reliability Engineer Intern (SRE)';
  const types = errTypes(lintOf(r));
  assert.ok(types.includes('em-dash') && types.includes('sre-title'));
});

test('lint: another company in the text, or in the file name, fails; the target company is exempt', () => {
  const r = clone(master);
  r.experience[0].bullets[1] = 'Earned a 33% survey response rate and two vendor certifications for Delta';
  const res = lintOf(r, { company: 'Beta' });
  assert.deepStrictEqual(res.errors.map((e) => [e.type, e.text]), [['other-company', 'Delta']]);
  assert.deepStrictEqual(lintOf(r, { company: 'Delta' }).errors, [], 'a resume for Delta may name Delta');
  assert.deepStrictEqual(lintOf(clone(master), { company: 'Beta', file: '/x/PatExample_Resume_Delta.json' }).errors.map((e) => e.type), ['wrong-company-file']);
  assert.deepStrictEqual(lintOf(clone(master), { company: 'Beta', file: '/x/PatExample_Resume_Beta.json' }).errors, []);
  const noTarget = lintOf(clone(master), { company: undefined });
  assert.ok(noTarget.ok && noTarget.notes.some((n) => /company check skipped/.test(n)));
});

test('lint: a number that is in neither master nor facts is an invented metric', () => {
  const r = clone(master);
  r.experience[0].bullets[0] = 'Troubleshot Linux networking failures, resolving 50+ cases and cutting lookup time 83%';
  const bad = lintOf(r).errors.filter((e) => e.type === 'unsourced-number').map((e) => e.text);
  assert.deepStrictEqual(bad, ['83']);
  r.experience[0].bullets[0] = 'Cut case lookup time 40% while resolving 50+ cases';
  assert.deepStrictEqual(lintOf(r).errors, [], '40% is in facts.md');
});

test('lint: name, contact, school and a job\'s title / dates / location must match master; grad date is Dec 2027 or May 2028', () => {
  const r = clone(master);
  r.experience[0].dates = 'May 2026 - Aug 2026';
  r.experience[1].title = 'Lead Researcher';
  r.contact = 'other@example.com';
  r.education.school = 'Elsewhere University';
  const types = errTypes(lintOf(r));
  assert.strictEqual(types.filter((t) => t === 'job-fact-changed').length, 2);
  assert.strictEqual(types.filter((t) => t === 'header-changed').length, 2);
  const may = clone(master);
  may.education.date = 'May 2028';
  const res = lintOf(may);
  assert.ok(res.ok);
  assert.ok(res.warnings.some((w) => w.type === 'grad-date'), 'May 2028 is a warning (say so in the log line)');
  may.education.date = 'May 2029';
  assert.ok(errTypes(lintOf(may)).includes('grad-date'));
});

test('lint: reworded bullets are warnings with the closest source line and a score; verbatim master / alternates are not', () => {
  const r = clone(master);
  r.experience[0].bullets[0] = 'Troubleshot Linux networking failures across production clusters, resolving 50+ enterprise support cases in under four weeks'; // reworded master
  r.experience[1].bullets[0] = 'Assess vendor risk with graph models that rank likely attack paths across suppliers'; // verbatim alternate
  r.projects[0].bullets[1] = 'Wrote a quick brown fox jumps over lazy dogs while waiting'; // unrelated
  const w = lintOf(r).warnings.filter((x) => x.type === 'reworded-line');
  assert.strictEqual(w.length, 2);
  assert.ok(w.every((x) => x.score >= 0 && x.score <= 1 && x.closest && x.source));
  const near = w.find((x) => /under four weeks/.test(x.text));
  assert.strictEqual(near.source, 'master');
  assert.match(near.closest, /resolving 50\+ enterprise support cases in four weeks/);
  assert.ok(near.score > 0.8);
  assert.ok(w.find((x) => /fox/.test(x.text)).score < 0.4);
  assert.strictEqual(w[0].text.includes('fox'), true, 'least similar first');
});

test('lint: a bullet that wraps an approved fragment says so; a line seen in a prior resume says where', () => {
  const r = clone(master);
  r.experience[0].bullets[0] = 'Debugged Linux networking incidents, resolving 50+ enterprise customer cases in four weeks';
  const frag = lintOf(r).warnings.find((x) => x.type === 'reworded-line');
  assert.match(frag.source, /contains an approved fragment/);
  const prior = lintOf(loaded.priors.find((p) => p.name === 'beta-software').resume).warnings.find((x) => /Built a React dashboard/.test(x.text || ''));
  assert.strictEqual(prior.seenIn, 'beta-software');
});

test('lint: skills outside master / facts are ERRORS (review 2026-10-09); confirmed, light-use and experience phrases pass', () => {
  const r = clone(master);
  r.skills[1].items += ', Excel, Northstone Foundry, graph models, Prometheus, Kafka, Redis, GCP';
  const res = lintOf(r);
  const e = res.errors.filter((x) => x.type === 'skill-not-in-sources').map((x) => x.text);
  assert.deepStrictEqual(e, ['Prometheus', 'Kafka', 'Redis', 'GCP']);
  assert.strictEqual(res.ok, false);
});

test('lint: Docker / RAG spellings ("Dockerized", "retrieval-augmented") are DO NOT CLAIM errors', () => {
  const r = clone(master);
  r.experience[0].bullets[0] = 'Dockerized the build and added retrieval-augmented generation';
  const types = lintOf(r).errors.map((x) => `${x.type}:${x.text}`).join(' ');
  assert.match(types, /Docker/);
  assert.match(types, /RAG|retrieval/i);
});

test('lint: a Relevant Coursework line passes when every course is in facts section 5', () => {
  const r = clone(master);
  r.education.extra.push({ text: 'Relevant Coursework: Database Admin, Data Structures & Adv. Programming, Elementary Statistics' });
  assert.deepStrictEqual(lintOf(r).warnings, []);
  r.education.extra[1].text += ', Quantum Basket Weaving';
  assert.deepStrictEqual(lintOf(r).warnings.map((x) => [x.type, x.text]), [['coursework-not-in-facts', 'Quantum Basket Weaving']]);
});

test('chooseStart: the prior closest to the posting wins, master when none beats it, --from by name', () => {
  const sec = T.chooseStart('Threat modeling and vendor risk: attack graphs, attack paths, suppliers, choke points', master, loaded.priors);
  assert.strictEqual(sec.name, 'alpha-security');
  const sw = T.chooseStart('React dashboards, REST APIs, Git workflows and pipelines for self-hosted services', master, loaded.priors);
  assert.strictEqual(sw.name, 'beta-software');
  const none = T.chooseStart('Accounting clerk for payroll and invoices', master, loaded.priors);
  assert.strictEqual(none.name, 'master');
  assert.match(none.reason, /no prior beat master|best prior/);
});

test('reorderSkills: named skills lead (rows and items), the set never changes, nothing is added', () => {
  const text = 'We use React and PKI/TLS daily, on Linux hosts; Kubernetes a plus. Also Python.';
  const { skills, led } = T.reorderSkills(master.skills, text);
  assert.deepStrictEqual(led.slice(0, 2).sort(), ['PKI/TLS', 'React']);
  assert.deepStrictEqual(skills.map((s) => s.label), ['Software', 'Infrastructure', 'Automation'], 'the row with the most named skills leads; ties keep their order');
  const flat = (xs) => xs.flatMap((s) => L.splitTop(s.items)).sort();
  assert.deepStrictEqual(flat(skills), flat(master.skills));
  assert.ok(!flat(skills).includes('Kubernetes'));
  const first = (label) => L.splitTop(skills.find((s) => s.label === label).items)[0];
  assert.deepStrictEqual([first('Automation'), first('Infrastructure'), first('Software')], ['Python', 'Linux (RHEL)', 'React']);
  assert.deepStrictEqual(T.reorderSkills(master.skills, 'Nothing relevant here').skills, master.skills, 'no mention: order unchanged');
});

test('gradRule: May 2028 only when the posting requires 2028 graduates', () => {
  const g = (t) => T.gradRule(t, 'Dec 2027', 'May 2028').date;
  assert.strictEqual(g('Candidates must be graduating in May 2028 or later.'), 'May 2028');
  assert.strictEqual(g('Expected graduation: Spring or Summer 2028.'), 'May 2028');
  assert.strictEqual(g('Students graduating December 2027 or later.'), 'Dec 2027');
  assert.strictEqual(g('Open to those who graduate in Winter or Spring 2027/2028.'), 'Dec 2027');
  assert.strictEqual(g('You will graduate between December 2026 and June 2028.'), 'Dec 2027');
  assert.strictEqual(g('You must graduate no later than May 2028.'), 'Dec 2027');
  assert.strictEqual(g('Pursuing a degree in computer science. Build things.'), 'Dec 2027');
  assert.match(T.gradRule('Graduating in 2028.').evidence, /2028/);
});

test('companyName: file-name-safe, one company only', () => {
  assert.strictEqual(T.companyName('amberstone'), 'Amberstone');
  assert.strictEqual(T.companyName('Ironcrest'), 'Ironcrest');
  assert.strictEqual(T.companyName('Zephyrhaven, Inc.'), 'Zephyrhaven');
  assert.strictEqual(T.companyName('xAI'), 'xAI');
  assert.strictEqual(T.companyName('UMBERMOOR_Automation'), 'UMBERMOOR_Automation');
  assert.strictEqual(T.companyName('umbermoor_sysadmin'), 'Umbermoor_Sysadmin');
  assert.strictEqual(T.companyName('../evil/Co'), 'EvilCo');
});

test('parseRender: pages, lonely lines and repeated verbs from check_layout.py output', () => {
  const out = 'wrote x.pdf\nPages:           1\nLONELY LINES:\n  -> and Git\n  -> two words\nREPEATED VERBS:\n  -> Quillstone: 3+ bullets in a row start with "Built"\n';
  assert.deepStrictEqual(T.parseRender(out), { pages: 1, lonelyLines: ['and Git', 'two words'], repeatedVerbs: ['Quillstone: 3+ bullets in a row start with "Built"'] });
  assert.deepStrictEqual(T.parseRender('Pages: 2\nNo lonely lines.\n'), { pages: 2, lonelyLines: [], repeatedVerbs: [] });
});

const POSTING = { company: 'Epsilon Corp', title: 'Security Intern', text: 'Threat modeling and vendor risk with attack graphs. You know Python and Linux. Kubernetes is a plus. Candidates must be graduating in May 2028 or later.' };
const okRender = (json, outBase) => {
  fs.writeFileSync(`${outBase}.pdf`, 'pdf');
  return { code: 0, pages: 1, lonelyLines: [], repeatedVerbs: [] };
};

test('build: writes the draft from the best prior, leads skills, sets the grad date, lints; refuses to overwrite', async () => {
  const d = tmpDir();
  const r = await T.build(null, { slug: 'beta-sec', posting: POSTING, dir: d, factsFile: FACTS_FILE, render: okRender });
  const s = r.summary;
  assert.strictEqual(r.exit, 0);
  assert.strictEqual(s.status, 'ok');
  assert.strictEqual(s.startedFrom, 'alpha-security');
  assert.strictEqual(path.basename(s.pdf), 'PatExample_Resume_Epsilon.pdf');
  assert.strictEqual(s.json, path.join(d, 'beta-sec.json'));
  assert.strictEqual(s.gradDate.value, 'May 2028');
  assert.deepStrictEqual(s.skillsLed.slice(0, 2).sort(), ['Linux (RHEL)', 'Python']);
  assert.deepStrictEqual(s.gaps, ['Kubernetes']);
  assert.ok(s.alternates.length <= 3 && s.alternates.every((a) => a.text));
  assert.strictEqual(s.pages, 1);
  assert.strictEqual(s.check.ok, true);
  assert.strictEqual(s.check.carried, 1, 'the reworded line kept from the prior resume is counted, not listed');
  assert.deepStrictEqual(s.check.warnings.map((w) => w.type), ['grad-date']);
  const written = JSON.parse(fs.readFileSync(s.json, 'utf8'));
  assert.strictEqual(written.education.date, 'May 2028');
  assert.deepStrictEqual(written.experience, loaded.priors[0].resume.experience, 'bullets are untouched: wording stays the model\'s call');
  await assert.rejects(T.build(null, { slug: 'beta-sec', posting: POSTING, dir: d, factsFile: FACTS_FILE, render: okRender }), /refusing to overwrite/);
  const again = await T.build(null, { slug: 'beta-sec', posting: POSTING, dir: d, factsFile: FACTS_FILE, render: okRender, force: true });
  assert.strictEqual(again.exit, 0);
});

test('build: the default grad date comes back when the start had May 2028 and the posting does not require it; --from overrides', async () => {
  const d = tmpDir();
  const post = { company: 'Zed', title: 'Software Intern', text: 'React dashboards, REST APIs, Git workflows and pipelines.' };
  const auto = await T.build(null, { slug: 'zed', posting: post, dir: d, factsFile: FACTS_FILE, render: false });
  assert.strictEqual(auto.summary.startedFrom, 'beta-software');
  assert.strictEqual(auto.summary.gradDate.value, 'Dec 2027');
  const forced = await T.build(null, { slug: 'zed-m', posting: post, dir: d, factsFile: FACTS_FILE, render: false, from: 'master', company: 'ZedTwo' });
  assert.strictEqual(forced.summary.startedFrom, 'master');
  assert.strictEqual(path.basename(forced.summary.pdf), 'PatExample_Resume_ZedTwo.pdf');
  await assert.rejects(T.build(null, { slug: 'zed-x', posting: post, dir: d, factsFile: FACTS_FILE, render: false, from: 'nope' }), /no such resume/);
});

test('build: exit 2 when the lint fails or the render is not one page; a bad slug is refused', async () => {
  const d = tmpDir();
  const post = { company: 'Zed', title: 'x', text: 'Python and Linux.' };
  // a prior that went wrong: an invented claim in its bullets
  const bad = clone(master);
  bad.experience[0].bullets[0] = 'Ran Docker clusters at Delta';
  fs.writeFileSync(path.join(d, 'bad-prior.json'), JSON.stringify(bad));
  const auto = await T.build(null, { slug: 'z0', posting: { ...post, company: 'Zero', text: 'Docker clusters, Linux networking failures, Python.' }, dir: d, factsFile: FACTS_FILE, render: false });
  assert.notStrictEqual(auto.summary.startedFrom, 'bad-prior', 'a prior that fails the lint never seeds a draft');
  assert.match(auto.summary.startReason, /skipped 1 prior\(s\) that fail the lint: bad-prior/);
  const lintFail = await T.build(null, { slug: 'z1', posting: post, dir: d, factsFile: FACTS_FILE, render: okRender, from: 'bad-prior' });
  assert.strictEqual(lintFail.exit, 2);
  assert.strictEqual(lintFail.summary.status, 'lint-failed');
  assert.ok(lintFail.summary.check.errors.some((e) => e.type === 'do-not-claim'));
  const twoPages = await T.build(null, { slug: 'z2', posting: { ...post, company: 'Zee' }, from: 'master', dir: d, factsFile: FACTS_FILE, render: () => ({ code: 2, pages: 2, lonelyLines: ['x y'], repeatedVerbs: [] }) });
  assert.deepStrictEqual([twoPages.exit, twoPages.summary.status, twoPages.summary.pages], [2, 'not-one-page', 2]);
  for (const slug of ['master', '../x', '', 'a b']) await assert.rejects(T.build(null, { slug, posting: post, dir: d, factsFile: FACTS_FILE, render: false }), /slug/);
});

test('build: --text-file needs --company; reads the posting from the file (no network)', async () => {
  const f = path.join(os.tmpdir(), `tailor-posting-${process.pid}.txt`);
  fs.writeFileSync(f, 'Threat modeling with attack graphs.');
  try {
    await assert.rejects(T.build(null, { slug: 'q', textFile: f, dir: tmpDir(), factsFile: FACTS_FILE, render: false }), /--company/);
    const r = await T.build(null, { slug: 'q', textFile: f, company: 'Q Labs', dir: tmpDir(), factsFile: FACTS_FILE, render: false });
    assert.strictEqual(r.summary.company, 'QLabs');
  } finally {
    fs.rmSync(f, { force: true });
  }
});

test('cli: --check returns the lint (exit 2 on errors), usage errors throw', async () => {
  const bad = clone(master);
  bad.experience[0].bullets[0] = 'Used Terraform';
  const f = path.join(dir, 'PatExample_Resume_Beta.json');
  fs.writeFileSync(f, JSON.stringify(bad));
  const r = await T.cli({ args: [], flags: { check: f } }, { dir, factsFile: FACTS_FILE });
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.out.company, 'Beta', 'company taken from the file name');
  fs.writeFileSync(f, JSON.stringify(master));
  assert.strictEqual((await T.cli({ args: [], flags: { check: f, company: 'Beta' } }, { dir, factsFile: FACTS_FILE })).code, 0);
  await assert.rejects(T.cli({ args: [], flags: { check: true } }), /usage/);
  await assert.rejects(T.cli({ args: ['https://x'], flags: { build: true } }), /usage/);
  await assert.rejects(T.cli({ args: [], flags: {} }), /usage/);
});

// ---- 2026-10-09 fix pass: approved compositions, moved lines, diffs, carried lines, names, --finish ------------------

test('lint: a master line with an approved fragment spliced in, or a synonym start verb, is not a reworded line', () => {
  const r = clone(master);
  r.experience[0].bullets[0] = 'Troubleshot Linux networking failures across production clusters, resolving 50+ enterprise customer cases in four weeks';
  r.experience[1].bullets[1] = 'Develop graph models ranking likely attack paths and shared choke points across vendor systems';
  const res = lintOf(r);
  assert.deepStrictEqual(res.warnings.filter((w) => w.type === 'reworded-line'), []);
  assert.strictEqual(res.composed.length, 2);
  assert.deepStrictEqual(res.composed.find((c) => /Develop/.test(c.text)).verb, ['develop', 'build']);
  // A changed noun next to the swapped verb is still a reword; "Led" is never a free swap.
  r.experience[0].bullets[0] = 'Debugged Linux networking incidents across production clusters, resolving 50+ enterprise support cases in four weeks';
  r.experience[1].bullets[1] = 'Led graph models ranking likely attack paths and shared choke points across vendor systems';
  assert.strictEqual(lintOf(r).warnings.filter((w) => w.type === 'reworded-line').length, 2);
});

test('lint: an approved fragment only counts under its own job; dropping a trailing parenthetical says less, so it passes', () => {
  const r = clone(master);
  r.experience[1].bullets[0] = 'Model how attackers pivot from IT networks into building systems, resolving 50+ enterprise customer cases in four weeks';
  assert.strictEqual(lintOf(r).warnings.filter((w) => w.type === 'reworded-line').length, 1, 'the Acme fragment under the research job');
  const m2 = clone(master);
  m2.experience[0].bullets[1] = 'Earned a 33% survey response rate and two vendor certifications (Alpha, Beta)';
  const r2 = clone(m2);
  r2.experience[0].bullets[1] = 'Earned a 33% survey response rate and two vendor certifications';
  const res = L.lint(r2, { facts, master: m2, priors: [], knownCompanies: [] });
  assert.deepStrictEqual(res.warnings, []);
  // ...but not when the parenthetical qualifies a superlative left in the line (that would overclaim).
  const m3 = clone(master);
  m3.experience[0].bullets[1] = 'Resolved the highest case volume (among the summer interns)';
  const r3 = clone(m3);
  r3.experience[0].bullets[1] = 'Resolved the highest case volume';
  assert.strictEqual(L.lint(r3, { facts, master: m3, priors: [], knownCompanies: [] }).warnings.filter((w) => w.type === 'reworded-line').length, 1);
});

test('lint: a true source line under another job is a moved-line error (it would claim work done elsewhere)', () => {
  const r = clone(master);
  r.experience[0].bullets[1] = 'Assess vendor risk with graph models that rank likely attack paths across suppliers'; // research alternate
  r.projects[0].bullets[1] = 'Held 99.9% uptime for self-hosted services with Grafana dashboards'; // Home Lab master line
  const res = lintOf(r);
  const moved = res.errors.filter((e) => e.type === 'moved-line');
  assert.strictEqual(moved.length, 2);
  assert.match(moved[0].detail, /Research Assistant, Threat Modeling/);
  assert.match(moved[1].detail, /Home Lab/);
  assert.strictEqual(res.ok, false);
  // A project name that grows a link keeps its home.
  const linked = clone(master);
  linked.projects[0].name = 'Widget Engine, Open Source Contributor (github.com/example)';
  assert.deepStrictEqual(lintOf(linked).errors.filter((e) => e.type === 'moved-line'), []);
});

test('lint: a reworded line lists exactly what was added and dropped against its closest source', () => {
  const r = clone(master);
  r.projects[0].bullets[1] = 'Shipped UI and UX improvements across the React and TypeScript frontend';
  const w = lintOf(r).warnings.find((x) => x.type === 'reworded-line');
  assert.deepStrictEqual([w.added, w.dropped], [['and UX', 'and TypeScript'], []]);
  assert.deepStrictEqual(L.wordDiff('Built a CI/CD pipeline that tests models', 'Built a CI/CD regression pipeline that tests and retrains models'), { added: [], dropped: ['regression', 'and retrains'] });
});

test('check: lines already in another lint-passing tailored resume are carried, not re-listed; the file itself never counts', () => {
  const d = tmpDir();
  const prior = loaded.priors.find((p) => p.name === 'beta-software');
  const reworded = prior.resume.projects[1].bullets[1]; // "Built a React dashboard pipeline ..." (a reword in that prior)
  // The prior itself (and its identical sidecar copy) never vouches for its own reword.
  const self = T.checkFile(path.join(d, 'beta-software.json'), { dir: d, factsFile: FACTS_FILE, company: 'Beta' });
  assert.ok(self.warnings.some((w) => w.text === reworded), 'its own reword is still listed when the prior itself is checked');
  const r = clone(master);
  r.projects[1].bullets[1] = reworded;
  const f = path.join(d, 'new-one.json');
  fs.writeFileSync(f, JSON.stringify(r));
  const res = T.checkFile(f, { dir: d, factsFile: FACTS_FILE, company: 'Beta' });
  assert.deepStrictEqual(res.warnings.filter((w) => w.type === 'reworded-line'), []);
  assert.deepStrictEqual(res.carried, [{ where: 'Home Lab #2', seenIn: 'beta-software', text: reworded }]);
});

test('roleTag: two telling words of a title, never generic ones', () => {
  assert.strictEqual(T.roleTag('DevOps & AI Engineering Intern (Undergraduate)'), 'DevOpsAI');
  assert.strictEqual(T.roleTag('Backend Software Engineer Intern - C#, Cloud Security & AI (Undergraduate)'), 'BackendSoftware');
  assert.strictEqual(T.roleTag('2027 Summer Intern – Autonomous Driving Software Engineer'), 'AutonomousDriving');
  assert.strictEqual(T.roleTag('Early Careers - Security Engineering Senior Intern'), 'Security');
  assert.strictEqual(T.roleTag('Intern'), 'Role');
});

test('build: a second posting at one company gets a role tag; a slug of another posting is never overwritten', async () => {
  const d = tmpDir();
  const one = await T.build('https://jobs.example/1', { slug: 'eps', posting: POSTING, dir: d, factsFile: FACTS_FILE, render: okRender });
  assert.strictEqual(path.basename(one.summary.pdf), 'PatExample_Resume_Epsilon.pdf');
  assert.strictEqual(T.readRecord(d, 'eps').outBase, one.summary.outBase);
  // Same company, other posting, same slug asked: new slug, tagged name; nothing of the first is touched.
  const two = await T.build('https://jobs.example/2', { slug: 'eps', posting: { ...POSTING, title: 'Cloud Platform Intern' }, dir: d, factsFile: FACTS_FILE, render: okRender });
  assert.deepStrictEqual([two.summary.slug, path.basename(two.summary.pdf)], ['eps-2', 'PatExample_Resume_Epsilon_CloudPlatform.pdf']);
  assert.match(two.summary.renamed, /belongs to another posting/);
  assert.strictEqual(two.exit, 0);
  assert.ok(fs.existsSync(path.join(d, 'eps.json')) && T.readRecord(d, 'eps').outBase === one.summary.outBase);
  // The lint takes the tagged name as the same company.
  assert.deepStrictEqual(two.summary.check.errors, []);
  // Same posting again: refused without --force (keep the edits with --finish); with --force it rebuilds in place.
  await assert.rejects(T.build('https://jobs.example/2', { slug: 'eps-2', posting: POSTING, dir: d, factsFile: FACTS_FILE, render: okRender }), /--finish eps-2/);
  const again = await T.build('https://jobs.example/2', { slug: 'eps-2', posting: { ...POSTING, title: 'Cloud Platform Intern' }, dir: d, factsFile: FACTS_FILE, render: okRender, force: true });
  assert.strictEqual(path.basename(again.summary.pdf), 'PatExample_Resume_Epsilon_CloudPlatform.pdf', 'its own name again, not a third one');
  // Files from before build records (an old Gamma PDF) are another posting's.
  const g = await T.build('https://jobs.example/3', { slug: 'gam', posting: { ...POSTING, company: 'Gamma', title: 'Network Intern' }, dir: d, factsFile: FACTS_FILE, render: false });
  assert.strictEqual(path.basename(g.summary.pdf), 'PatExample_Resume_Gamma_Network.pdf');
});

test('build: the summary carries the posting file, keywords, bullets by id, alternates marked in-draft, and the report', async () => {
  const d = tmpDir();
  const { summary: s } = await T.build('https://jobs.example/9', { slug: 'k', posting: POSTING, dir: d, factsFile: FACTS_FILE, render: okRender });
  assert.match(fs.readFileSync(s.postingFile, 'utf8'), /^Security Intern\n\nThreat modeling/);
  assert.ok(s.keywords.includes('attack') && s.keywords.includes('python') && !s.keywords.includes('epsilon'));
  assert.deepStrictEqual(s.bullets.slice(0, 2).map((b) => [b.id, b.where]), [['e0.0', 'Quillstone #1'], ['e0.1', 'Quillstone #2']]);
  assert.ok(s.alternates.some((a) => a.inDraft), 'the prior already holds the vendor-risk alternate');
  assert.match(s.report, /^pdf: .*PatExample_Resume_Epsilon\.pdf\ndocx: .*\.docx\nchanged: started from alpha-security; no bullet edits; skills led: .*; grad May 2028; gaps: Kubernetes\nwarnings: grad May 2028/);
  const text = T.summaryText(s);
  assert.match(text, /^status: ok \(1 page\) \| next: /);
  assert.match(text, /\n {2}e1\.0 Example State University #1: Assess vendor risk/);
  assert.match(text, /--- report \(return exactly this\) ---\npdf: /);
});

test('finish: applies bullet edits by id, renders, lints, and reports each changed bullet with its source', async () => {
  const d = tmpDir();
  await T.build('https://jobs.example/5', { slug: 'f', posting: POSTING, dir: d, factsFile: FACTS_FILE, render: okRender, from: 'master' });
  const edits = [
    { id: 'e0.0', text: 'Troubleshot Linux networking failures across production clusters, resolving 50+ enterprise customer cases in four weeks' },
    { after: 'e0.1', text: 'Shipped a lookup integration to production, cutting case lookup time 40%' },
    { id: 'p1.1', drop: true },
  ];
  const r = await T.finish('f', { dir: d, factsFile: FACTS_FILE, render: okRender, edits });
  assert.strictEqual(r.exit, 0, JSON.stringify(r.summary.todo));
  const saved = JSON.parse(fs.readFileSync(path.join(d, 'f.json'), 'utf8'));
  assert.strictEqual(saved.experience[0].bullets.length, 3);
  assert.strictEqual(saved.projects[1].bullets.length, 1);
  assert.match(r.summary.report, /changed: started from master; bullets: Quillstone #1 = source line \+ approved fragment, Quillstone #3 = Quillstone alternate; 2 start bullets replaced or cut;/);
  assert.match(r.summary.report, /\nwarnings: grad May 2028/);
  // Drift is listed with its diff; a lonely line from the render is a todo (exit 2).
  const drift = await T.finish('f', { dir: d, factsFile: FACTS_FILE, render: () => ({ code: 0, pages: 1, lonelyLines: ['four weeks'], repeatedVerbs: [] }), edits: [{ id: 'e0.1', text: 'Earned a 33% survey response rate and two hard vendor certifications' }] });
  assert.strictEqual(drift.exit, 2);
  assert.match(drift.summary.todo.join('\n'), /LONELY LINE "four weeks"/);
  assert.match(drift.summary.report, /Quillstone #2: "Earned a 33% survey response rate and two hard vendor[^"]*" \+"hard" \(closest master 0\.\d+\)/);
  await assert.rejects(T.finish('f', { dir: d, factsFile: FACTS_FILE, render: false, edits: [{ id: 'x9', text: 'a' }] }), /not a bullet id/);
  await assert.rejects(T.finish('nope', { dir: d, factsFile: FACTS_FILE, render: false }), /no build record/);
});

test('cli: --finish reads the edits from stdin and prints the text summary ending in the report; --json gives the object', async () => {
  const d = tmpDir();
  await T.build('https://jobs.example/6', { slug: 'c', posting: POSTING, dir: d, factsFile: FACTS_FILE, render: okRender });
  const r = await T.cli({ args: [], flags: { finish: 'c', edits: '-' } }, { dir: d, factsFile: FACTS_FILE, render: okRender, stdin: '[{"id":"e1.1","text":"Develop graph models ranking likely attack paths and shared choke points across vendor systems"}]' });
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /--- report \(return exactly this\) ---\npdf: [^\n]+\ndocx: [^\n]+\nchanged: [^\n]*Example State University #2 = verb swap develop for build/);
  const j = await T.cli({ args: [], flags: { finish: 'c', json: true } }, { dir: d, factsFile: FACTS_FILE, render: okRender });
  assert.strictEqual(j.out.status, 'ok');
});
