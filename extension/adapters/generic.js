/*
 * adapters/generic.js
 *
 * The fallback adapter: works on any plain HTML form. ATS-specific adapters
 * expose the same shape and reuse the helpers exported at the bottom:
 *
 *   { name, detect(doc) -> bool, findFields(doc, ctx?) -> [Field], step?(doc), cleanup?(doc) }
 *
 *   ctx = { seen }: the run's WeakSet of already-handled Field.el. An adapter may
 *   omit those fields (and should skip them before visibility checks / descriptor
 *   building); the fields it does return are identical to a call without ctx.
 *
 *   Field = { el, desc, fill?, markEl?, revealing? }
 *     desc       what core/matcher.js consumes: label, hints, context,
 *                autocomplete, inputType, required (+ optional keyHint)
 *     fill       async (value, { key, force }) -> outcome, for anything that
 *                is not a plain input/select (radio groups, custom dropdowns)
 *     markEl     element to outline (defaults to el)
 *     revealing  filling it may make new fields appear: rescan afterwards
 *     read       () -> the value the field shows now ('' = empty); learn mode
 *                diffs it to spot answers the user gave by hand
 *     outlineOnly  never filled; outlined yellow when required and empty
 *                (required fields inside sections we skip)
 */
(function (root) {
  'use strict';

  const AF = (root.AF = root.AF || {});
  const filler = AF.filler || (typeof require === 'function' ? require('../core/filler.js') : null);

  const FIELD_SELECTOR = 'input, textarea, select';
  const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, legend, [role="heading"]';
  const MAX_LABEL = 200;

  function clean(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  // A long label keeps its start AND its end: disclosure-style questions put a paragraph first and the
  // actual question last ("...export controls... Is your most recent country of citizenship one of the
  // following: North Korea; Syria; Iran; or Cuba?"). Cutting only the end dropped the question, and the
  // paragraph alone read as a plain export-control / U.S. person question.
  function cutLabel(text) {
    const s = clean(text);
    return s.length > MAX_LABEL ? s.slice(0, 80) + ' … ' + s.slice(-(MAX_LABEL - 83)) : s;
  }

  function isVisible(el) {
    if (el.disabled || el.readOnly) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (!el.getClientRects().length) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  // Text of a node without the text of form controls inside it
  // (a wrapping <label> often contains the <select> and all its options).
  function textWithoutControls(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll('input, textarea, select, option, script, style, button').forEach((n) => n.remove());
    return clean(clone.textContent);
  }

  function byIds(doc, ids) {
    return clean(
      String(ids || '')
        .split(/\s+/).filter(Boolean)
        .map((id) => doc.getElementById(id))
        .filter(Boolean)
        .map(textWithoutControls)
        .join(' ')
    );
  }

  function cssEscape(id) {
    return root.CSS && root.CSS.escape ? root.CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
  }

  // Closest preceding short text within a few ancestor levels, stopping as soon
  // as an ancestor also wraps another form control (its text would belong to it).
  function nearbyText(el) {
    let node = el;
    for (let depth = 0; depth < 4 && node && node.parentElement; depth++) {
      let sib = node.previousElementSibling;
      while (sib) {
        // A section heading is context, not this field's label.
        if (sib.matches(HEADING_SELECTOR)) return '';
        if (!sib.matches(FIELD_SELECTOR) && !sib.querySelector(FIELD_SELECTOR)) {
          const t = textWithoutControls(sib);
          if (t && t.length <= MAX_LABEL) return t;
        } else {
          return '';
        }
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
      if (node.querySelectorAll(FIELD_SELECTOR).length > 1) return '';
    }
    return '';
  }

  /**
   * Every label-ish string we can find. `label` is the first non-empty one in
   * priority order; the rest go into `hints` for the matcher's fallback.
   */
  function readLabel(el) {
    const doc = el.ownerDocument;
    const id = el.id;
    const forLabel = id ? doc.querySelector(`label[for="${cssEscape(id)}"]`) : null;
    const wrap = el.closest('label');
    const automationId =
      el.getAttribute('data-automation-id') ||
      (el.closest('[data-automation-id]') && el.closest('[data-automation-id]').getAttribute('data-automation-id'));

    const sources = {
      labelFor: forLabel ? textWithoutControls(forLabel) : '',
      ariaLabelledby: byIds(doc, el.getAttribute('aria-labelledby')),
      ariaLabel: clean(el.getAttribute('aria-label')),
      wrappingLabel: wrap ? textWithoutControls(wrap) : '',
      nearby: '',
      placeholder: clean(el.getAttribute('placeholder')),
      automationId: automationId ? AF.matcher.splitCamel(automationId) : '',
    };
    if (!sources.labelFor && !sources.ariaLabelledby && !sources.ariaLabel && !sources.wrappingLabel) {
      sources.nearby = nearbyText(el);
    }

    const order = ['labelFor', 'ariaLabelledby', 'ariaLabel', 'wrappingLabel', 'nearby', 'placeholder'];
    const label = order.map((k) => sources[k]).find(Boolean) || '';
    const hints = [sources.automationId, el.getAttribute('name'), id, sources.placeholder]
      .map(clean)
      .filter((h) => h && h !== label);
    return { label: cutLabel(label), hints, sources };
  }

  /** A fieldset's own <legend> (its child), not one of a nested fieldset. */
  function ownLegend(fs) {
    return Array.from(fs.children).find((c) => c.tagName === 'LEGEND') || null;
  }

  /**
   * Section context: fieldset legend / labelled group, else the nearest heading
   * that precedes the field in document order inside the same form.
   */
  function readContext(el, headings, isGroup) {
    // isGroup: el is a choice group whose own legend / label is the question;
    // the section is what surrounds it.
    const start = isGroup ? el.parentElement || el : el;
    // The nearest enclosing fieldset WITH its own legend: a wrapper fieldset
    // without one (Avature wraps a whole step in one) must not lend the legend
    // of the first question nested inside it.
    for (let fs = start.closest('fieldset'); fs; fs = fs.parentElement && fs.parentElement.closest('fieldset')) {
      const legend = ownLegend(fs);
      if (legend) return textWithoutControls(legend);
    }
    const group = start.closest('[role="group"][aria-labelledby], [role="region"][aria-labelledby]');
    if (group) return byIds(el.ownerDocument, group.getAttribute('aria-labelledby'));

    // A legend (or a heading inside a fieldset) speaks only for its own
    // fieldset: Greenhouse's "Phone" legend is not the context of every
    // question after the phone group, and an "Emergency contact" fieldset must
    // not veto the ordinary questions that follow it.
    const inScope = (h) => {
      const fs = h.closest('fieldset');
      return !fs || fs.contains(el);
    };
    let last = null;
    for (const h of headings) {
      // DOCUMENT_POSITION_FOLLOWING (4): el comes after h.
      if (h.compareDocumentPosition(el) & 4) {
        if (inScope(h)) last = h;
      } else break;
    }
    return last ? textWithoutControls(last) : '';
  }

  function isRequired(el, rawLabel) {
    return (
      el.required ||
      el.getAttribute('aria-required') === 'true' ||
      /\*\s*$|^\s*\*|\(required\)/i.test(rawLabel || '')
    );
  }

  /** Current value of a plain control as the user sees it ('' when empty). */
  function readControl(el) {
    if (el.tagName === 'SELECT') {
      const opt = el.options[el.selectedIndex];
      if (!opt || filler.isEmpty(el)) return '';
      return clean(opt.textContent) || opt.value;
    }
    return String(el.value || '').trim();
  }

  /** Radio group: the checked option's label. Checkboxes: 'Yes' / labels of checked boxes. */
  function readChoice(inputs) {
    const checked = inputs.filter((i) => i.checked);
    if (!checked.length) return '';
    if (inputs.length === 1 && inputs[0].type === 'checkbox') return 'Yes';
    return checked.map((i) => filler.choiceLabel(i)).join(', ');
  }

  /** Descriptor for one plain control (text-like input, textarea, native select). */
  function describe(el, headings, overrides) {
    const { label, hints, sources } = readLabel(el);
    const tag = el.tagName.toLowerCase();
    const inputType = tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : (el.type || 'text');
    const rawForRequired = sources.labelFor || sources.wrappingLabel || sources.ariaLabelledby || label;
    return {
      el,
      revealing: tag === 'select',
      read: () => readControl(el),
      desc: {
        label,
        hints,
        context: readContext(el, headings),
        autocomplete: el.getAttribute('autocomplete') || '',
        inputType,
        required: isRequired(el, rawForRequired),
        ...(overrides || {}),
      },
    };
  }

  // A radio's own label is its option text; the question is the group's label.
  // Normally the closest radiogroup / group / fieldset. Some forms wrap EACH
  // option in its own fieldset (one company-built form: <fieldset id="<name>"> per radio,
  // duplicate ids): then climb to the lowest ancestor holding every option.
  function groupContainer(input, inputs) {
    const all = inputs && inputs.length ? inputs : [input];
    let c = input.closest('[role="radiogroup"], [role="group"], fieldset') || input.parentElement;
    if (all.every((i) => c.contains(i))) return c;
    c = input.parentElement;
    while (c && !all.every((i) => c.contains(i))) c = c.parentElement;
    return c || input.parentElement;
  }

  function labelForId(doc, id) {
    const l = id ? doc.querySelector(`label[for="${cssEscape(id)}"]`) : null;
    return l ? textWithoutControls(l) : '';
  }

  function groupLabel(container, first) {
    const doc = first.ownerDocument;
    if (container) {
      // aria-labelledby can point at an id that does not exist (Eightfold's
      // radiogroups name a missing "<id>_legend"): fall through when empty.
      const by = byIds(doc, container.getAttribute('aria-labelledby'));
      if (by) return by;
      if (container.getAttribute('aria-label')) return clean(container.getAttribute('aria-label'));
      const legend = container.matches('fieldset') ? ownLegend(container) : null;
      if (legend) return textWithoutControls(legend);
      // <label for="<group id>"> (Eightfold) or <label for="<radio name>"> (a company-built form).
      const forGroup = labelForId(doc, container.id) || labelForId(doc, first.getAttribute('name'));
      if (forGroup) return forGroup;
    }
    return nearbyText(container || first);
  }

  // A checkbox whose own label is just an answer word ("Yes"): the question is
  // its group's legend / aria-labelledby (Eightfold acknowledgments). Without
  // this the consent rules would see the label "Yes" and miss the box.
  // Consent words ("I agree") are kept next to the group text, so qa.isConsent
  // still sees them. Only a group holding just this box counts: a section-wide
  // region or fieldset is not the box's question.
  const BARE_ANSWER = /^(yes|no|ok|true)$/;
  const BARE_CONSENT = /^(i agree|agree|i accept|accept|i acknowledge|acknowledge|i confirm|confirm|i certify|certify|i declare|i authorize|i consent)$/;

  function checkboxQuestion(box, ownLabel) {
    const own = AF.matcher.normalize(ownLabel);
    if (ownLabel && !BARE_ANSWER.test(own) && !BARE_CONSENT.test(own)) return ownLabel;
    const doc = box.ownerDocument;
    const group = box.parentElement && box.parentElement.closest('[aria-labelledby], fieldset, [role="group"]');
    const own_ = (g) => Array.from(g.querySelectorAll(FIELD_SELECTOR)).every((c) => c === box || (c.type === 'checkbox' && c.name && c.name === box.name));
    let q = '';
    if (group && own_(group)) {
      q = byIds(doc, group.getAttribute('aria-labelledby'));
      if (!q && group.matches('fieldset') && ownLegend(group)) q = textWithoutControls(ownLegend(group));
      if (!q) q = labelForId(doc, group.id);
    }
    if (!q) return ownLabel;
    return BARE_CONSENT.test(own) ? `${q} ${ownLabel}` : q;
  }

  /** Radio group (all radios sharing a name) or one checkbox, as a single field. */
  function describeChoice(inputs, headings, overrides) {
    const first = inputs[0];
    const isCheckbox = first.type === 'checkbox';
    const container = isCheckbox ? null : groupContainer(first, inputs);
    const label = isCheckbox ? checkboxQuestion(first, readLabel(first).label) : groupLabel(container, first);
    // Section context comes from outside the group's own fieldset/legend, but
    // headings are searched from the group's own position: from its parent,
    // a heading inside the same <form> would come "after" the form start.
    const ctxEl = container || first;
    const required =
      inputs.some((i) => i.required || i.getAttribute('aria-required') === 'true') ||
      (container && container.getAttribute('aria-required') === 'true') ||
      /\*\s*$|^\s*\*/.test(label);
    const markEl = isCheckbox
      ? (first.labels && first.labels[0]) || first
      : container || first;
    return {
      el: first,
      markEl,
      revealing: true,
      fill: (value, ctx) => filler.fillChoice(inputs, value, ctx),
      read: () => readChoice(inputs),
      desc: {
        label: cutLabel(label),
        hints: [first.getAttribute('name')].filter(Boolean),
        context: readContext(ctxEl, headings, !!container),
        autocomplete: '',
        // A list of boxes is answered like a radio group (one box per answer).
        inputType: isCheckbox ? (inputs.length > 1 ? 'checkboxes' : 'checkbox') : 'radio',
        required,
        ...(overrides || {}),
      },
    };
  }

  // Custom-styled radios often hide the input itself and show its label.
  function choiceVisible(input) {
    if (input.disabled) return false;
    if (isVisible(input)) return true;
    return Array.from(input.labels || []).some((l) => l.getClientRects().length > 0);
  }

  /**
   * options.skip(el) -> true to ignore a control (adapters use this for their
   * own widgets and for sections they leave alone).
   * options.overrides(el) -> extra desc fields for a plain control (keyHint).
   * options.seen -> WeakSet of elements the pass already handled (Field.el): a
   * control in it, or a radio group whose first radio is in it, is left out
   * BEFORE any visibility check or descriptor work. Everything else comes back
   * exactly as without it (core/autofill.js filters seen fields anyway).
   */
  function findFields(scope, options) {
    const o = options || {};
    const seen = o.seen || null;
    const rootNode = scope.body || scope;
    const headings = Array.from(rootNode.querySelectorAll(HEADING_SELECTOR));
    const out = [];
    const radioGroups = new Map();
    let allRadios = null;

    for (const el of rootNode.querySelectorAll(FIELD_SELECTOR)) {
      const kind = filler.kindOf(el);
      if (!kind || (o.skip && o.skip(el))) continue;
      if (kind === 'radio') {
        const name = el.name || el.id;
        if (radioGroups.has(name)) continue;
        if (!allRadios) allRadios = Array.from(rootNode.querySelectorAll('input[type="radio"]'));
        const group = allRadios.filter((r) => (r.name || r.id) === name && !(o.skip && o.skip(r)));
        // The group's Field.el is its first radio: already handled = skip the group.
        if (seen && seen.has(group[0])) {
          radioGroups.set(name, true);
          continue;
        }
        if (!choiceVisible(el)) continue;
        radioGroups.set(name, true);
        out.push(describeChoice(group, headings));
        continue;
      }
      if (seen && seen.has(el)) continue;
      if (kind === 'checkbox') {
        if (choiceVisible(el)) out.push(describeChoice([el], headings));
        continue;
      }
      if (isVisible(el)) out.push(describe(el, headings, o.overrides ? o.overrides(el) : null));
    }
    return out;
  }

  /**
   * Required controls inside sections we deliberately skip (repeating
   * entries, file uploads): never filled, outlined yellow while empty so they
   * are not missed. `required` overrides the element's own marker (Greenhouse
   * puts aria-required on the upload group, not the input).
   */
  function outlineOnly(field, required) {
    const f = { ...field, outlineOnly: true, revealing: false };
    f.desc = { ...field.desc, required: required == null ? field.desc.required : required };
    return f;
  }

  /** Outline-only field for a file input; markEl = its visible container. */
  function fileField(input, markEl, required, headings) {
    const base = describe(input, headings || [], { inputType: 'file' });
    return outlineOnly(
      { ...base, markEl: markEl || input.parentElement || input, read: () => (input.files && input.files.length ? 'file' : '') },
      required
    );
  }

  /** Sort fields into document order (adapters merge several finders). */
  function inDocumentOrder(fields) {
    return fields.sort((a, b) => (a.el.compareDocumentPosition(b.el) & 4 ? -1 : 1));
  }

  AF.adapters = AF.adapters || {};
  AF.adapters.generic = {
    name: 'generic',
    detect: () => true,
    findFields,
    // Helpers for the ATS adapters.
    readLabel,
    readContext,
    readControl,
    readChoice,
    isRequired,
    isVisible,
    clean,
    textWithoutControls,
    describe,
    describeChoice,
    outlineOnly,
    fileField,
    inDocumentOrder,
    HEADING_SELECTOR,
  };

  if (typeof module === 'object' && module.exports) module.exports = AF.adapters.generic;
})(typeof globalThis !== 'undefined' ? globalThis : this);
