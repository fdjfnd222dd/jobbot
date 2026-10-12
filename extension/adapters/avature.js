/*
 * adapters/avature.js — Avature-hosted application wizards. Selectors verified
 * against real captures in fixtures/avature/ (one employer, steps 3, 4 and 6 of 6, two
 * captures with a select2 dropdown open); select2 event/ajax behavior is from the
 * library and only simulated in tests (tests/harness/select2.js).
 *
 * Markup:
 *   form.tpt_wizard.form--step<N>      one wizard step per page load
 *   div#fieldSpecContainer<id>.fieldSpec.<Kind>[.isRequired|.isReq]
 *     Kind: TextField, EmailField, SelectFormField (+AutoCompleteField = select2),
 *           DateFormField, RadioButtonListFormField, CheckBoxListFormField,
 *           AcceptanceCheckboxField, FileSchemaField, JobVariableField,
 *           datasetField (repeating rows), ButtonBarField (Back/Continue/Cancel)
 *     label#<id>-label (or legend#<id>-label for radios and month/year dates)
 *       contains .labelRequiredIcon "*" and span#<id>-labelValue
 *       .screenReaderVisibility that ECHOES THE CURRENT VALUE: stripped.
 *   .WizardFieldHidden    internal fields hidden by CSS: skipped by class,
 *                         because saved pages render without that CSS.
 *   datasetField rows     div.datasetField > div.datasetcontent >
 *                           fieldset#datasetField__row--<id>-sample[hidden]  TEMPLATE
 *                           fieldset#datasetField__row--<id>_<n>             real rows
 *                         row fields: .fieldSpec--in-dataset, ids <id>-<k>-<n>.
 *                         The education dataset (preceding Separator legend
 *                         "Education History"; its own label is empty) has its
 *                         FIRST real row filled from the profile: Degree name,
 *                         Type of Degree (native select), University, End date
 *                         month/year (-> grad month/year). Start date, Education
 *                         ID and Completed? have no profile key. Every other row
 *                         and dataset (work history) is skipped; their required
 *                         fields, and a required resume (FileSchemaField), are
 *                         outlined yellow.
 *   select2 4.0.x         native <select> (often holding only the placeholder:
 *                         options are fetched by ajax on open) + sibling
 *                         span.select2 > .select2-selection[role=combobox]
 *                         [aria-controls=select2-<id>-results]. Opens on
 *                         mousedown; dropdown appended to <body>:
 *                         .select2-container--open .select2-dropdown
 *                           input.select2-search__field
 *                           ul#select2-<id>-results[role=listbox]
 *                             li.select2-results__option[role=option]
 *                             (li.loading-results while searching)
 *                         An option is chosen on MOUSEUP (4.0), not click.
 *   month/year date       fieldset > legend + selects <id>_year / <id>_month
 *   radios                div#<id>[role=radiogroup][aria-labelledby=<id>-label]
 *   Button bar            button[type=submit] "< Back" / "Continue",
 *                         button[type=reset] "Cancel": never touched.
 */
(function (root) {
  'use strict';

  const AF = (root.AF = root.AF || {});
  const generic = AF.adapters.generic;
  const widgets = AF.widgets;
  const matcher = AF.matcher;

  const SKIP_KINDS =
    '.WizardFieldHidden, .JobVariableField, .ButtonBarField, .FileSchemaField, ' +
    '.datasetField, .fieldSpec--in-dataset, .formContainer';

  function form(doc) {
    return doc.querySelector('form.tpt_wizard');
  }

  function detect(doc) {
    const f = form(doc);
    return !!f && !!f.querySelector('.fieldSpec[id^="fieldSpecContainer"]');
  }

  function step(doc) {
    const f = form(doc);
    const m = f && /\bform--step(\d+)\b/.exec(f.className);
    return m ? 'step' + m[1] : null;
  }

  /** Label text without the required star and the hidden echo of the value. */
  function cleanLabel(labelEl) {
    if (!labelEl) return '';
    const c = labelEl.cloneNode(true);
    c.querySelectorAll('.screenReaderVisibility, .labelRequiredIcon').forEach((n) => n.remove());
    return generic.textWithoutControls(c);
  }

  function specId(spec) {
    return spec.id.replace(/^fieldSpecContainer/, '');
  }

  function isRequired(spec) {
    return /\b(isRequired|isReq)\b/.test(spec.className);
  }

  /** Field for one select2-enhanced <select>. */
  function select2Field(spec, select, label, context) {
    const doc = select.ownerDocument;
    const selection = spec.querySelector('.select2-selection');
    const resultsId = selection.getAttribute('aria-controls') || 'select2-' + select.id + '-results';

    const current = () => {
      const rendered = selection.querySelector('.select2-selection__rendered');
      if (rendered && !rendered.querySelector('.select2-selection__placeholder')) {
        const t = generic.clean(rendered.getAttribute('title') || rendered.textContent);
        if (t && !matcher.isPlaceholderText(t)) return t;
      }
      const opt = select.options[select.selectedIndex];
      return opt && opt.value !== '' ? generic.clean(opt.textContent) : '';
    };
    const popup = () => {
      const ul = doc.getElementById(resultsId);
      return ul && ul.closest('.select2-container--open') ? ul : null;
    };
    const searchField = () => {
      const ul = popup();
      const box = ul && ul.closest('.select2-dropdown');
      return box ? box.querySelector('.select2-search__field') : null;
    };

    return {
      el: select,
      markEl: selection,
      revealing: true,
      read: current,
      desc: {
        label,
        hints: [],
        context,
        autocomplete: '',
        inputType: 'select',
        required: isRequired(spec) || selection.getAttribute('aria-required') === 'true',
      },
      fill: (value, ctx) =>
        widgets.fillPopup({
          doc,
          key: ctx.key,
          value,
          force: ctx.force,
          current,
          open: () => widgets.press(selection),
          popup,
          options: (ul) =>
            Array.from(ul.querySelectorAll('li.select2-results__option[role="option"]')).filter(
              (li) => !li.classList.contains('loading-results') && li.getAttribute('aria-disabled') !== 'true'
            ),
          loading: (ul) => !!ul.querySelector('.loading-results'),
          noResults: (ul) => !!ul.querySelector('.select2-results__message'),
          search: searchField,
          verify: (text) => matcher.normalize(current()) === matcher.normalize(text),
          close: () => {
            const s = searchField();
            widgets.key(s || selection, 'Escape');
          },
        }),
    };
  }

  /** Section title of a dataset: its own label, else the preceding Separator legend. */
  function datasetTitle(ds) {
    const own = cleanLabel(ds.ownerDocument.getElementById(specId(ds) + '-label'));
    if (own) return own;
    for (let n = ds.previousElementSibling; n; n = n.previousElementSibling) {
      const legend = n.matches('.Separator') ? n.querySelector('legend') : null;
      if (legend) return generic.clean(legend.textContent);
      if (n.matches('.fieldSpec:not(.Separator)')) break;
    }
    return '';
  }

  /** The specs of the first real row of the education dataset (a Set, maybe empty). */
  function firstEducationRow(f) {
    for (const ds of f.querySelectorAll('.fieldSpec.datasetField')) {
      if (!/\beducation\b/i.test(datasetTitle(ds))) continue;
      const row = ds.querySelector('fieldset.datasetField__row:not(.datasetField__row--sample):not([hidden])');
      if (row) return new Set(row.querySelectorAll('.fieldSpec--in-dataset'));
    }
    return new Set();
  }

  /** Outline-only fields for the required controls of one skipped spec. */
  function outlineSpec(spec, headings, seen) {
    const ctl = spec.querySelector('input:not([type="hidden"]), textarea, select');
    if (!ctl || (seen && seen.has(ctl))) return [];
    if (ctl.type === 'file') return [generic.fileField(ctl, spec, true, headings)];
    const s2 = spec.querySelector('.select2-selection[role="combobox"]');
    if (s2 && ctl.tagName === 'SELECT') {
      const label = cleanLabel(spec.ownerDocument.getElementById(specId(spec) + '-label'));
      return [generic.outlineOnly(select2Field(spec, ctl, label, generic.readContext(spec, headings)), true)];
    }
    if (!generic.isVisible(ctl)) return [];
    const label = cleanLabel(spec.ownerDocument.getElementById(specId(spec) + '-label'));
    return [generic.outlineOnly(generic.describe(ctl, headings, { label: label || generic.readLabel(ctl).label }), true)];
  }

  // ctx.seen: elements the pass already handled. A spec whose field element is in
  // it is skipped before its label / context / visibility work (see core/autofill.js).
  function findFields(doc, ctx) {
    const f = form(doc);
    if (!f) return [];
    const seen = ctx && ctx.seen;
    const isSeen = (el) => !!seen && seen.has(el);
    const headings = Array.from(f.querySelectorAll(generic.HEADING_SELECTOR));
    const out = [];
    const eduRow = firstEducationRow(f);

    for (const spec of f.querySelectorAll('.fieldSpec[id^="fieldSpecContainer"]')) {
      if (spec.closest('[hidden], .datasetField__row--sample')) continue;
      const inEdu = eduRow.has(spec);
      if (!inEdu && spec.matches(SKIP_KINDS)) {
        const skippedRow = spec.matches('.fieldSpec--in-dataset, .FileSchemaField');
        if (skippedRow && isRequired(spec)) out.push(...outlineSpec(spec, headings, seen));
        continue;
      }
      const id = specId(spec);
      // Label / context are pure reads: computed only once a field is really built.
      let info = null;
      const getInfo = () => {
        if (!info) {
          const label = cleanLabel(doc.getElementById(id + '-label'));
          const context = generic.readContext(spec, headings);
          info = { label, context, base: { label, context, required: isRequired(spec) } };
        }
        return info;
      };

      // select2 dropdown
      const s2 = spec.querySelector('.select2-selection[role="combobox"]');
      const select = spec.querySelector('select');
      if (s2 && select) {
        if (isSeen(select)) continue;
        if (generic.isVisible(s2)) out.push(select2Field(spec, select, getInfo().label, getInfo().context));
        continue;
      }

      // Radio list / checkboxes: one choice field.
      const radios = Array.from(spec.querySelectorAll('input[type="radio"]'));
      if (radios.length) {
        if (isSeen(radios[0])) continue;
        out.push(generic.describeChoice(radios, headings, getInfo().base));
        continue;
      }
      const boxes = Array.from(spec.querySelectorAll('input[type="checkbox"]'));
      if (boxes.length) {
        if (isSeen(boxes[0])) continue;
        const { label, base } = getInfo();
        // Single box: its own text is the statement ("I certify"), the field label the
        // context of it ("If you provide inaccurate responses ..."): keep both, so the
        // consent rules see "I certify". Lists: the field label.
        let over = base;
        if (boxes.length === 1) {
          const own = generic.readLabel(boxes[0]).label;
          over = !label ? {} : { ...base, label: own && own !== label ? `${label} ${own}` : label };
        }
        out.push(generic.describeChoice(boxes, headings, over));
        continue;
      }

      // Month/year (and day/month) date: one native select per part.
      const parts = Array.from(spec.querySelectorAll('select[id$="_year"], select[id$="_month"], select[id$="_day"]'));
      if (parts.length) {
        const { label, base } = getInfo();
        for (const part of parts) {
          if (isSeen(part)) continue;
          const which = /_(year|month|day)$/.exec(part.id)[1];
          const extra = { ...base, label: `${label} ${which}`.trim() };
          // Education row "End date" = graduation (expected or past).
          if (inEdu && /^end date$/i.test(label) && which !== 'day') extra.keyHint = which === 'year' ? 'gradYear' : 'gradMonth';
          out.push(generic.describe(part, headings, extra));
        }
        continue;
      }

      // Plain input / textarea / native select.
      const ctl = spec.querySelector('input:not([type="hidden"]):not([type="file"]), textarea, select');
      if (ctl && !isSeen(ctl) && AF.filler.kindOf(ctl) && generic.isVisible(ctl)) {
        const { label, base } = getInfo();
        out.push(generic.describe(ctl, headings, { ...base, label: label || generic.readLabel(ctl).label }));
      }
    }
    return out;
  }

  AF.adapters = AF.adapters || {};
  // Its form is on the page: an empty field list is the page's truth (a step
  // with only hidden fields), not a broken adapter, so no generic fallback.
  const nothingToFill = (doc) => !!form(doc);

  AF.adapters.avature = { name: 'avature', detect, step, findFields, nothingToFill, cleanLabel };

  if (typeof module === 'object' && module.exports) module.exports = AF.adapters.avature;
})(typeof globalThis !== 'undefined' ? globalThis : this);
