/*
 * core/filler.js
 *
 * Writes values into form controls so that React / Angular / Vue notice.
 *
 * Why the dance: React keeps its own copy of an input's value. Assigning
 * `el.value = x` goes through React's patched setter, React thinks nothing
 * changed, and the next render wipes our text. Calling the *native* prototype
 * setter bypasses React's copy, and the following `input` event makes React
 * read the new value. `change` and `blur` cover Angular and validators that
 * only run when a field loses focus.
 *
 * Handles text-like inputs, textareas, native <select>s (fill), and radio
 * groups / checkboxes (fillChoice). Custom dropdown widgets live in
 * core/widgets.js; a text input that is really a combobox (role=combobox,
 * aria-autocomplete) is NOT treated as text here, because typing into it
 * selects nothing.
 *
 * The only "click" in this file is on a radio button or checkbox the matcher
 * chose, through AF.widgets.press(), which refuses anything navigational.
 */
(function (root) {
  'use strict';

  const AF = (root.AF = root.AF || {});
  const matcher = AF.matcher || (typeof require === 'function' ? require('./matcher.js') : null);

  const TEXT_TYPES = new Set(['', 'text', 'email', 'tel', 'url', 'search', 'number', 'month', 'date']);

  function isComboboxInput(el) {
    return (
      el.getAttribute('role') === 'combobox' ||
      el.hasAttribute('aria-autocomplete') ||
      /^(listbox|true|grid|tree)$/.test(el.getAttribute('aria-haspopup') || '')
    );
  }

  function kindOf(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return el.multiple ? null : 'select';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'radio' || type === 'checkbox') return type;
      return TEXT_TYPES.has(type) && !isComboboxInput(el) ? 'text' : null;
    }
    return null;
  }

  function isPlaceholderOption(opt) {
    if (!opt) return true;
    return opt.value === '' || matcher.isPlaceholderText(opt.textContent);
  }

  /** True when the control has no user-meaningful value. */
  function isEmpty(el) {
    const kind = kindOf(el);
    if (kind === 'select') {
      return el.selectedIndex < 0 || isPlaceholderOption(el.options[el.selectedIndex]);
    }
    if (kind === 'radio' || kind === 'checkbox') return !el.checked;
    return String(el.value || '').trim() === '';
  }

  function nativeSetter(el, prop) {
    const view = el.ownerDocument.defaultView;
    const protos = [view.HTMLInputElement, view.HTMLTextAreaElement, view.HTMLSelectElement];
    for (const ctor of protos) {
      if (el instanceof ctor) {
        const desc = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
        if (desc && desc.set) return desc.set;
      }
    }
    return null;
  }

  function fire(el, type, Ctor) {
    const view = el.ownerDocument.defaultView;
    const E = view[Ctor || 'Event'];
    el.dispatchEvent(new E(type, { bubbles: type !== 'focus' && type !== 'blur', cancelable: false }));
  }

  /**
   * Set `prop` ("value" or "selectedIndex") via the native setter and announce it.
   * Focus events are dispatched without calling el.focus(), so the page does
   * not jump around while we fill.
   */
  function setNative(el, prop, value) {
    fire(el, 'focus', 'FocusEvent');
    fire(el, 'focusin', 'FocusEvent');
    const set = nativeSetter(el, prop);
    if (set) set.call(el, value);
    else el[prop] = value;
    fire(el, 'input', 'InputEvent');
    fire(el, 'change');
    fire(el, 'blur', 'FocusEvent');
    fire(el, 'focusout', 'FocusEvent');
  }

  function setText(el, value) {
    setNative(el, 'value', value);
    return el.value === value;
  }

  /**
   * Pick the option for `value` (strict: exact text/value or a known alias,
   * see matcher.matchOption). Returns { index, confidence } or null.
   */
  function bestOption(el, value, key) {
    const options = Array.from(el.options).map((o) => ({
      text: isPlaceholderOption(o) ? '' : o.textContent,
      value: isPlaceholderOption(o) ? '' : o.value,
      disabled: o.disabled,
    }));
    return matcher.matchOption(options, key, value);
  }

  /** Visible text naming a radio/checkbox: its <label>, aria-label or wrapping label. */
  function choiceLabel(el) {
    const doc = el.ownerDocument;
    const parts = [];
    if (el.labels && el.labels.length) parts.push(...Array.from(el.labels).map((l) => l.textContent));
    if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
    const by = el.getAttribute('aria-labelledby');
    if (by) by.split(/\s+/).filter(Boolean).forEach((id) => doc.getElementById(id) && parts.push(doc.getElementById(id).textContent));
    return String(parts.find((t) => String(t).trim()) || el.value || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Radio group or single checkbox.
   *   radios:   [input[type=radio]...] of one group. Picks the option whose label
   *             equals the value (or an alias). Skipped if any is already checked.
   *   checkbox: [input[type=checkbox]] with value "Yes" checks it, "No" leaves it.
   *             Never unchecks anything.
   * Selection goes through AF.widgets.press() so React/Angular see a real click.
   * Returns { status, confidence }.
   */
  function fillChoice(inputs, value, opts) {
    const o = opts || {};
    const widgets = AF.widgets;
    const list = Array.from(inputs).filter((i) => !i.disabled);
    if (!list.length) return { status: 'unsupported' };
    if (value == null || String(value) === '') return { status: 'nomatch' };

    if (list[0].type === 'checkbox' && list.length === 1) {
      const box = list[0];
      if (box.checked) return { status: 'skipped' };
      const yes = matcher.matchOption([{ text: 'Yes', value: 'Yes' }], 'hasPreferredName', value);
      if (!yes) return { status: 'skipped' }; // "No": leaving it unchecked is the answer
      if (!widgets.press(box)) return { status: 'failed' };
      return box.checked ? { status: 'filled', confidence: 1 } : { status: 'failed' };
    }

    if (!o.force && list.some((i) => i.checked)) return { status: 'skipped' };
    const pick = matcher.matchOption(list.map((i) => ({ text: choiceLabel(i), value: '' })), o.key, value);
    if (!pick) return { status: 'nomatch' };
    const target = list[pick.index];
    if (!widgets.press(target)) return { status: 'failed' };
    return target.checked ? { status: 'filled', confidence: pick.confidence } : { status: 'failed' };
  }

  /**
   * Fill one control.
   * opts = { key, force }
   * Returns { status: 'filled'|'skipped'|'nomatch'|'failed'|'unsupported', confidence }
   *   confidence is the option-match confidence for selects (1 for text).
   */
  function fill(el, value, opts) {
    const o = opts || {};
    const kind = kindOf(el);
    if (!kind) return { status: 'unsupported' };
    if (!o.force && !isEmpty(el)) return { status: 'skipped' };
    if (value == null || String(value) === '') return { status: 'nomatch' };

    if (kind === 'radio' || kind === 'checkbox') return { status: 'unsupported' }; // use fillChoice
    if (kind === 'select') {
      const pick = bestOption(el, value, o.key);
      if (!pick) return { status: 'nomatch' };
      setNative(el, 'selectedIndex', pick.index);
      return el.selectedIndex === pick.index
        ? { status: 'filled', confidence: pick.confidence }
        : { status: 'failed' };
    }

    let text = String(value);
    if (el.maxLength > 0 && text.length > el.maxLength) {
      // "(555) 123-4567" in a maxlength=10 phone box: the digits are the value. A
      // leading US country code goes too ("+1 555 123 4567" -> 5551234567).
      const digits = text.replace(/\D/g, '');
      const local = o.key === 'phone' && digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
      if ((o.key === 'phone' || o.key === 'postalCode') && local && local.length <= el.maxLength) text = local;
      // ZIP+4 in a 5-character box: the ZIP is the first five digits.
      else if (o.key === 'postalCode' && /^\d{5}-?\d{4}$/.test(text.trim()) && el.maxLength >= 5) text = text.trim().slice(0, 5);
      else return { status: 'failed' };
    }
    return setText(el, text) ? { status: 'filled', confidence: 1 } : { status: 'failed' };
  }

  AF.filler = { kindOf, isEmpty, fill, fillChoice, choiceLabel, setNative, bestOption, isComboboxInput, fire };

  if (typeof module === 'object' && module.exports) module.exports = AF.filler;
})(typeof globalThis !== 'undefined' ? globalThis : this);
