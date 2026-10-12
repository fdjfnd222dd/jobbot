'use strict';
// JB.handshakeState on Handshake's Apply modal (reduced live markup, tests/fixtures/handshake-apply-modal.html),
// in Playwright's Firefox with the extension's page scripts, network blocked.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { firefox } = require(path.join(process.env.HOME, 'autofill', 'node_modules', 'playwright'));

const EXT = path.join(__dirname, '..', 'extension');
const FILES = fs.readFileSync(path.join(EXT, 'agent', 'background.js'), 'utf8').match(/const FILES = \[([\s\S]*?)\];/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));

let browser;
test.before(async () => {
  browser = await firefox.launch();
});
test.after(async () => browser && browser.close());

test('handshakeState reads the modal: title, document slots, modal buttons, notes', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/*', (r) => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await page.goto('file://' + path.join(__dirname, 'fixtures', 'handshake-apply-modal.html'));
  for (const f of FILES) await page.addScriptTag({ path: path.join(EXT, f) });
  const st = await page.evaluate(() => JB.handshakeState());
  assert.strictEqual(st.modal, true);
  assert.strictEqual(st.title, 'Apply to Example Co');
  assert.strictEqual(st.docs.length, 2);
  assert.deepStrictEqual(st.docs.map((d) => [d.heading, d.attached]), [['Attach your resume', 'Old_Resume.pdf'], ['Attach your transcript', null]]);
  assert.ok(st.docs[0].removeRef && !st.docs[0].uploadRef, 'pre-picked resume: a Close button, no upload box');
  assert.ok(st.docs[1].uploadRef, 'transcript slot: the Upload new input');
  assert.match(st.notes.join(' '), /school year does not match/);
  // Only the modal's buttons: Submit Application yes, the job page's own Apply / Save no.
  const snap = await page.evaluate(() => JB.snapshot());
  const inModal = new Set(st.buttonRefs);
  const texts = snap.buttons.filter((b) => inModal.has(String(b.ref))).map((b) => b.text);
  assert.ok(texts.includes('Submit Application'), texts.join(' | '));
  assert.ok(!texts.includes('Apply') && !texts.includes('Save'), texts.join(' | '));
  // The page without the modal: nothing to drive.
  await page.evaluate(() => document.querySelector('[role="dialog"]').remove());
  assert.strictEqual((await page.evaluate(() => JB.handshakeState())).modal, false);
  await page.close();
});
