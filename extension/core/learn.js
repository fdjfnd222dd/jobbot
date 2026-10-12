/*
 * core/learn.js
 *
 * Learn mode: when the owner answers a field by hand, save "question -> answer"
 * to the Q&A bank and say so ("Saved: <question>").
 *
 * The extension never runs on page load (no content_scripts), so learning
 * starts on a page only after the first fill there (Alt+Z or the toolbar's
 * Fill button). attach() is called at the end of every pass:
 *   - it takes a baseline: every field's current value, keyed by its question;
 *   - trusted user events (change, focusout, click, Enter) schedule a re-read;
 *   - a field whose value changed from the baseline to something non-empty is
 *     learned, then becomes the new baseline.
 * Our own fills never count: the baseline is taken after the pass ends, checks
 * are skipped while a pass runs (AF.running), and only isTrusted events schedule
 * a check at all.
 *
 * Every Alt+Z re-injects this file. The previous copy's listeners are removed
 * first (see the bottom), so a page never has two learners: two would race
 * on the bank and compare against an old baseline (an orange fuzzy fill of the
 * second pass would be saved as if the owner had typed it).
 * Before saving, learn mode is re-read from storage: switching it off in the
 * popup stops learning on pages that are already listening.
 *
 * Never learned: fields the profile already maps (that data lives in the
 * profile), standard questions (answered once in the options page), consent /
 * agreement / signature fields, vetoed sections (emergency contact,
 * references), passwords and file inputs, and questions whose label appears
 * twice on the page (we could not tell them apart).
 *
 * The hiring company (detected by the pass) is replaced by {company} in the
 * saved question AND answer: "Have you ever interviewed at {company}?" then
 * answers that question for every company.
 */
(function (root) {
  'use strict';

  const AF = (root.AF = root.AF || {});

  const DEBOUNCE_MS = 700;
  const EVENTS = ['change', 'focusout', 'click', 'keyup'];

  const state = { doc: null, adapter: null, company: null, baseline: new Map(), timer: null, attached: false };

  function keyOf(desc) {
    return AF.matcher.normalize(desc.label) + '|' + AF.matcher.normalize(desc.context);
  }

  function readField(f) {
    try {
      if (f.read) return String(f.read() || '').trim();
      return AF.adapters.generic.readControl(f.el);
    } catch (err) {
      return '';
    }
  }

  /** Map key -> { field, value }; duplicated questions map to null. */
  function snapshot() {
    const out = new Map();
    let fields = [];
    try {
      fields = state.adapter.findFields(state.doc);
    } catch (err) {
      root.console.warn('[autofill] learn: findFields failed', err);
    }
    for (const f of fields) {
      if (f.outlineOnly) continue;
      const k = keyOf(f.desc);
      if (!AF.matcher.normalize(f.desc.label)) continue;
      out.set(k, out.has(k) ? null : { field: f, value: readField(f) });
    }
    return out;
  }

  const IDENTITY = /\b(ssn|social security|social insurance|sin number|date of birth|birth ?date|birthday|dob|day and month of birth|passport (number|no|num|expir\w*|issu\w*)|licen[cs]e (number|no|num|id)|tax id|taxpayer|tin|itin|national id\w*|national insurance|id number|identification number|bank (account|routing)|account number|routing number|iban|swift|credit card|card number|cvv|security code|password|pin)\b/;

  /** Should this field's hand-given answer go into the bank? */
  function learnable(field) {
    const { matcher, standard, qa } = AF;
    const desc = field.desc;
    const t = desc.inputType;
    if (t === 'password' || t === 'file' || t === 'hidden') return false;
    if (matcher.isVetoed(desc, 'context') || matcher.isIgnored(desc)) return false;
    if (qa.isConsent(desc.label)) return false;
    // Identity documents and numbers stay out of the bank (it is exported and reused
    // on every site): SSN, date of birth, passport, licence, tax / national ids, bank
    // and card details.
    if (IDENTITY.test(matcher.normalize(desc.label)) || (desc.hints || []).some((h) => IDENTITY.test(matcher.normalize(h)))) return false;
    if (standard.detect(desc)) return false;
    const cdesc = AF.company.applyToDesc(desc, state.company);
    if (cdesc !== desc && standard.detect(cdesc)) return false;
    if (matcher.matchField(desc)) return false;
    return true;
  }

  async function check() {
    state.timer = null;
    if (!state.doc || AF.running) return;
    const now = snapshot();
    const learned = [];
    for (const [k, cur] of now) {
      if (!cur) continue;
      const before = state.baseline.get(k);
      if (before === undefined) continue; // newly revealed: its baseline starts now
      if (before === null) continue; // ambiguous question text
      if (cur.value && cur.value !== before.value && learnable(cur.field)) learned.push(cur);
    }
    state.baseline = now;
    if (!learned.length) return;
    try {
      const { settings } = await AF.storage.load();
      if (!settings.learnMode) {
        detach();
        return;
      }
      // The hiring company becomes {company} in the question and in the
      // answer, so the entry fits every company (core/company.js).
      const co = state.company;
      await AF.storage.updateQA((entries) => {
        let list = entries;
        for (const l of learned) {
          const { desc } = l.field;
          const question = AF.company.normalizeText(desc.label, co);
          const answer = AF.company.templateAnswer(l.value, co);
          list = AF.qa.learn(list, question, answer, AF.company.normalizeText(desc.context, co)).entries;
        }
        return list;
      });
      const names = learned.map((l) => AF.adapters.generic.clean(AF.company.templateAnswer(l.field.desc.label, co)).slice(0, 60));
      AF.feedback.notify(state.doc, 'Saved: ' + names.join(' · '), 3000);
    } catch (err) {
      root.console.error('[autofill] learn failed:', err);
    }
  }

  function onEvent(e) {
    if (!e.isTrusted) return;
    if (e.type === 'keyup' && e.key !== 'Enter') return;
    if (state.timer) root.clearTimeout(state.timer);
    state.timer = root.setTimeout(check, DEBOUNCE_MS);
  }

  /** Start (or re-baseline) learning on doc with the adapter (and hiring company) of the pass that just ran. */
  function attach(doc, adapter, company) {
    state.doc = doc;
    state.adapter = adapter;
    state.company = company || null;
    state.baseline = snapshot();
    if (state.attached) return;
    state.attached = true;
    for (const type of EVENTS) doc.addEventListener(type, onEvent, true);
  }

  function detach() {
    if (!state.doc) return;
    for (const type of EVENTS) state.doc.removeEventListener(type, onEvent, true);
    if (state.timer) root.clearTimeout(state.timer);
    state.doc = null;
    state.attached = false;
  }

  // A copy injected by an earlier press: take its listeners off this page.
  if (AF.learn && AF.learn.detach) AF.learn.detach();
  AF.learn = { attach, detach, check, learnable, DEBOUNCE_MS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
