/*
 * adapters/greenhouse.js — Greenhouse job boards. Selectors verified against
 * fixtures/greenhouse/job_boards_greenhouse_io_* (two applications on one board, one
 * capture with the School dropdown open); react-select event behavior is from
 * the library and only simulated in tests (tests/harness/react-select.js).
 *
 * Markup (new job-boards.greenhouse.io, a Remix/React app):
 *   form#application-form.application--form
 *   plain inputs     .input-wrapper > label[for] + input.input  (first_name,
 *                    last_name, preferred_name, email, phone, question_<n>)
 *   dropdowns        react-select v5, class prefix "select__":
 *                      .select__container > label#<id>-label
 *                        .select__control > .select__value-container
 *                          .select__placeholder | .select__single-value
 *                          input#<id>.select__input[role=combobox][aria-labelledby=<id>-label]
 *                      + a hidden input.*-requiredInput (form validation only)
 *                    open:   .select__menu > .select__menu-list[role=listbox]
 *                              #react-select-<id>-listbox
 *                            options .select__option[role=option]
 *                              #react-select-<id>-option-<n>
 *                    The menu exists only while open, inside the container.
 *                    react-select opens on mousedown on the control; typing
 *                    into the input filters (School is server-searched).
 *   "Country*"       sits in the Phone fieldset: it is the dial-code picker.
 *                    Once chosen it displays only a flag + "+1", not the
 *                    option text, so verification accepts a shown value that
 *                    is contained in the chosen option.
 *   phone country    intl-tel-input (.iti, input.iti__search-input): left at
 *                    its default.
 *   education        .education--container > .education--form (one per entry)
 *                    + button.add-another-button. Fields school--N, degree--N,
 *                    discipline--N, end-month--N (react-selects), end-year--N
 *                    (number input), all required. N is NOT stable between
 *                    renders (--0 vs --1 in the captures), so the FIRST
 *                    .education--form by DOM position is filled from the
 *                    profile (keys from the id prefix); later entries are
 *                    skipped and their required fields outlined yellow.
 *   resume           div.file-upload[aria-required=true] > input#resume[type=file]:
 *                    never touched, outlined yellow while empty.
 *   EEO              gender, hispanic_ethnicity, veteran_status (+ race once
 *                    Hispanic = No): standard answers (core/standard.js).
 *   Phase 4 (a second company's capture, the /embed/job_app page opened directly):
 *     #candidate-location  "Location (City)": a react-select with no arrow and an
 *                    empty placeholder = search-as-you-type geo lookup. Options
 *                    were never captured; the strict match on the city alone
 *                    picks nothing, so it stays yellow (UNVERIFIED format).
 *     #demographic-section  numeric ids 41..45, all MULTI react-selects: skipped
 *                    like every multi-select (optional, so not outlined).
 *     Education may hold only school--N (no degree/discipline/dates).
 *   Embedded boards (iframe#grnhse_iframe on CareerPuck and company sites) are
 *   cross-origin: core/autofill.js only reports them (embeddedForms).
 */
(function (root) {
  'use strict';

  const AF = (root.AF = root.AF || {});
  const generic = AF.adapters.generic;
  const widgets = AF.widgets;
  const matcher = AF.matcher;

  const SKIP_SECTIONS = '.education--container';

  // First education entry: id prefix -> profile key.
  const EDU_KEYS = [
    ['school--', 'school'],
    ['degree--', 'degree'],
    ['discipline--', 'major'],
    ['end-month--', 'gradMonth'],
    ['end-year--', 'gradYear'],
  ];

  function form(doc) {
    return doc.querySelector('form#application-form, form.application--form');
  }

  function detect(doc) {
    const host = (doc.location && doc.location.hostname) || '';
    if (/(^|\.)greenhouse\.io$/.test(host)) return !!form(doc);
    // Saved pages and custom domains: the form plus Greenhouse's own markers.
    const marked = !!doc.querySelector(
      'link[rel="canonical"][href*="greenhouse.io"], meta[property="og:url"][content*="greenhouse.io"]'
    );
    return marked && !!form(doc);
  }

  function labelFor(input) {
    const doc = input.ownerDocument;
    const by = input.getAttribute('aria-labelledby');
    const el = (by && doc.getElementById(by.split(/\s+/)[0])) || doc.getElementById(input.id + '-label');
    return el ? generic.textWithoutControls(el) : generic.clean(input.getAttribute('aria-label'));
  }

  /** Field for one react-select single-value dropdown. */
  function reactSelectField(input, headings) {
    const doc = input.ownerDocument;
    const container = input.closest('.select__container') || input.closest('.select');
    const control = container.querySelector('.select__control');
    const label = labelFor(input);

    const current = () => {
      const sv = container.querySelector('.select__single-value');
      return sv ? generic.clean(sv.textContent) : '';
    };
    const popup = () => {
      const id = input.getAttribute('aria-controls');
      const lb = (id && doc.getElementById(id)) || container.querySelector('[role="listbox"]');
      return lb && lb.isConnected ? lb : null;
    };

    return {
      el: input,
      markEl: control || input,
      revealing: true,
      read: current,
      desc: {
        label,
        hints: [input.id],
        context: generic.readContext(input, headings),
        autocomplete: '',
        inputType: 'select',
        required: input.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label),
      },
      fill: (value, ctx) =>
        widgets.fillPopup({
          doc,
          key: ctx.key,
          value,
          force: ctx.force,
          current,
          open: () => widgets.press(control),
          popup,
          options: (lb) => Array.from(lb.querySelectorAll('[role="option"]')),
          loading: () => !!container.querySelector('.select__menu-notice--loading'),
          noResults: () => !!container.querySelector('.select__menu-notice--no-options'),
          search: () => input,
          // The phone "Country" picker shows only flag + "+1" once chosen, so
          // accept a shown value that is part of the option we picked.
          verify: (text) => {
            const cur = matcher.normalize(current());
            const want = matcher.normalize(text);
            return !!cur && (cur === want || want.includes(cur));
          },
          close: () => widgets.key(input, 'Escape'),
        }),
    };
  }

  // ctx.seen: elements the pass already handled; they are skipped before any
  // visibility check or descriptor work (see core/autofill.js).
  function findFields(doc, ctx) {
    const f = form(doc);
    if (!f) return [];
    const seen = ctx && ctx.seen;
    const isSeen = (el) => !!seen && seen.has(el);
    const headings = Array.from(f.querySelectorAll(generic.HEADING_SELECTOR));
    const firstEdu = f.querySelector('.education--container .education--form');
    const inFirstEdu = (el) => !!firstEdu && firstEdu.contains(el);
    const skipSection = (el) => !!el.closest(SKIP_SECTIONS) && !inFirstEdu(el);
    const eduKey = (el) => {
      if (!inFirstEdu(el)) return null;
      const hit = EDU_KEYS.find(([prefix]) => el.id.startsWith(prefix));
      return hit ? hit[1] : null;
    };
    const hint = (el) => (eduKey(el) ? { keyHint: eduKey(el) } : null);

    const plain = generic.findFields(f, {
      // react-select's hidden validation input and anything in a skipped section.
      skip: (el) => skipSection(el) || !!el.closest('.select__container'),
      overrides: hint,
      seen,
    });

    const combos = Array.from(f.querySelectorAll('input.select__input[role="combobox"]'))
      .filter((input) => !isSeen(input))
      .filter((input) => !skipSection(input))
      // Multi-selects ("select all that apply") are Phase 3 questions.
      .filter((input) => !input.closest('.select__value-container--is-multi'))
      .filter((input) => {
        const control = input.closest('.select__control');
        return control && generic.isVisible(control);
      })
      .map((input) => {
        const field = reactSelectField(input, headings);
        if (eduKey(input)) field.desc.keyHint = eduKey(input);
        return field;
      });

    // Required fields we do not fill: later education entries, the resume upload.
    const outlines = [];
    for (const input of f.querySelectorAll(`${SKIP_SECTIONS} input.select__input[role="combobox"]`)) {
      if (isSeen(input)) continue;
      const control = input.closest('.select__control');
      if (skipSection(input) && control && generic.isVisible(control)) {
        outlines.push(generic.outlineOnly(reactSelectField(input, headings)));
      }
    }
    for (const input of f.querySelectorAll(`${SKIP_SECTIONS} input.input, ${SKIP_SECTIONS} input[type="number"]`)) {
      if (isSeen(input)) continue;
      if (skipSection(input) && generic.isVisible(input)) outlines.push(generic.outlineOnly(generic.describe(input, headings)));
    }
    for (const group of f.querySelectorAll('.file-upload[aria-required="true"]')) {
      const input = group.querySelector('input[type="file"]');
      if (input && !isSeen(input)) outlines.push(generic.fileField(input, group, true, headings));
    }

    return generic.inDocumentOrder(plain.concat(combos, outlines));
  }

  function step(doc) {
    return form(doc) ? 'application' : null;
  }

  AF.adapters = AF.adapters || {};
  // Its form is on the page: an empty field list is the page's truth (a step
  // with only hidden fields), not a broken adapter, so no generic fallback.
  const nothingToFill = (doc) => !!form(doc);

  AF.adapters.greenhouse = { name: 'greenhouse', detect, step, findFields, nothingToFill };

  if (typeof module === 'object' && module.exports) module.exports = AF.adapters.greenhouse;
})(typeof globalThis !== 'undefined' ? globalThis : this);
