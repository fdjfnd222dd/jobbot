/*
 * adapters/phenom.js — Phenom People career sites. Selectors verified against
 * real captures in fixtures/phenom/ (one employer's apply flow, contact + EEO steps).
 *
 * Phenom hosts the career site on the employer's own domain (careers.example.com),
 * so detection is by DOM: <html data-ph-id="..."> plus the apply form, a
 * react-jsonschema-form (<form class="rjsf">). The job itself may live in
 * Workday behind the scenes (the captured site links to <company>.wd12.myworkdayjobs.com),
 * but the form you fill is Phenom's: plain labelled inputs and native
 * <select>s, which the generic logic already handles.
 *
 * What this adapter adds:
 *   - scope: only the apply form, never the site header search, job cart,
 *     cookie banner or "job alerts" sign-up;
 *   - drops rjsf's machine-named legends ("cntryFields", "phoneWidget",
 *     "eeo USA") from the section context;
 *   - names the step from the legend so the console says where you are.
 * Country -> State re-render is covered by core/autofill.js rescanning after
 * every select.
 */
(function (root) {
  'use strict';

  const AF = (root.AF = root.AF || {});
  const generic = AF.adapters.generic;

  function form(doc) {
    return doc.querySelector('form.rjsf');
  }

  function detect(doc) {
    const isPhenom =
      doc.documentElement.hasAttribute('data-ph-id') ||
      !!doc.querySelector('script[src*="phenompeople"], [data-ph-at-id]');
    return isPhenom && !!form(doc);
  }

  // rjsf legends are schema ids ("cntryFields"): no spaces, or "eeo USA".
  function machineName(text) {
    return /^[a-z]+[A-Z][A-Za-z]*$/.test(text) || /^eeo\b/i.test(text);
  }

  function step(doc) {
    const f = form(doc);
    if (!f) return null;
    const legends = Array.from(f.querySelectorAll('legend')).map((l) => generic.clean(l.textContent));
    if (legends.some((t) => /^eeo\b/i.test(t))) return 'voluntaryDisclosures';
    if (legends.some((t) => /^cntryFields$/.test(t))) return 'contactInformation';
    return 'unknown';
  }

  function findFields(doc, ctx) {
    const f = form(doc);
    if (!f) return [];
    return generic.findFields(f, { seen: ctx && ctx.seen }).map((field) => {
      if (machineName(field.desc.context)) field.desc.context = '';
      return field;
    });
  }

  AF.adapters = AF.adapters || {};
  // Its form is on the page: an empty field list is the page's truth (a step
  // with only hidden fields), not a broken adapter, so no generic fallback.
  const nothingToFill = (doc) => !!form(doc);

  AF.adapters.phenom = { name: 'phenom', detect, step, findFields, nothingToFill };

  if (typeof module === 'object' && module.exports) module.exports = AF.adapters.phenom;
})(typeof globalThis !== 'undefined' ? globalThis : this);
