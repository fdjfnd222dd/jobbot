/*
 * core/autofill.js
 *
 * One fill pass: adapter finds fields -> matcher picks a profile key ->
 * filler (or the adapter's own widget code) writes the value -> feedback
 * outlines the result.
 *
 * Fields are filled strictly one at a time (custom dropdowns need the page's
 * full attention). After every fill that can reveal new fields (a dropdown,
 * native select, radio or checkbox) we wait for the page to settle and rescan:
 * Country -> State/Province is the classic case. Elements already handled are
 * remembered, so a rescan only picks up what is new.
 *
 * Pure with respect to storage: the caller passes the profile, Q&A entries and
 * standard answers in, which keeps this testable without the extension APIs.
 */
(function (root) {
  'use strict';

  const AF = (root.AF = root.AF || {});

  const MAX_RESCANS = 40;
  const MAX_FIELDS = 400;

  // An adapter that throws must never stop the page from being filled: its
  // detect() counting as "no", the generic adapter takes over (see run()).
  function pickAdapter(doc, forced) {
    const all = AF.adapters || {};
    if (forced && all[forced]) return all[forced];
    for (const name of Object.keys(all)) {
      if (name === 'generic') continue;
      try {
        if (all[name].detect(doc)) return all[name];
      } catch (err) {
        root.console.warn('[autofill] adapter', name, 'detect failed:', err);
      }
    }
    return all.generic;
  }

  // ATS forms embedded in a cross-origin iframe (CareerPuck and company career pages
  // wrap a Greenhouse board in iframe#grnhse_iframe): core/embed.js finds
  // them; background.js fills the ones it may reach and opens the others in
  // a tab of their own.
  /** Hosts of visible iframes that hold an application form. */
  function embeddedForms(doc) {
    let frames = [];
    try {
      frames = AF.embed ? AF.embed.survey(doc) : [];
    } catch (err) {
      root.console.warn('[autofill] frame survey failed:', err);
    }
    return Array.from(new Set(frames.map((f) => f.host)));
  }

  function inputKind(desc) {
    return desc.inputType === 'select' ? 'select' : desc.inputType;
  }

  /**
   * Where the answer for a field comes from. In order:
   *   1. a standard question (core/standard.js): the owner's stored answer, or
   *      nothing at all when they left it blank (never falls through);
   *   2. the profile (core/matcher.js), unless an exact Q&A entry beats a
   *      low-confidence profile guess;
   *   3. the Q&A bank (core/qa.js; sensitive questions exact / near-exact only).
   * Resolves { key, value, confidence, source, review?, yellowOnMiss?, noFill? }.
   */
  function decide(field, data) {
    const { matcher, standard, qa, company } = AF;
    const { desc } = field;
    // The same question with the hiring company replaced by {company}
    // ("Have you ever worked at {company} before?"): what the bank stores.
    const cdesc = company.applyToDesc(desc, data.company);

    const std = standard.detect(desc) || (cdesc !== desc ? standard.detect(cdesc) : null);
    if (std) {
      const q = standard.byId(std.id);
      const answer = (data.standardAnswers || {})[std.id] || '';
      const base = { key: 'std:' + std.id, confidence: std.confidence, source: 'standard:' + std.id, review: !!q.alwaysReview, yellowOnMiss: true };
      if (!answer) return { ...base, value: '', noFill: true, yellowOnMiss: false };
      const value = standard.fillValue(std.id, answer, desc, undefined, std);
      if (!value) {
        // A box that does not mean the stored answer stays unticked: that IS the answer.
        return desc.inputType === 'checkbox' ? { ...base, value: '', noFill: true, yellowOnMiss: false } : { ...base, value: '', noFill: true };
      }
      const key = ['select', 'radio', 'checkboxes'].includes(desc.inputType) ? base.key : 'qa';
      return { ...base, key, value };
    }

    // Profile keys come from the label as written: a company called LinkedIn
    // must not turn "LinkedIn profile" into "{company} profile".
    const match = matcher.matchField(desc);
    const profileValue = match ? matcher.valueFor(match.key, data.profile, inputKind(desc)) : '';
    const hit = qa.lookup(cdesc, data.qaEntries || [], desc);
    const qaWins = hit && (!profileValue || (hit.confidence === 1 && match.confidence < matcher.HIGH_CONFIDENCE));
    if (qaWins) {
      // An answer that names the company was stored as "{company}": say this
      // page's company, and have the owner read it (orange). Unknown company: no fill.
      const value = company.renderAnswer(hit.entry.answer, data.company);
      const named = company.hasPlaceholder(hit.entry.answer);
      if (value == null) return { key: 'qa', value: '', confidence: hit.confidence, source: hit.source, noFill: true };
      return { key: 'qa', value, confidence: hit.confidence, source: hit.source, review: named };
    }
    return { key: match && match.key, value: profileValue, confidence: match ? match.confidence : 0, source: match ? match.source : null };
  }

  async function fillField(field, data, opts) {
    const { matcher, filler } = AF;
    const { el, desc } = field;
    const markEl = field.markEl || el;

    // Salary and emergency-contact fields: never filled, never outlined.
    if (matcher.isIgnored(desc)) {
      return { el, markEl, desc, match: null, value: '', status: 'skipped', state: null };
    }

    if (field.outlineOnly) {
      let empty = true;
      try {
        empty = field.read ? !field.read() : filler.isEmpty(el);
      } catch (err) {
        root.console.warn('[autofill] read failed:', desc.label, err);
      }
      return { el, markEl, desc, match: null, value: '', status: 'skipped', state: desc.required && empty ? 'unknown' : null };
    }

    const plan = decide(field, data);
    const match = plan.key ? { key: plan.key, confidence: plan.confidence, source: plan.source } : null;
    const ctx = { key: plan.key, force: opts.force };

    let outcome;
    if (plan.noFill) {
      outcome = { status: 'nomatch' };
    } else {
      try {
        outcome = field.fill ? await field.fill(plan.value, ctx) : filler.fill(el, plan.value, ctx);
      } catch (err) {
        root.console.warn('[autofill] field failed:', desc.label, err);
        outcome = { status: 'failed' };
      }
    }

    let state = null;
    if (outcome.status === 'filled') {
      const confidence = Math.min(plan.confidence, outcome.confidence == null ? 1 : outcome.confidence);
      state = confidence >= matcher.HIGH_CONFIDENCE && !plan.review ? 'filled' : 'review';
    } else if (outcome.status === 'unverified') {
      state = 'review'; // we tried, it did not visibly stick: check it
    } else if (outcome.status === 'skipped') {
      state = null;
    } else if (desc.required || (plan.yellowOnMiss && outcome.status === 'nomatch')) {
      // Standard question whose options did not clearly contain the answer: yours.
      state = 'unknown';
    }
    return { el, markEl, desc, match, value: plan.value, status: outcome.status, state };
  }

  /**
   * opts = { profile, qaEntries, standardAnswers, profileName, doc, force, quiet, adapter }
   *   adapter: force an adapter by name (tests, and hand-saved pages whose
   *            hostname is file://).
   * Resolves { adapter, step, results: [{ el, markEl, desc, match, value, status, state }], counts }
   */
  async function run(opts) {
    const { feedback, widgets } = AF;
    const o = opts || {};
    const doc = o.doc || root.document;
    // o.company: tests pass one (or null); otherwise read it off the page.
    const company = o.company !== undefined ? o.company : AF.company.detect(doc);
    const data = { profile: o.profile || {}, qaEntries: o.qaEntries || [], standardAnswers: o.standardAnswers || {}, company };
    AF.standard.setAnswers(data.standardAnswers);
    let adapter = pickAdapter(doc, o.adapter);
    let fallback = null; // why the generic adapter took over, if it did

    feedback.ensureStyle(doc);
    // A second press must not hide what the first one asked the owner to check:
    // a field it filled (green / orange) now has a value and comes back
    // 'skipped', so it keeps its earlier outline.
    const prior = new Map();
    doc.querySelectorAll(`[${feedback.ATTR}="review"], [${feedback.ATTR}="filled"]`).forEach((el) => prior.set(el, el.getAttribute(feedback.ATTR)));
    feedback.clear(doc);

    let step = null;
    try {
      step = adapter.step ? adapter.step(doc) : null;
    } catch (err) {
      root.console.warn('[autofill]', adapter.name, 'step failed:', err);
    }
    const seen = new WeakSet();
    const results = [];
    const generic = AF.adapters.generic;
    const useGeneric = (why, err) => {
      root.console.warn('[autofill]', adapter.name, why + ': falling back to the generic adapter', err || '');
      fallback = { from: adapter.name, why };
      adapter = generic;
    };
    // A broken adapter (it throws, or finds nothing where it should find
    // something) never blocks the page: the generic adapter fills what it can.
    // An adapter that knows a page is empty on purpose (Workday's review step)
    // says so with nothingToFill(doc).
    // Adapters may leave out fields whose el is in ctx.seen (cheaper rescans);
    // the filter below keeps correctness independent of that.
    const ctx = { seen };
    const scan = (first) => {
      let fields;
      try {
        fields = adapter.findFields(doc, ctx);
      } catch (err) {
        if (adapter === generic) throw err;
        useGeneric('findFields failed', err);
        fields = adapter.findFields(doc, ctx);
      }
      if (first && !fields.length && adapter !== generic) {
        let empty = false;
        try {
          empty = !!(adapter.nothingToFill && adapter.nothingToFill(doc));
        } catch (err) {
          empty = false;
        }
        if (!empty) {
          useGeneric('found no fields');
          fields = adapter.findFields(doc, ctx);
        }
      }
      return fields.filter((f) => f.el.isConnected && !seen.has(f.el));
    };

    let queue = scan(true);
    let rescans = 0;
    while (queue.length && results.length < MAX_FIELDS) {
      const field = queue.shift();
      if (seen.has(field.el) || !field.el.isConnected) continue;
      seen.add(field.el);

      const r = await fillField(field, data, o);
      if (r.status === 'skipped' && !r.state && !field.outlineOnly && prior.has(r.markEl) && !AF.matcher.isIgnored(field.desc)) {
        r.state = prior.get(r.markEl);
        r.kept = true;
      }
      results.push(r);
      feedback.mark(r.markEl, r.state, r.desc.label);

      const changed = r.status === 'filled' || r.status === 'unverified';
      if (field.revealing && changed && rescans < MAX_RESCANS) {
        rescans++;
        await widgets.settle(doc);
        queue = scan();
      }
    }
    try {
      if (adapter.cleanup) await adapter.cleanup(doc);
    } catch (err) {
      root.console.warn('[autofill]', adapter.name, 'cleanup failed:', err);
    }

    // A re-render can replace elements we already outlined; count what is left.
    const live = results.filter((r) => r.markEl.isConnected);
    const counts = { filled: 0, review: 0, unknown: 0 };
    live.forEach((r) => r.state && counts[r.state]++);
    const embedded = embeddedForms(doc);
    // o.embedPlan (background.js, via core/run.js): what happens to the frames.
    //   filling: hosts filled in place -> background.js shows one toast for all;
    //   opening: a URL opened in its own tab -> say so here.
    const plan = o.embedPlan || null;
    if (!o.quiet) {
      if (plan && plan.filling && plan.filling.length) {
        // background.js reports this page and the frames together.
      } else if (plan && plan.opening) {
        const here = live.length ? ` (This page: ${counts.filled} filled · ${counts.review} to review · ${counts.unknown} need you.)` : '';
        feedback.notify(doc, 'Opened the application in its own tab. Press Alt+Z.' + here, 9000);
      } else if (embedded.length && !live.length) {
        feedback.notify(doc, `Formhand: the form is inside an embedded ${embedded[0]} frame, which Formhand cannot reach. ` +
          'Open the application on its own page (the job board\'s "Apply" link) and press Alt+Z there.', 9000);
      } else {
        feedback.toast(doc, counts, o.profileName, company && company.name);
      }
    }
    return { adapter: adapter.name, adapterObj: adapter, step, results: live, counts, embedded, company, fallback };
  }

  AF.autofill = { run, pickAdapter, embeddedForms };
})(typeof globalThis !== 'undefined' ? globalThis : this);
