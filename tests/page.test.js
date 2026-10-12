/*
 * Offline tests of agent/page.js against Formhand's saved application pages
 * (~/autofill/fixtures, network blocked), in Playwright's Firefox. No live site,
 * no extension: the same script files the extension injects are added as page scripts.
 */
'use strict';
const nodeTest = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
let firefox;
try {
  ({ firefox } = require(path.join(process.env.HOME, 'autofill', 'node_modules', 'playwright')));
} catch (e) {
  // These tests need a Formhand checkout (~/autofill) with Playwright installed; without it the file is skipped.
  console.log('page.test.js skipped: Playwright not found under ~/autofill/node_modules');
  process.exit(0);
}
// Tests that fill from the user's own data/profile.json are skipped (not failed) when that private file does not exist.
const test = Object.assign((name, ...rest) => {
  const fn = rest.pop();
  return nodeTest(name, ...rest, async (t) => {
    try {
      return await fn(t);
    } catch (e) {
      if (/could not read .*profile\.json/.test(String(e && e.message))) return t.skip('needs your own data/profile.json');
      throw e;
    }
  });
}, nodeTest);

const EXT = path.join(__dirname, '..', 'extension');
const FILES = fs.readFileSync(path.join(EXT, 'agent', 'background.js'), 'utf8').match(/const FILES = \[([\s\S]*?)\];/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
const FIX = path.join(process.env.HOME, 'autofill', 'fixtures');
const D = require('../lib/data');

let browser;
test.before(async () => {
  browser = await firefox.launch();
});
test.after(async () => browser && browser.close());

async function load(file) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/*', (r) => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await page.goto('file://' + file);
  for (const f of FILES) await page.addScriptTag({ path: path.join(EXT, f) });
  return page;
}

function firstFixture(dir) {
  const d = path.join(FIX, dir);
  if (!fs.existsSync(d)) return null;
  const f = fs.readdirSync(d).find((x) => x.endsWith('.html') && !x.includes('dropdown'));
  return f ? path.join(d, f) : null;
}

test('generic basic form: snapshot lists fields and buttons', async () => {
  const page = await load(path.join(FIX, 'generic', 'basic.html'));
  const s = await page.evaluate(() => JB.snapshot());
  assert.ok(s.fields.length >= 3, 'fields found');
  assert.ok(s.fields.every((f) => f.ref), 'every field has a ref');
  assert.strictEqual(s.signals.confirmation, false);
  await page.close();
});

test('generic basic form: fill uses the owner profile', async () => {
  const page = await load(path.join(FIX, 'generic', 'basic.html'));
  const out = await page.evaluate((data) => JB.fill(data), D.fillData());
  assert.ok(out.counts.filled > 0, 'something filled');
  const email = await page.evaluate(() => Array.from(document.querySelectorAll('input')).map((i) => i.value).find((v) => v.includes('@')));
  assert.strictEqual(email, D.profile().profile.email);
  await page.close();
});

test('set + options on a native select and text field', async () => {
  const page = await load(path.join(FIX, 'generic', 'basic.html'));
  const s = await page.evaluate(() => JB.snapshot());
  const text = s.fields.find((f) => ['text', 'email', 'tel'].includes(f.kind));
  const r = await page.evaluate((ref) => JB.set({ ref, value: 'hello world' }), text.ref);
  assert.ok(r.ok, JSON.stringify(r));
  const sel = s.fields.find((f) => f.kind === 'select');
  if (sel) {
    const opts = await page.evaluate((ref) => JB.options({ ref }), sel.ref);
    assert.ok(opts.length > 0);
    const r2 = await page.evaluate(([ref, v]) => JB.set({ ref, value: v }), [sel.ref, opts[opts.length - 1]]);
    assert.ok(r2.ok, JSON.stringify(r2));
  }
  await page.close();
});

test('consent boxes are refused unless the owner policy allows them', async () => {
  const page = await load(path.join(FIX, 'generic', 'compliance.html'));
  const s = await page.evaluate(() => JB.snapshot());
  const box = s.fields.find((f) => f.consent);
  if (!box) return; // fixture has none
  const r = await page.evaluate((ref) => JB.set({ ref, value: 'yes' }), box.ref);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.consent, true);
  await page.close();
});

test('upload puts a file into the resume input', async () => {
  const file = firstFixture('greenhouse');
  if (!file) return;
  const page = await load(file);
  const b64 = Buffer.from('%PDF-1.4 test').toString('base64');
  const r = await page.evaluate((b) => JB.upload({ which: 'resume', name: 'resume.pdf', mime: 'application/pdf', b64: b }), b64);
  assert.ok(r.ok, JSON.stringify(r));
  await page.close();
});

test('upload: Workday clears its input but lists the file name = ok (UMBERMOOR 2026-10-09)', async () => {
  const page = await load(path.join(__dirname, 'fixtures', 'workday-upload-clears.html'));
  const b64 = Buffer.from('%PDF-1.4 test').toString('base64');
  const r = await page.evaluate((b) => JB.upload({ which: 'resume', name: 'PatExample_Resume_UMBERMOOR.pdf', mime: 'application/pdf', b64: b }), b64);
  assert.ok(r.ok, JSON.stringify(r));
  await page.close();
});

for (const ats of ['greenhouse', 'workday', 'avature', 'eightfold', 'phenom']) {
  // [slow]: the engine waits out its popup timeouts on saved pages (greenhouse ~57 s, eightfold ~43 s, workday ~16 s).
  // scripts/test.sh skips these on the fast run; `bash scripts/test.sh all` runs them.
  const slow = ['greenhouse', 'eightfold', 'workday'].includes(ats) ? ' [slow]' : '';
  test(`${ats} capture: fill runs and reports needs with refs${slow}`, async () => {
    const file = firstFixture(ats);
    if (!file) return;
    const page = await load(file);
    const out = await page.evaluate((data) => JB.fill(data), D.fillData());
    assert.ok(Array.isArray(out.needs));
    assert.ok(out.fields.every((f) => f.ref));
    const s = await page.evaluate(() => JB.snapshot());
    assert.ok(s.buttons.length > 0);
    console.log(`  ${ats}: adapter=${out.adapter} filled=${out.counts.filled} needs=${out.needs.length} [${out.needs.slice(0, 4).map((n) => n.label.slice(0, 40)).join(' | ')}]`);
    await page.close();
  });
}

/* Regressions from live runs (tests/fixtures, jobbot's own pages). */
const OWN = path.join(__dirname, 'fixtures');

test('react-select: async search survives blur-clearing and a stale default list (Greenhouse School)', async () => {
  const page = await load(path.join(OWN, 'widgets.html'));
  const s = await page.evaluate(() => JB.snapshot());
  const school = s.fields.find((f) => /^School/.test(f.label));
  assert.ok(school, 'School listed while empty');
  const r = await page.evaluate((ref) => JB.set({ ref, value: 'Example State University' }), school.ref);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.chose, 'Example State University');
  // Picked: the input is opacity 0, the value shows beside it. Still listed, with the value.
  const s2 = await page.evaluate(() => JB.snapshot());
  const after = s2.fields.find((f) => /^School/.test(f.label));
  assert.ok(after, 'School still listed after the pick');
  assert.strictEqual(after.value, 'Example State University');
  await page.close();
});

test('long labels keep the question at the end', async () => {
  const page = await load(path.join(OWN, 'widgets.html'));
  const s = await page.evaluate(() => JB.snapshot());
  const gov = s.fields.find((f) => f.kind === 'select');
  assert.ok(gov.label.length <= 200, 'still capped');
  assert.match(gov.label, /^Acme adheres/);
  assert.match(gov.label, /Are you related to a government official\?\*$/);
  await page.close();
});

test('Lever: labels are the question, not the field (wrapping <label>, sibling .application-label, ✱)', async () => {
  const page = await load(path.join(OWN, 'lever.html'));
  const s = await page.evaluate(() => JB.snapshot());
  const by = (re) => s.fields.find((f) => re.test(f.label));
  const loc = by(/^Current location/);
  assert.ok(loc, JSON.stringify(s.fields.map((f) => f.label)));
  assert.doesNotMatch(loc.label, /No location found|Loading/);
  assert.ok(loc.required);
  const radio = s.fields.find((f) => f.kind === 'radio');
  assert.match(radio.label, /^Will this be your final internship before graduating\?/);
  assert.ok(radio.required, 'radio group required');
  const boxes = s.fields.find((f) => f.kind === 'checkboxes');
  assert.match(boxes.label, /^Language Skill\(s\)/);
  await page.close();
});

test('Lever: fill reports a checkbox group once, flags typed signatures', async () => {
  const page = await load(path.join(OWN, 'lever.html'));
  const out = await page.evaluate((data) => JB.fill(data), D.fillData());
  const langs = out.needs.filter((n) => /Language|English|Spanish|French/.test(n.label));
  assert.strictEqual(langs.length, 1, JSON.stringify(langs.map((n) => n.label)));
  assert.match(langs[0].label, /^Language Skill/);
  const sig = out.fields.filter((f) => f.signature).map((f) => f.label);
  assert.deepStrictEqual(sig.sort(), ['Date', 'Name']);
  const hs = await page.evaluate(() => document.querySelector('select').value);
  assert.strictEqual(hs, '', 'high-school year left empty');
  await page.close();
});

test('Lever: location box gets a pick from its suggestions (cleared on blur otherwise)', async () => {
  const page = await load(path.join(OWN, 'lever.html'));
  const s = await page.evaluate(() => JB.snapshot());
  const loc = s.fields.find((f) => /^Current location/.test(f.label));
  const r = await page.evaluate((ref) => JB.set({ ref, value: 'Shoreville, VA', query: 'Shoreville' }), loc.ref);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.chose, 'Shoreville, VA, USA');
  assert.match(await page.evaluate(() => document.getElementById('selected-location').value), /Shoreville, VA, USA/);
  await page.close();
});

test('Ashby (real capture): yes/no buttons, per-option-named checkbox groups, title-class required', async () => {
  const page = await load(path.join(OWN, 'ashby.html'));
  const s = await page.evaluate(() => JB.snapshot());
  const by = (re) => s.fields.find((f) => re.test(f.label));
  const anchor = by(/Anchor Days/);
  assert.ok(anchor && anchor.kind === 'buttons', 'yes/no buttons are a field');
  assert.deepStrictEqual(anchor.options, ['Yes', 'No']);
  assert.ok(anchor.required, 'required via the title class');
  const reloc = by(/^Please indicate all of the locations/);
  assert.strictEqual(reloc.kind, 'checkboxes');
  assert.deepStrictEqual(reloc.options, ['New York, NY', 'San Francisco, CA']);
  assert.ok(!s.fields.some((f) => f.label === 'New York, NY'), 'no per-box fields');
  assert.ok(by(/^How did you hear/) && !by(/^How did you hear/).required, 'optional group stays optional');
  assert.strictEqual(by(/^Graduation Date/).label, 'Graduation Date', 'no calendar text in the label');
  // (Pressing a button is checked live: the capture has no scripts, so nothing toggles aria-pressed.)
  await page.close();
});

test('Copperstone (real capture, company-built): one fieldset per option, dial-code-only phone is empty', async () => {
  const page = await load(path.join(OWN, 'copperstone.html'));
  const s = await page.evaluate(() => JB.snapshot());
  const radios = s.fields.filter((f) => f.kind === 'radio').map((f) => f.label);
  assert.ok(radios.includes('How did you hear about this opportunity?*'), JSON.stringify(radios));
  assert.ok(radios.includes('Are you legally authorized to work in the country where this role is located?*'));
  assert.ok(!radios.some((l) => /^(Yes|No|LinkedIn|Copperstone Employee Referral)$/.test(l)), 'no option text as a question');
  const phone = s.fields.find((f) => f.kind === 'tel');
  assert.strictEqual(phone.value, '', '"+1 " alone is an empty phone');
  await page.close();
});

test('file slots are classified by their question, not the "Attach" button (resume went into the transcript slot)', async () => {
  const gh = await load(path.join(OWN, 'greenhouse-files.html'));
  const files = (await gh.evaluate(() => JB.snapshot())).fields.filter((f) => f.kind === 'file');
  const kinds = files.map((f) => f.for);
  assert.deepStrictEqual(kinds, ['resume', 'cover', 'transcript'], JSON.stringify(files.map((f) => [f.label, f.for])));
  await gh.close();
  const ash = await load(path.join(OWN, 'ashby.html'));
  const af = (await ash.evaluate(() => JB.snapshot())).fields.filter((f) => f.kind === 'file').map((f) => f.for);
  assert.deepStrictEqual(af.sort(), ['autofill', 'resume']);
  await ash.close();
});

test('options: same meaning, other words (No / I am not; prefer not / decline), never a guess between two', async () => {
  const page = await load(path.join(OWN, 'options.html'));
  const s = await page.evaluate(() => JB.snapshot());
  const ref = (re) => s.fields.find((f) => re.test(f.label)).ref;
  const set = (r, v) => page.evaluate(([x, y]) => JB.set({ ref: x, value: y }), [r, v]);
  assert.strictEqual((await set(ref(/^Veteran/), 'No')).value, 'I am not a protected veteran');
  assert.strictEqual((await set(ref(/^Veteran/), 'Prefer not to say')).value, "I don't wish to answer");
  assert.strictEqual((await set(ref(/^Disability/), 'Prefer not to say')).value, 'Decline to self-identify');
  assert.strictEqual((await set(ref(/^Two kinds/), 'Nope')).ok, false, 'two "No" options: no guess');
  await page.close();
});

test('follow-up boxes ("Please specify") are named after the question they follow', async () => {
  const page = await browser.newPage();
  await page.setContent(`<form><label for="r">What is your race or ethnicity?*</label><select id="r"><option>Two or More Races</option></select>
    <label for="s">Please specify</label><input id="s" type="text"><label for="n">Name</label><input id="n"></form>`);
  for (const f of FILES) await page.addScriptTag({ path: path.join(EXT, f) });
  const labels = (await page.evaluate(() => JB.snapshot())).fields.map((f) => f.label);
  assert.ok(labels.includes('What is your race or ethnicity? / Please specify'), JSON.stringify(labels));
  assert.ok(labels.includes('Name'));
  await page.close();
});

test('Greenhouse: a checkbox group already answered is not asked again on the next fill (Embervale term)', async () => {
  const page = await load(path.join(__dirname, 'fixtures', 'greenhouse-term-checkboxes.html'));
  const first = await page.evaluate((data) => JB.fill(data), D.fillData());
  const term = first.needs.find((n) => n.kind === 'checkboxes');
  assert.ok(term, 'empty required term group is a need');
  const set = await page.evaluate((ref) => JB.set({ ref, value: 'Summer (May - September 2027)' }), term.ref);
  assert.strictEqual(set.value, 'Summer (May - September 2027)');
  const again = await page.evaluate((data) => JB.fill(data), D.fillData());
  assert.ok(!again.needs.some((n) => n.kind === 'checkboxes'), 'answered group not reported as a need');
  const checked = await page.evaluate(() => Array.from(document.querySelectorAll('input[type=checkbox]')).map((i) => i.checked));
  assert.deepStrictEqual(checked, [false, true], 'the refill left the answer alone');
  await page.close();
});

test('multi-select combobox takes "A; B; C" as one pick each; typed text with no pick is not "ok" (Glenfield)', async () => {
  const page = await load(path.join(__dirname, 'fixtures', 'multi-combo.html'));
  await page.evaluate(() => JB.snapshot());
  const ref = await page.evaluate(() => document.getElementById('lang').getAttribute('data-jb-ref'));
  const r = await page.evaluate((ref) => JB.set({ ref: '' + ref, value: 'Python; Go; Typescript' }), ref);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const shown = await page.evaluate(() => Array.from(document.querySelectorAll('.select__multi-value__label')).map((n) => n.textContent));
  assert.deepStrictEqual(shown, ['Python', 'Go', 'Typescript']);
  const gref = await page.evaluate(() => document.getElementById('gd').getAttribute('data-jb-ref'));
  const g = await page.evaluate((ref) => JB.set({ ref: '' + ref, value: 'December 2027' }), gref);
  assert.strictEqual(g.ok, false, 'typed text left in a react-select box is not a pick');
  await page.close();
});

test('dropdown options come from the field\'s own menu, not one left open by another field; async lists take a search (Northfield, Elmstone)', async () => {
  const page = await load(path.join(__dirname, 'fixtures', 'two-menus.html'));
  await page.evaluate(() => JB.snapshot());
  const ref = (id) => page.evaluate((id) => document.getElementById(id).getAttribute('data-jb-ref'), id);
  const gd = await ref('gd');
  const opts = await page.evaluate((r) => JB.options({ ref: r }), gd);
  assert.deepStrictEqual(opts, ['Fall 2027', 'Spring 2028']);
  const pick = await page.evaluate((r) => JB.set({ ref: r, value: 'Fall 2027' }), gd);
  assert.strictEqual(pick.ok, true, JSON.stringify(pick));
  assert.strictEqual(await page.evaluate(() => document.querySelector('#gd-ctl .select__single-value').textContent), 'Fall 2027');
  const dis = await ref('dis');
  const found = await page.evaluate((r) => JB.options({ ref: r, query: 'info' }), dis);
  assert.deepStrictEqual(found, ['Information Systems']);
  await page.close();
});

test('a radio the page pre-selected is still asked (not taken as the owner\'s answer)', async () => {
  const page = await browser.newPage();
  await page.setContent(`<form><fieldset><legend>Will you now or in the future require sponsorship? *</legend>
    <label><input type="radio" name="sp" value="y" required> Yes</label><label><input type="radio" name="sp" value="n" checked required> No</label></fieldset>
    <button type="submit">Submit</button></form>`);
  for (const f of FILES) await page.addScriptTag({ path: path.join(EXT, f) });
  const out = await page.evaluate((data) => JB.fill(data), { ...D.fillData(), qaEntries: [], standardAnswers: {} });
  const sp = out.fields.find((x) => /sponsorship/i.test(x.label));
  assert.ok(sp, 'field listed');
  assert.ok(out.needs.some((n) => n.ref === sp.ref), 'a page default must still be asked, not marked answered');
  await page.close();
});

test('Oracle my-profile toast "Thank you for your job application." counts as a confirmation', async () => {
  const page = await load(path.join(__dirname, 'fixtures', 'oracle-applied-toast.html'));
  const s = await page.evaluate(() => JB.snapshot());
  assert.strictEqual(s.signals.confirmation, true);
  await page.close();
});

test('Oracle my-profile with an "Applied on <today>" row counts as a confirmation once the toast is gone (Fernhaven 2026-10-09)', async () => {
  const page = await load(path.join(__dirname, 'fixtures', 'oracle', 'my-profile.html'));
  assert.strictEqual((await page.evaluate(() => JB.snapshot())).signals.confirmation, false, 'an old application is not this one');
  await page.evaluate(() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    document.getElementById('row').textContent = `Fernhaven · 300404 · Applied on ${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
  });
  assert.strictEqual((await page.evaluate(() => JB.snapshot())).signals.confirmation, true);
  await page.close();
});

test('Workday prompt with categories: options read "Category > Leaf", set takes the path (Thornby 2026-10-09)', async () => {
  const page = await load(path.join(__dirname, 'fixtures', 'workday-nested-prompt.html'));
  const ref = await page.evaluate(() => {
    JB.snapshot();
    return document.getElementById('source--source').getAttribute('data-jb-ref');
  });
  const opts = await page.evaluate((r) => JB.options({ ref: r }), ref);
  assert.ok(opts.includes('Online > LinkedIn') && opts.includes('Online > Veritone') && opts.includes('Referral > Referral'), JSON.stringify(opts));
  assert.ok(!opts.includes('Online'), 'a category is never an answer');
  const res = await page.evaluate((r) => JB.set({ ref: r, value: 'Online > LinkedIn' }), ref);
  assert.deepStrictEqual(res, { ok: true, value: 'LinkedIn' });
  assert.strictEqual(await page.evaluate(() => document.querySelector('[data-automation-id="selectedItem"]').textContent.trim()), 'LinkedIn');
  await page.close();
});

test('job-alert / marketing opt-ins end unticked; a required consent box is still ticked (owner rule 2026-10-08)', async () => {
  const page = await browser.newPage();
  await page.setContent(`<form>
    <label><input type="checkbox" id="jobs" checked> I agree to receive updates about new job opportunities.</label>
    <label><input type="checkbox" id="mkt" checked> I agree to receive marketing communications</label>
    <label><input type="checkbox" id="alerts"> Send me job alerts for similar roles</label>
    <label><input type="checkbox" id="terms" required> I agree to the Terms of Use and Privacy Policy *</label>
    <button type="submit">Submit</button></form>`);
  for (const f of FILES) await page.addScriptTag({ path: path.join(EXT, f) });
  await page.evaluate((data) => JB.fill(data), { ...D.fillData(), policy: { autoConsent: true, autoSubmit: true } });
  const state = await page.evaluate(() => Object.fromEntries(['jobs', 'mkt', 'alerts', 'terms'].map((id) => [id, document.getElementById(id).checked])));
  assert.deepStrictEqual(state, { jobs: false, mkt: false, alerts: false, terms: true });
  await page.close();
});

test('a REQUIRED opt-in box is never ticked or flagged consent; a required privacy box still is (audit 2026-10-08)', async () => {
  const page = await browser.newPage();
  await page.setContent(`<form>
    <label><input type="checkbox" id="sms" required> I agree to receive text messages and job alerts *</label>
    <label><input type="checkbox" id="priv" required> I agree to the privacy policy *</label>
    <button type="submit">Submit</button></form>`);
  for (const f of FILES) await page.addScriptTag({ path: path.join(EXT, f) });
  const out = await page.evaluate((data) => JB.fill(data), { ...D.fillData(), policy: { autoConsent: true, autoSubmit: true } });
  const state = await page.evaluate(() => Object.fromEntries(['sms', 'priv'].map((id) => [id, document.getElementById(id).checked])));
  assert.deepStrictEqual(state, { sms: false, priv: true });
  const sms = out.fields.find((x) => /text messages/i.test(x.label));
  assert.ok(sms && sms.optIn && !sms.consent, 'opt-in wins over consent');
  await page.close();
});

test('Oracle address block: only rows whose own label is marked required are required (not the whole fieldset)', async () => {
  const page = await browser.newPage();
  const row = (id, label, req) => `<div class="input-row"><label class="input-row__label${req ? ' input-row__label--required' : ''}" for="${id}"><span>${label}</span></label>
    <div class="input-row__control-container"><input class="input-row__control" id="${id}" name="${id}"></div></div>`;
  await page.setContent(`<form><fieldset><legend>Address</legend>${row('addressLine1', 'Address Line 1', true)}${row('addressLine2', '2nd address line', false)}${row('careOf', 'Care Of', false)}</fieldset><button type="submit">Submit</button></form>`);
  for (const f of FILES) await page.addScriptTag({ path: path.join(EXT, f) });
  const s = await page.evaluate(() => JB.snapshot());
  const req = Object.fromEntries(s.fields.map((f) => [f.label.replace(/\W+/g, ''), f.required]));
  assert.deepStrictEqual(req, { AddressLine1: true, '2ndaddressline': false, CareOf: false });
  await page.close();
});

test('iCIMS ajax dropdown showing "— Make a Selection —" reads empty (YARROWMERE 2026-10-08)', async () => {
  const page = await browser.newPage();
  const dd = (id, label, shown) => `<div class="iCIMS_TableRow"><label id="label_${id}" for="${id}"><span class="iCIMS_LabelText">${label}</span></label><span class="Field_RequiredStar">*</span>
    <select id="${id}" class="dropdown-hide" i_required="true" role="combobox" style="display:none"><option value=""></option></select>
    <a id="${id}_icimsDropdown" class="dropdown-select" tabindex="0" role="combobox" aria-required="true" aria-label="${label}" aria-expanded="false"><span class="dropdown-text">${shown}</span></a></div>`;
  await page.setContent(`<form>${dd('edu', 'Highest Level of Education', '<span class="dropdown-placeholder">— Make a Selection —</span>')}
    ${dd('state', 'State/Province', 'Please select a country')}${dd('ctry', 'Country', 'United States')}<input type="submit" value="Submit Profile"></form>`);
  for (const f of FILES) await page.addScriptTag({ path: path.join(EXT, f) });
  const s = await page.evaluate(() => JB.snapshot());
  const v = (re) => (s.fields.find((f) => re.test(f.label)) || {}).value;
  assert.strictEqual(v(/Education/), '');
  assert.strictEqual(v(/State/), '');
  assert.strictEqual(v(/Country/), 'United States');
  await page.close();
});

test('iCIMS dropdown: options opens the menu behind an empty hidden select; set types in the popup search box (Driftmere states)', async () => {
  const page = await browser.newPage();
  const states = ['Alabama', 'Alaska', 'Arizona', 'North Carolina', 'Virginia'];
  await page.setContent(`<form><div class="iCIMS_TableRow"><label for="st">State</label>
    <select id="st" class="dropdown-hide" style="display:none"><option value=""></option></select>
    <a id="st_icimsDropdown" class="dropdown-select" role="combobox" tabindex="0" aria-required="true" aria-label="State" aria-expanded="false"><span class="dropdown-text"><span class="dropdown-placeholder">— Make a Selection —</span></span></a>
    <div id="st_icimsDropdown_ctnr" class="dropdown-container" style="display:none"><input type="text" class="dropdown-search"><ul class="dropdown-results"></ul></div></div>
    <a class="iCIMS_Anchor" href="javascript:void(0)" role="button" aria-label="Delete Professional Experience (2)"><span class="glyphicons glyphicons-remove"></span>&nbsp;</a>
    <input type="submit" value="Submit Profile"></form>
    <script>
      const a = document.getElementById('st_icimsDropdown'), box = document.getElementById('st_icimsDropdown_ctnr');
      const ul = box.querySelector('ul'), q = box.querySelector('input'), all = ${JSON.stringify(states)};
      // Like iCIMS: only the first 3 load until you scroll or type.
      const show = (t) => { ul.innerHTML = all.filter((s) => s.toLowerCase().includes(t.toLowerCase())).slice(0, t ? 99 : 3).map((s) => '<li role="option" class="dropdown-result">' + s + '</li>').join(''); };
      a.addEventListener('click', () => { box.style.display = 'block'; show(''); q.focus(); });
      q.addEventListener('input', () => show(q.value));
      ul.addEventListener('click', (e) => { a.querySelector('.dropdown-text').textContent = e.target.textContent; box.style.display = 'none'; });
    </script>`);
  for (const f of FILES) await page.addScriptTag({ path: path.join(EXT, f) });
  const s = await page.evaluate(() => JB.snapshot());
  const st = s.fields.find((f) => /State/.test(f.label));
  assert.ok(st, 'State listed');
  assert.ok(s.buttons.some((b) => /Delete Professional Experience/.test(b.text)), 'icon-only role=button link listed');
  const ref = st.ref.split(':').pop();
  const opts = await page.evaluate((r) => JB.options({ ref: r }), ref);
  assert.ok(opts.includes('Alabama'), 'menu opened: ' + JSON.stringify(opts));
  const res = await page.evaluate((r) => JB.set({ ref: r, value: 'Virginia' }), ref);
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(await page.evaluate(() => document.querySelector('#st_icimsDropdown .dropdown-text').textContent), 'Virginia');
  await page.close();
});

test('Oracle fixture (Fernhaven, 2026-10-08): Address Line 1 is a required combobox the driver sees as empty', async () => {
  const page = await load(path.join(__dirname, 'fixtures', 'oracle-form.html'));
  const s = await page.evaluate(() => JB.snapshot());
  const a1 = s.fields.find((f) => /^Address Line 1/.test(f.label));
  assert.ok(a1, 'Address Line 1 listed');
  assert.strictEqual(a1.kind, 'combobox');
  assert.strictEqual(a1.required, true);
  assert.ok(!a1.value, 'empty, so it reaches the driver (profileAnswer gives the street)');
  await page.close();
});

test('Workday multiselect: a selected pill counts as the value (Country Phone Code, Glenmoor 2026-10-09)', async () => {
  const page = await browser.newPage();
  await page.setContent(`<form><div data-automation-id="formField-countryPhoneCode"><label for="phoneNumber--countryPhoneCode">Country Phone Code<abbr title="required">*</abbr></label>
    <div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect"><div data-automation-id="multiselectInputContainer">
      <input placeholder="Search" aria-required="true" id="phoneNumber--countryPhoneCode" data-uxi-widget-type="selectinput" value="">
      <ul role="listbox" data-automation-id="selectedItemList"><li data-automation-id="menuItem"><div role="option" data-automation-id="selectedItem">United States of America (+1)</div></li></ul>
    </div></div></div><button type="submit">Save and Continue</button></form>`);
  for (const f of FILES) await page.addScriptTag({ path: path.join(EXT, f) });
  const s = await page.evaluate(() => JB.snapshot());
  const f = s.fields.find((x) => /country phone code/i.test(x.label));
  assert.ok(f, 'field found');
  assert.strictEqual(f.value, 'United States of America (+1)');
  await page.close();
});

/* ------------------------------------------------------------------ */
/* Oracle yes/no pills (2026-10-09): one 'buttons' field per question, set() presses the pill         */
/* ------------------------------------------------------------------ */

test('Oracle pills (Fernhaven yes/no, TI Title): each pill group is one buttons field with the question, the options and the pressed value', async () => {
  const page = await load(path.join(__dirname, 'fixtures', 'oracle-pills.html'));
  const s = await page.evaluate(() => JB.snapshot());
  const pills = s.fields.filter((f) => f.kind === 'buttons');
  assert.strictEqual(pills.length, 5, JSON.stringify(s.fields.map((f) => [f.kind, f.label.slice(0, 40)])));
  const by = (re) => pills.find((f) => re.test(f.label));
  const spons = by(/^Do you now or in the future require immigration benefit sponsorship/);
  assert.deepStrictEqual(spons.options, ['Yes', 'No']);
  assert.strictEqual(spons.required, true, 'required through the row label');
  assert.strictEqual(spons.value, '');
  assert.strictEqual(by(/^Are you a recent graduate/).required, false, 'optional row stays optional');
  assert.deepStrictEqual(by(/^Please confirm your preferred method/).options, ['Email', 'Email SMS', 'Email WhatsApp']);
  const title = by(/^Title$/);
  assert.deepStrictEqual(title.options, ['Doctor', 'Miss', 'Mr.', 'Mrs.', 'Ms.'], 'role=radio / aria-checked pills too');
  // The pills are answers, not actions; a lone toggle (one pill) is still a button, not a question.
  assert.ok(!s.buttons.some((b) => /^(Yes|No|Email|Mr\.)/.test(b.text)), JSON.stringify(s.buttons.map((b) => b.text)));
  assert.ok(s.buttons.some((b) => b.text === 'Remember this device'));
  assert.ok(!s.fields.some((f) => /Remember this device/.test(f.label)));
  await page.close();
});

test('Oracle pills: set presses the matching pill (value reads back), also when the page re-creates the list', async () => {
  const page = await load(path.join(__dirname, 'fixtures', 'oracle-pills.html'));
  const s = await page.evaluate(() => JB.snapshot());
  const ref = (re) => s.fields.find((f) => re.test(f.label)).ref;
  const set = (r, v) => page.evaluate(([x, y]) => JB.set({ ref: x, value: y }), [r, v]);
  const no = await set(ref(/immigration benefit sponsorship/), 'No');
  assert.deepStrictEqual({ ok: no.ok, value: no.value }, { ok: true, value: 'No' }, JSON.stringify(no));
  assert.deepStrictEqual(await page.evaluate(() => Array.from(document.querySelectorAll('#q1 button')).map((b) => b.getAttribute('aria-pressed'))), ['false', 'true']);
  const mr = await set(ref(/^Title$/), 'Mr.');
  assert.deepStrictEqual({ ok: mr.ok, value: mr.value }, { ok: true, value: 'Mr.' }, JSON.stringify(mr));
  assert.deepStrictEqual(await page.evaluate(() => Array.from(document.querySelectorAll('#title button')).map((b) => b.getAttribute('aria-checked'))), ['false', 'false', 'true', 'false', 'false']);
  // Changing the answer presses the other pill; the same answer again presses nothing.
  assert.strictEqual((await set(ref(/immigration benefit sponsorship/), 'Yes')).value, 'Yes');
  assert.strictEqual((await set(ref(/immigration benefit sponsorship/), 'Yes')).value, 'Yes');
  // q4's React stand-in replaces the whole list on a click: the new nodes carry no ref.
  const adult = await set(ref(/at least 18/), 'Yes');
  assert.deepStrictEqual({ ok: adult.ok, value: adult.value }, { ok: true, value: 'Yes' }, JSON.stringify(adult));
  const bad = await set(ref(/^Title$/), 'Prof');
  assert.strictEqual(bad.ok, false);
  assert.deepStrictEqual(bad.options, ['Doctor', 'Miss', 'Mr.', 'Mrs.', 'Ms.']);
  // The next snapshot reads the answers back.
  const s2 = await page.evaluate(() => JB.snapshot());
  const val = (re) => s2.fields.find((f) => re.test(f.label)).value;
  assert.deepStrictEqual([val(/immigration benefit/), val(/^Title$/), val(/at least 18/)], ['Yes', 'Mr.', 'Yes']);
  await page.close();
});

test('Oracle pills: an unanswered required pill question reaches fill() as a need with its options; an answered one does not', async () => {
  const page = await load(path.join(__dirname, 'fixtures', 'oracle-pills.html'));
  const first = await page.evaluate((data) => JB.fill(data), { ...D.fillData(), qaEntries: [], standardAnswers: {} });
  const need = first.needs.find((n) => /immigration benefit sponsorship/.test(n.label));
  assert.ok(need, JSON.stringify(first.needs.map((n) => n.label.slice(0, 50))));
  assert.strictEqual(need.kind, 'buttons');
  assert.deepStrictEqual(need.options, ['Yes', 'No']);
  assert.ok(!first.needs.some((n) => /recent graduate|^Title$/.test(n.label)), 'optional pills are not asked');
  await page.evaluate((ref) => JB.set({ ref, value: 'No' }), need.ref);
  const again = await page.evaluate((data) => JB.fill(data), { ...D.fillData(), qaEntries: [], standardAnswers: {} });
  assert.ok(!again.needs.some((n) => /immigration benefit sponsorship/.test(n.label)), 'answered: not asked again');
  await page.close();
});

test('Oracle captures: Fernhaven section-2 yes/no pills and the TI Title pills become fields (the real markup)', async () => {
  const fernhaven = await load(path.join(__dirname, 'fixtures', 'oracle-form.html'));
  // The capture holds later sections of the apply flow as display:none; show them as Oracle does one at a time.
  await fernhaven.evaluate(() => document.querySelectorAll('.apply-flow-section').forEach((n) => (n.style.display = 'block')));
  const s = await fernhaven.evaluate(() => JB.snapshot());
  const pills = s.fields.filter((f) => f.kind === 'buttons');
  const yn = pills.filter((f) => JSON.stringify(f.options) === '["Yes","No"]');
  assert.ok(yn.length >= 15, `yes/no questions found: ${yn.length}`);
  for (const re of [/non-compete/, /sponsorship/, /at least 18/, /recent graduate/, /legally authorized/]) assert.ok(yn.some((f) => re.test(f.label)), String(re));
  assert.ok(pills.some((f) => f.options.length === 3 && /^I agree\./.test(f.options[0])), 'the 3-option consent pills too');
  assert.ok(!s.buttons.some((b) => /^(Yes|No)$/.test(b.text.trim())), 'pills are not listed as action buttons');
  await fernhaven.close();
  const ti = await load(path.join(__dirname, 'fixtures', 'oracle-form-2.html'));
  const t = (await ti.evaluate(() => JB.snapshot())).fields.find((f) => f.kind === 'buttons');
  assert.ok(t && t.label === 'Title', JSON.stringify(t));
  assert.deepStrictEqual(t.options, ['Doctor', 'Miss', 'Mr.', 'Mrs.', 'Ms.']);
  await ti.close();
});

test('pills pressed side by side (Ashby shape): "A; B" presses one pill per value; a single pill is only a button', async () => {
  const page = await browser.newPage();
  await page.setContent(`<form><div class="q"><label>Which locations? *</label><div id="g">
      <button type="button" aria-pressed="false">New York</button><button type="button" aria-pressed="false">Austin</button><button type="button" aria-pressed="false">Remote</button></div></div>
    <div><button type="button" aria-pressed="false" id="solo">Dark mode</button></div></form>
    <script>document.getElementById('g').addEventListener('click', (e) => { const b = e.target.closest('button'); b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); });</script>`);
  for (const f of FILES) await page.addScriptTag({ path: path.join(EXT, f) });
  const s = await page.evaluate(() => JB.snapshot());
  const g = s.fields.find((f) => f.kind === 'buttons');
  assert.deepStrictEqual(g.options, ['New York', 'Austin', 'Remote']);
  assert.ok(s.buttons.some((b) => b.text === 'Dark mode'), 'a lone toggle is an action button');
  const r = await page.evaluate((ref) => JB.set({ ref, value: 'New York; Remote' }), g.ref);
  assert.deepStrictEqual({ ok: r.ok, value: r.value }, { ok: true, value: 'New York; Remote' }, JSON.stringify(r));
  await page.close();
});

/* ------------------------------------------------------------------ */
/* Snapshot signals: was this tab hidden?                                                              */
/* ------------------------------------------------------------------ */

test('snapshot signals carry the tab visibility and focus (a stalled step in a hidden tab is explainable)', async () => {
  const page = await load(path.join(FIX, 'generic', 'basic.html'));
  const s = await page.evaluate(() => JB.snapshot());
  assert.match(s.signals.visibility, /^(visible|hidden)$/);
  assert.strictEqual(typeof s.signals.focus, 'boolean');
  const hidden = await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.hasFocus = () => false;
    return JB.snapshot().signals;
  });
  assert.strictEqual(hidden.visibility, 'hidden');
  assert.strictEqual(hidden.focus, false);
  await page.close();
});

/* ------------------------------------------------------------------ */
/* Dropdown waits are condition-driven (no fixed 250 + 700 + 500 ms sleeps, no 5 s poll for a menu that never opens) */
/* ------------------------------------------------------------------ */

/** A react-select look-alike whose list comes from `behaviour` (script text defining render(query)). */
async function comboPage(script, extra) {
  const page = await browser.newPage();
  await page.setContent(`<form>
    <label id="c-l" for="c">Pick one *</label>
    <div class="select__control" id="ctl"><div class="select__value-container" id="vc"><input id="c" class="select__input" role="combobox" aria-labelledby="c-l" aria-expanded="false" type="text" value=""></div>${extra || ''}</div>
    <div class="select__menu" id="menu"></div></form>
    <script>
      const input = document.getElementById('c'), menu = document.getElementById('menu'), vc = document.getElementById('vc'), ctl = document.getElementById('ctl');
      function pick(t) { menu.innerHTML = ''; input.value = ''; input.setAttribute('aria-expanded', 'false'); let v = vc.querySelector('.select__single-value'); if (!v) { v = document.createElement('div'); v.className = 'select__single-value'; vc.prepend(v); } v.textContent = t; }
      function show(list) { menu.innerHTML = ''; for (const t of list) { const d = document.createElement('div'); d.setAttribute('role', 'option'); d.textContent = t; d.addEventListener('click', () => pick(t)); menu.appendChild(d); } input.setAttribute('aria-expanded', list.length ? 'true' : 'false'); }
      ${script}
    </script>`);
  for (const f of FILES) await page.addScriptTag({ path: path.join(EXT, f) });
  await page.evaluate(() => JB.snapshot());
  return page;
}
const timedSet = (page, value, query) =>
  page.evaluate(async ([v, q]) => {
    const t0 = performance.now();
    const ref = document.getElementById('c').getAttribute('data-jb-ref');
    const r = await JB.set({ ref, value: v, query: q });
    return { ...r, ms: Math.round(performance.now() - t0) };
  }, [value, query]);

test('dropdown wait: a list that is there at once is picked in well under the old 1.45 s of fixed sleeps', async () => {
  const page = await comboPage(`input.addEventListener('input', () => show(['Alpha', 'Beta', 'Gamma'].filter((x) => x.toLowerCase().includes(input.value.toLowerCase())))); ctl.addEventListener('mousedown', () => show(['Alpha', 'Beta', 'Gamma']));`);
  const r = await timedSet(page, 'Beta');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.chose, 'Beta');
  assert.ok(r.ms < 1000, `took ${r.ms} ms`);
  assert.strictEqual(await page.evaluate(() => document.querySelector('.select__single-value').textContent), 'Beta');
  await page.close();
});

test('dropdown wait: a list that never opens gives up after the 4 s first-list budget (live sites are slower than fixtures), not the old 6.4 s', async () => {
  const page = await comboPage('/* nothing ever renders */');
  const r = await timedSet(page, 'December 2027');
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /no option list appeared/);
  assert.ok(r.ms >= 3900 && r.ms < 5600, `took ${r.ms} ms`);
  await page.close();
});

test('dropdown wait: a "No options" notice that stands is final, but only after it has stood 1.5 s and the search had 2 s to settle', async () => {
  const page = await comboPage(`input.addEventListener('input', () => { menu.innerHTML = '<div class="select__menu-notice select__menu-notice--no-options">No options</div>'; });`);
  const r = await timedSet(page, 'Zeta');
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.ok(r.ms >= 1900 && r.ms < 3600, `took ${r.ms} ms: ended by the notice, before the 4 s budget`);
  await page.close();
});

test('dropdown wait: a remote list that arrives 2 s after typing, with no loader, is still picked (live search; review finding)', async () => {
  const page = await comboPage(`input.addEventListener('input', () => setTimeout(() => show(['Slow University']), 2000));`);
  const r = await timedSet(page, 'Slow University');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.chose, 'Slow University');
  assert.strictEqual(await page.evaluate(() => document.querySelector('.select__single-value').textContent), 'Slow University');
  assert.ok(r.ms < 3300, `returned when the list showed, not at a cap: ${r.ms} ms`);
  await page.close();
});

test('dropdown wait: "No options" shown during the search debounce is not final; the results that follow at 1.2 s are picked', async () => {
  const page = await comboPage(`input.addEventListener('input', () => { menu.innerHTML = '<div class="select__menu-notice select__menu-notice--no-options">No options</div>'; setTimeout(() => show(['Slow University']), 1200); });`);
  const r = await timedSet(page, 'Slow University');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.chose, 'Slow University');
  await page.close();
});

test('dropdown wait: a stale default list with no match is not given up on while a remote search is still answering (2.2 s)', async () => {
  const page = await comboPage(`
    ctl.addEventListener('mousedown', () => show(['Alpha U', 'Beta U']));
    input.addEventListener('input', () => setTimeout(() => show(['Slow University']), 2200));`);
  const r = await timedSet(page, 'Slow University');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.chose, 'Slow University');
  await page.close();
});

// Loaders of every shape the ATSs use. Each fixture shows "No options" the whole time (which alone is final after
// 2 s) plus the loader, then the list arrives at 3.2 s: only a recognised loader keeps the wait going.
for (const [name, loader] of [
  ['role=progressbar', '<span id="ldr" role="progressbar" style="display:inline-block;width:12px;height:12px"></span>'],
  ['aria-busy', '<span id="ldr" aria-busy="true" style="display:inline-block;width:12px;height:12px"></span>'],
  ['data-automation-id', '<span id="ldr" data-automation-id="loadingSpinner" style="display:inline-block;width:12px;height:12px"></span>'],
  ['skeleton class', '<span id="ldr" class="menu-skeleton-row" style="display:inline-block;width:40px;height:12px"></span>'],
  ['"Searching..." text', '<span id="ldr">Searching...</span>'],
]) {
  test(`dropdown wait: a ${name} loader keeps waiting for a slow list`, async () => {
    const page = await comboPage(
      `input.addEventListener('input', () => { menu.innerHTML = '<div class="select__menu-notice select__menu-notice--no-options">No options</div>'; setTimeout(() => { document.getElementById('ldr').remove(); show(['Slow University']); }, 3200); });`,
      loader
    );
    const r = await timedSet(page, 'Slow University');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.chose, 'Slow University');
    await page.close();
  });
}

test('dropdown pick: a list that re-renders under the press is found again by its text and pressed once more (review finding)', async () => {
  // The first press re-renders the list on pointerdown: the node we hold is gone, so the click never lands.
  const page = await comboPage(`
    let spun = false;
    ctl.addEventListener('mousedown', () => show(['Alpha', 'Beta', 'Gamma']));
    menu.addEventListener('pointerdown', () => { if (!spun) { spun = true; show(['Alpha', 'Beta', 'Gamma']); } }, true);`);
  const r = await timedSet(page, 'Beta');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.chose, 'Beta');
  assert.strictEqual(await page.evaluate(() => document.querySelector('.select__single-value').textContent), 'Beta', 'the second press registered');
  await page.close();
});

test('dropdown pick: a pick the widget ignores is reported as not ok, not "ok: true" (review finding)', async () => {
  const page = await comboPage(`
    ctl.addEventListener('mousedown', () => show(['Alpha', 'Beta']));
    menu.addEventListener('click', (e) => e.stopPropagation(), true); /* the page swallows every option click */`);
  const r = await timedSet(page, 'Beta');
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /does not show it/);
  assert.strictEqual(await page.evaluate(() => !!document.querySelector('.select__single-value')), false);
  await page.close();
});

test('autocomplete pick: a suggestion the page ignores is not ok; one that lands is ok with the full value', async () => {
  const mk = (swallow) => `<form><label for="loc">Current location</label>
    <div class="location"><input id="loc" type="text" aria-autocomplete="list" autocomplete="off"><div class="dropdown-results" id="res"></div></div></form>
    <script>
      const loc = document.getElementById('loc'), res = document.getElementById('res');
      loc.addEventListener('input', () => { res.innerHTML = '<div role="option" class="dropdown-result">Boston, MA, USA</div>'; });
      res.addEventListener('click', (e) => { const d = e.target.closest('[role=option]'); if (d && !${swallow}) { loc.value = d.textContent; res.innerHTML = ''; } });
    </script>`;
  for (const swallow of [false, true]) {
    const page = await browser.newPage();
    await page.setContent(mk(swallow));
    for (const f of FILES) await page.addScriptTag({ path: path.join(EXT, f) });
    await page.evaluate(() => JB.snapshot());
    const r = await page.evaluate(() => JB.set({ ref: document.getElementById('loc').getAttribute('data-jb-ref'), value: 'Boston' }));
    if (swallow) assert.strictEqual(r.ok, false, JSON.stringify(r));
    else assert.deepStrictEqual({ ok: r.ok, value: r.value }, { ok: true, value: 'Boston, MA, USA' }, JSON.stringify(r));
    await page.close();
  }
});

test('dropdown wait: a visible loading indicator keeps waiting past the "never opens" cap (async list)', async () => {
  const page = await comboPage(
    `input.addEventListener('input', () => { setTimeout(() => { const l = document.querySelector('.select__loading-indicator'); if (l) l.remove(); show(['Slow University']); }, 2600); });`,
    '<span class="select__loading-indicator">...</span>'
  );
  const r = await timedSet(page, 'Slow University');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.chose, 'Slow University');
  assert.ok(r.ms >= 2500 && r.ms < 5000, `took ${r.ms} ms`);
  await page.close();
});

test('dropdown wait: a list that keeps growing is read to the end, and a stale default list is not trusted (typed query)', async () => {
  // Default list first, a first batch 500 ms after typing, the wanted option only in the second batch (1100 ms).
  const page = await comboPage(`
    ctl.addEventListener('mousedown', () => show(['Alpha U', 'Beta U']));
    input.addEventListener('input', () => { setTimeout(() => show(['Qux College']), 500); setTimeout(() => show(['Qux College', 'Zed State']), 1100); });`);
  const r = await timedSet(page, 'Zed State');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.chose, 'Zed State');
  await page.close();
});

test('dropdown wait: a stale default list that already holds the wanted option is not pressed before the filtered list replaces it', async () => {
  // The default list shows "Beta U" too; 400 ms after typing the page re-renders the list (new nodes). A match
  // taken from the stale list at once would press a detached node and pick nothing.
  const page = await comboPage(`
    ctl.addEventListener('mousedown', () => { show(['Alpha U', 'Beta U']); menu.querySelectorAll('[role=option]').forEach((d) => d.addEventListener('click', (e) => { e.stopImmediatePropagation(); pick('STALE ' + d.textContent); }, true)); });
    input.addEventListener('input', () => setTimeout(() => show(['Beta U']), 400));`);
  const r = await timedSet(page, 'Beta U');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(await page.evaluate(() => document.querySelector('.select__single-value').textContent), 'Beta U', 'the pick registered');
  await page.close();
});

test('dropdown options: a field with a search box is not held up 3 s by an empty first list', async () => {
  const page = await comboPage(`input.addEventListener('input', () => show(['Computer Science', 'Information Systems'].filter((x) => x.toLowerCase().includes(input.value.toLowerCase()))));`);
  const t0 = Date.now();
  const opts = await page.evaluate(() => JB.options({ ref: document.getElementById('c').getAttribute('data-jb-ref'), query: 'info' }));
  assert.deepStrictEqual(opts, ['Information Systems']);
  assert.ok(Date.now() - t0 < 1800, `took ${Date.now() - t0} ms`);
  await page.close();
});

/* ------------------------------------------------------------------ */
/* Pills re-rendered by the page, late reverts (review findings)       */
/* ------------------------------------------------------------------ */

for (const mode of ['the whole box is replaced', 'only the buttons are replaced']) {
  test(`pills "A; B": ${mode} after every press; each pill is found again by its text`, async () => {
    const page = await browser.newPage();
    await page.setContent(`<form><div class="q"><label>Which locations? *</label><div id="g"></div></div></form>
      <script>
        const names = ['New York', 'Austin', 'Remote'], on = [false, false, false];
        const replaceBox = ${mode === 'the whole box is replaced'};
        function render() {
          const g = document.createElement('div');
          g.id = 'g';
          names.forEach((n, i) => { const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-pressed', String(on[i])); b.textContent = n; g.appendChild(b); });
          const old = document.getElementById('g');
          if (replaceBox) old.replaceWith(g); else old.replaceChildren(...g.children);
        }
        render();
        // Delegated like React: a click on a detached (replaced) button reaches nobody.
        document.querySelector('form').addEventListener('click', (e) => { const b = e.target.closest('#g button'); if (!b) return; const i = names.indexOf(b.textContent); on[i] = !on[i]; render(); });
      </script>`);
    for (const f of FILES) await page.addScriptTag({ path: path.join(EXT, f) });
    const s = await page.evaluate(() => JB.snapshot());
    const g = s.fields.find((f) => f.kind === 'buttons');
    assert.deepStrictEqual(g.options, ['New York', 'Austin', 'Remote']);
    const r = await page.evaluate((ref) => JB.set({ ref, value: 'New York; Remote' }), g.ref);
    assert.deepStrictEqual({ ok: r.ok, value: r.value }, { ok: true, value: 'New York; Remote' }, JSON.stringify(r));
    assert.deepStrictEqual(await page.evaluate(() => Array.from(document.querySelectorAll('#g button')).map((b) => b.getAttribute('aria-pressed'))), ['true', 'false', 'true']);
    await page.close();
  });
}

test('checkbox set: a framework that takes the click back a beat later is reported not ok (the old 0 ms look said ok)', async () => {
  const mk = (revert) => `<form><label><input type="checkbox" id="sr"> I use a screen reader</label></form>
    <script>document.getElementById('sr').addEventListener('click', () => { ${revert ? "setTimeout(() => { document.getElementById('sr').checked = false; }, 150);" : ''} });</script>`;
  for (const revert of [true, false]) {
    const page = await browser.newPage();
    await page.setContent(mk(revert));
    for (const f of FILES) await page.addScriptTag({ path: path.join(EXT, f) });
    await page.evaluate(() => JB.snapshot());
    const t0 = Date.now();
    const r = await page.evaluate(() => JB.set({ ref: document.getElementById('sr').getAttribute('data-jb-ref'), value: 'yes' }));
    assert.strictEqual(r.ok, !revert, JSON.stringify(r));
    if (!revert) assert.ok(Date.now() - t0 < 1000, 'a ticked box that stays ticked returns after the hold, not the full window');
    await page.close();
  }
});

test('autoConsent: a consent box the page un-ticks 120 ms after the press is not reported as filled by policy', async () => {
  const mk = (revert) => `<form>
    <label><input type="checkbox" id="priv" required> I agree to the Terms of Use and Privacy Policy *</label><button type="submit">Submit</button></form>
    <script>document.getElementById('priv').addEventListener('click', () => { ${revert ? "setTimeout(() => { document.getElementById('priv').checked = false; }, 120);" : ''} });</script>`;
  for (const revert of [true, false]) {
    const page = await browser.newPage();
    await page.setContent(mk(revert));
    for (const f of FILES) await page.addScriptTag({ path: path.join(EXT, f) });
    const out = await page.evaluate((data) => JB.fill(data), { ...D.fillData(), policy: { autoConsent: true, autoSubmit: true } });
    const f = out.fields.find((x) => /Terms of Use/i.test(x.label));
    assert.ok(f, JSON.stringify(out.fields.map((x) => x.label)));
    assert.strictEqual(f.source === 'policy:autoConsent', !revert, JSON.stringify(f));
    await page.close();
  }
});

test('date picker: a value the picker clears 200 ms after it closes is rejected (old 120 ms tail missed it); one that stays is ok', async () => {
  const mk = (clear) => `<form><label for="d">Graduation date</label><div class="react-datepicker-wrapper"><input id="d" type="text" placeholder="MM/YYYY"></div></form>
    <script>document.getElementById('d').addEventListener('blur', () => { ${clear ? "setTimeout(() => { document.getElementById('d').value = ''; }, 200);" : ''} });</script>`;
  for (const clear of [true, false]) {
    const page = await browser.newPage();
    await page.setContent(mk(clear));
    for (const f of FILES) await page.addScriptTag({ path: path.join(EXT, f) });
    await page.evaluate(() => JB.snapshot());
    const r = await page.evaluate(() => JB.set({ ref: document.getElementById('d').getAttribute('data-jb-ref'), value: '12/2027' }));
    assert.strictEqual(r.ok, !clear, JSON.stringify(r));
    if (clear) assert.match(r.error, /rejected this format/);
    await page.close();
  }
});

/* ------------------------------------------------------------------ */
/* Oracle: the row's own label decides required, before aria-required   */
/* ------------------------------------------------------------------ */

test('Oracle .input-row: an optional row whose input carries aria-required="true" reads not required; a required row stays required (oracle-form.html)', async () => {
  const page = await load(path.join(__dirname, 'fixtures', 'oracle-form.html'));
  // Oracle puts aria-required on optional inputs too. The capture's rows are all required; make Postal Code
  // an optional row the way Oracle renders one (label without input-row__label--required) and keep aria-required.
  const marked = await page.evaluate(() => {
    const el = document.getElementById('postalCode-47');
    el.setAttribute('aria-required', 'true');
    el.closest('.input-row').querySelector('.input-row__label').classList.remove('input-row__label--required');
    return el.getAttribute('aria-required');
  });
  assert.strictEqual(marked, 'true');
  const s = await page.evaluate(() => JB.snapshot());
  const req = (re) => (s.fields.find((f) => re.test(f.label)) || {}).required;
  assert.strictEqual(req(/^Postal Code/), false, 'optional row with aria-required: not required');
  assert.strictEqual(req(/^Address Line 1/), true, 'a required row stays required');
  assert.strictEqual(req(/^First Name/), true);
  await page.close();
});

test('Cedarhall iCIMS export question: never a "Yes – <country>" pick; whole-word and same-meaning guards', async () => {
  const page = await load(path.join(__dirname, 'fixtures', 'icims-cedarhall-questions.html'));
  const out = await page.evaluate((data) => JB.fill(data), D.fillData());
  const val = (id) => page.evaluate((i) => document.getElementById(i).value, id);
  assert.strictEqual(await val('q5'), '', 'the engine leaves the sanctioned-country question alone');
  const need = out.needs.find((n) => /North Korea/.test(n.label));
  assert.ok(need, 'reported with the question (label keeps its end): ' + JSON.stringify(out.needs.map((n) => n.label)));
  assert.match(need.label, /^The information being requested/);
  const ref = (id) => page.evaluate((i) => document.getElementById(i).getAttribute('data-jb-ref'), id);
  const set = async (id, v) => page.evaluate(([r, x]) => JB.set({ ref: r, value: x }), [await ref(id), v]);
  // "No" / "NO" is the plain No, never "Yes – North Korea" ("no" is not the start of "north").
  assert.strictEqual((await set('q5', 'NO')).value, 'No');
  // A list with no plain No: "no" must not land on a country option.
  const r8 = await set('q8', 'no');
  assert.notStrictEqual(await val('q8'), 'Yes – North Korea', JSON.stringify(r8));
  assert.ok(!/korea|syria/i.test(await val('q8')));
  // "Yes" never picks a country option either (nothing names it in the value).
  await set('q8', 'Yes');
  assert.ok(!/korea|syria/i.test(await val('q8')), 'yes is not a country pick');
  // The value naming the country exactly is the owner's own answer and is allowed.
  assert.strictEqual((await set('q5', 'Yes – Cuba')).value, 'Yes – Cuba');
  await page.close();
});

/* ---- 2026-10-09 hiccups: Rippling, Workday question labels, Ashby commit (fixtures built from the run notes, not captures) ---- */

test('Rippling: div[role=radio] SMS consent is a snapshot field (buttons kind), answered No; disabled Apply is listed; EEO div comboboxes filled from standard answers (rippling-apply.html)', async () => {
  const page = await load(path.join(__dirname, 'fixtures', 'rippling-apply.html'));
  const s = await page.evaluate(() => JB.snapshot());
  const sms = s.fields.find((f) => /text messages/i.test(f.label));
  assert.ok(sms, 'SMS consent group is a field');
  assert.strictEqual(sms.kind, 'buttons');
  assert.deepStrictEqual(sms.options.map((t) => t.split(' ')[0]), ['Yes', 'No']);
  const apply = s.buttons.find((b) => b.text === 'Apply');
  assert.ok(apply && apply.disabled && apply.testid === 'Apply', 'Apply is listed, flagged disabled');
  const set = await page.evaluate((ref) => JB.set({ ref, value: 'No' }), sms.ref);
  assert.ok(set.ok, JSON.stringify(set));
  assert.strictEqual(await page.evaluate(() => document.querySelector('#sms [aria-checked="true"]').textContent.trim()), 'No - I do not consent to receive text messages');
  assert.strictEqual(await page.evaluate(() => document.getElementById('apply').disabled), false);
  const out = await page.evaluate((d) => JB.fill(d), D.fillData());
  const shown = await page.evaluate(() => Array.from(document.querySelectorAll('.dd .val')).map((v) => v.textContent));
  assert.deepStrictEqual(shown, ['Male', 'Choose not to disclose', 'Choose not to disclose', 'I am not a protected veteran']);
  assert.ok(out.fields.filter((f) => f.source && f.source.startsWith('standard:')).length >= 4);
  await page.close();
});

test('Workday Application Questions: labels come from the formField-* richText, not "Select One Required" / "Yes Required" / the first option (workday-app-questions.html)', async () => {
  const page = await load(path.join(__dirname, 'fixtures', 'workday-app-questions.html'));
  const s = await page.evaluate(() => JB.snapshot());
  const by = (kind) => s.fields.find((f) => f.kind === kind);
  assert.match(by('combobox').label, /^Are you legally authorized to work in the United States\?/);
  assert.strictEqual(by('combobox').required, true);
  assert.match(by('radio').label, /^Will you now or in the future require sponsorship/);
  assert.match(by('checkboxes').label, /^Which of the following programming languages/);
  assert.deepStrictEqual(by('checkboxes').options, ['Python', 'Java', 'None of the above']);
  assert.ok(s.fields.some((f) => /^First Name/.test(f.label)), 'ordinary labelled fields are unchanged');
  await page.close();
});

test('Ashby: a text set made before hydration is committed again, so the form state holds it (ashby-linkedin.html)', async () => {
  const page = await load(path.join(__dirname, 'fixtures', 'ashby-linkedin.html'));
  const ref = await page.evaluate(() => JB.snapshot().fields.find((f) => /LinkedIn/.test(f.label)).ref);
  const r = await page.evaluate((ref) => {
    setTimeout(window.__hydrate, 200); // React attaches its handlers 200 ms into the set
    return JB.set({ ref, value: 'https://www.linkedin.com/in/someone' });
  }, ref);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(await page.evaluate(() => window.__state.linkedin), 'https://www.linkedin.com/in/someone');
  assert.strictEqual(await page.evaluate(() => window.__validate()), false, 'no "Missing entry" error');
  await page.close();
});
