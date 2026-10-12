/*
 * adapters/eightfold.js — Eightfold PCS ("pcsx") application form, as used by
 * one large employer's career site. Selectors verified against real captures in
 * fixtures/eightfold/ (one internship application,
 * one capture with a Yes/No dropdown open). Dropdown behavior (filtering,
 * closing, how a pick lands in the input) is only simulated in tests
 * (tests/harness/eightfold.js): the live widget has not been driven yet.
 *
 * Markup (one page, every section rendered at once; the left stepper only scrolls):
 *   form[aria-describedby="hook-form-required-fields-note"]
 *     div[role=region][aria-labelledby=section-header-N] > h2 + section[data-form-section-id]
 *       > fieldset > div.field-<hash> (one per question)
 *   Class names carry build hashes (field-3Ez-x, required-3upJY): never select on
 *   them; ids, ARIA and [class*="select-module_..."] prefixes only.
 *   plain inputs     label[for] + input (Contact_Information_firstname, _q_phone,
 *                    _q_address, _q_city, _q_zip ...). Email is readonly (account).
 *   dropdowns        div#<WRAPPER>[class*=select-module_select-wrapper] (stable id,
 *                    e.g. Contact_Information_q_state) holding
 *                    input#input-<n>[role=combobox][aria-controls=list-<k>]
 *                    [aria-labelledby=<WRAPPER>_label]. input-<n> is renumbered
 *                    per render. The input's own value is the shown answer AND
 *                    the type-to-filter box. Open popup (inline, not portaled):
 *                    ul#list-<k>[role=listbox] > li > button[role=option][title].
 *   location         [class*=select-wrapper-multiple]: a pill list (pre-filled when
 *                    the job has one location). Never filled; yellow if empty.
 *   resume           Resume_* combobox picks an uploaded resume: never filled,
 *                    yellow while empty. The file input beside it is left alone.
 *   radios           div#<G>[role=radiogroup] whose aria-labelledby names a
 *                    missing "<G>_legend"; the question is label[for=<G>]
 *                    (generic.describeChoice handles both).
 *   acknowledgments  single "Yes" checkboxes; the question is the group's legend
 *                    (generic: bare option labels read the legend). Consent rules
 *                    apply: never ticked, except the owner's privacy-ack answer.
 *   navigation       footer Cancel / "Submit application", stepper buttons,
 *                    Clear / Remove / Upload / Preview buttons: never pressed
 *                    (press() only takes the combobox input and role=option).
 */
(function (root) {
  'use strict';

  const AF = (root.AF = root.AF || {});
  const generic = AF.adapters.generic;
  const widgets = AF.widgets;
  const matcher = AF.matcher;

  const WRAPPER = '[class*="select-module_select-wrapper"]';

  // Stable wrapper id suffix -> profile key.
  const KEY_HINTS = [
    [/_q_phone-country-code$/, 'phoneCountryCode'],
    [/_q_country$/, 'country'],
    [/_q_state$/, 'state'],
  ];

  function form(doc) {
    const f = doc.querySelector('form[aria-describedby="hook-form-required-fields-note"]');
    if (f) return f;
    const section = doc.querySelector('section[data-form-section-id]');
    return section ? section.closest('form') : null;
  }

  function detect(doc) {
    const f = form(doc);
    if (!f) return false;
    const host = (doc.location && doc.location.hostname) || '';
    if (/(^|\.)eightfold\.ai$/.test(host)) return true;
    // Tenants on their own domain / saved pages: Eightfold's section regions inside that form
    // (present on every captured tenant page, so no employer host needs naming here).
    return !!f.querySelector('[role="region"][aria-labelledby^="section-header-"] section[data-form-section-id]');
  }

  /** Field for one single-select combobox. */
  function comboField(input, wrapper, headings) {
    const doc = input.ownerDocument;
    const base = generic.describe(input, headings, { inputType: 'select' });
    const hint = KEY_HINTS.find(([re]) => re.test(wrapper.id || ''));
    if (hint) base.desc.keyHint = hint[1];

    const popup = () => {
      // aria-controls names the list; the popup also renders inside the wrapper.
      const id = input.getAttribute('aria-controls');
      const lb = (id && doc.getElementById(id)) || wrapper.querySelector('[role="listbox"]');
      return lb && lb.isConnected && widgets.isShown(lb) ? lb : null;
    };
    const value = () => generic.clean(input.value);
    // The input doubles as the search box: while the popup is open its text is
    // our query, not an answer. Report what was there before we opened it.
    let before = value();
    const current = () => (popup() ? before : value());

    return {
      ...base,
      markEl: input.closest('[class*="select-module_select-input-group"]') || input,
      revealing: true,
      read: current,
      fill: (val, ctx) =>
        widgets.fillPopup({
          doc,
          key: ctx.key,
          value: val,
          force: ctx.force,
          current,
          open: () => {
            before = value();
            return widgets.press(input);
          },
          popup,
          options: (lb) => Array.from(lb.querySelectorAll('[role="option"]')),
          noResults: (lb) => !lb.querySelector('[role="option"]') && /\bno (matches|results)\b/i.test(lb.textContent),
          search: () => input,
          // Option text is in its title (and label span); the input shows it once picked.
          verify: (text) => !popup() && matcher.normalize(value()) === matcher.normalize(text),
          close: () => {
            // Take our query back out before closing, or it would look like an answer.
            if (value() !== before) widgets.typeText(input, before);
            widgets.key(input, 'Escape');
          },
        }),
    };
  }

  // ctx = { seen } (optional): the run's WeakSet of elements already handled.
  // Seen elements are left out of the result, and skipped before any layout
  // query (visibility) or descriptor work; the rest is identical to no ctx.
  function findFields(doc, ctx) {
    const f = form(doc);
    if (!f) return [];
    const seen = (ctx && ctx.seen) || null;
    // Headings only matter for a field we build now: fetched on first use.
    let headings = null;
    const getHeadings = () => headings || (headings = Array.from(f.querySelectorAll(generic.HEADING_SELECTOR)));

    const plain = generic.findFields(f, {
      // Comboboxes are ours; the resume file input is covered by its picker.
      skip: (el) => el.type === 'file' || !!el.closest(WRAPPER),
      seen,
    });

    const combos = [];
    for (const input of f.querySelectorAll(`${WRAPPER} input[role="combobox"]`)) {
      if (seen && seen.has(input)) continue;
      const wrapper = input.closest(WRAPPER);
      const group = input.closest('[class*="select-module_select-input-group"]') || input;
      if (!generic.isVisible(input) && !widgets.isShown(group)) continue;
      const multi = /select-wrapper-multiple/.test(wrapper.className);
      if (multi) {
        // Location picker: pills are the value.
        const field = generic.describe(input, getHeadings());
        const pills = () => Array.from(wrapper.querySelectorAll('[class*="pills-module_label"]')).map((p) => generic.clean(p.textContent)).join(', ');
        combos.push(generic.outlineOnly({ ...field, markEl: group, read: pills }));
      } else if (/^Resume_/.test(wrapper.id || '')) {
        const field = generic.describe(input, getHeadings());
        combos.push(generic.outlineOnly({ ...field, markEl: group, read: () => generic.clean(input.value) }));
      } else {
        combos.push(comboField(input, wrapper, getHeadings()));
      }
    }
    return generic.inDocumentOrder(plain.concat(combos));
  }

  function step(doc) {
    return form(doc) ? 'application' : null;
  }

  AF.adapters = AF.adapters || {};
  // Its form is on the page: an empty field list is the page's truth (a step
  // with only hidden fields), not a broken adapter, so no generic fallback.
  const nothingToFill = (doc) => !!form(doc);

  AF.adapters.eightfold = { name: 'eightfold', detect, step, findFields, nothingToFill };

  if (typeof module === 'object' && module.exports) module.exports = AF.adapters.eightfold;
})(typeof globalThis !== 'undefined' ? globalThis : this);
