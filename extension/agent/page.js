/*
 * agent/page.js
 *
 * The in-page toolkit jobctl drives (via agent/background.js). Injected after
 * Formhand's engine, into every frame of the tab. Everything is exposed on
 * globalThis.JB and returns plain JSON.
 *
 * Elements are addressed by a ref: a number stored in the element's
 * data-jb-ref attribute, assigned the first time a snapshot or fill reports
 * it. Refs are per frame; the CLI qualifies them as "<frameId>:<ref>".
 *
 *   snapshot()   page state: visible fields, buttons, signals (captcha,
 *                confirmation, errors, sign-in form...)
 *   fill(data)   one Formhand pass with the owner's profile, Q&A bank and
 *                standard answers; reports what is still missing
 *   set / options / click / upload / authFill / text / waitQuiet
 *
 * Consent, authorization and signature boxes: ticked only when the owner's
 * policy says so (data/profile.json policy.autoConsent, set by the owner on
 * 2026-10-07: "make it auto consent, fully automated"). Otherwise they are
 * reported as `consent` so the owner ticks them in the window.
 */
(function (root) {
  'use strict';

  const doc = root.document;
  const JB = (root.JB = root.JB || {});
  const AF = () => root.AF || {};

  const REF = 'data-jb-ref';
  const MAX_TEXT = 200;

  /* ---------------------------------------------------------------- */
  /* Basics                                                             */
  /* ---------------------------------------------------------------- */

  const clean = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  const cut = (t, n) => {
    const s = clean(t);
    return s.length > (n || MAX_TEXT) ? s.slice(0, (n || MAX_TEXT) - 1) + '…' : s;
  };
  // Long labels: keep the start and the end. Disclosure-style questions put the actual question last.
  const cutLabel = (t) => {
    const s = clean(t);
    return s.length > MAX_TEXT ? s.slice(0, 80) + ' … ' + s.slice(-(MAX_TEXT - 83)) : s;
  };
  const norm = (t) => {
    const m = AF().matcher;
    return m && m.normalize ? m.normalize(t) : clean(t).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Resolve with check()'s first truthy result, re-checking on DOM mutations (at most every 25 ms) and every
   * `poll` ms (default 50); resolve null after `timeout` ms. The same pattern as the engine's
   * AF.widgets.waitFor (core/widgets.js, read-only here), with a finer tick: a dropdown is usually ready
   * within a frame or two, so a fixed sleep of 250-700 ms was nearly all waste.
   */
  function waitFor(check, timeout, poll) {
    return new Promise((resolve) => {
      let done = false;
      let obs = null;
      let tick = null;
      let cap = null;
      let queued = null;
      const finish = (v) => {
        if (done) return;
        done = true;
        if (obs) obs.disconnect();
        clearInterval(tick);
        clearTimeout(cap);
        clearTimeout(queued);
        resolve(v || null);
      };
      const test = () => {
        queued = null;
        let v = null;
        try {
          v = check();
        } catch (e) {
          v = null;
        }
        if (v) finish(v);
      };
      test();
      if (done) return;
      obs = new root.MutationObserver(() => {
        if (!queued) queued = setTimeout(test, 25);
      });
      obs.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      tick = setInterval(test, poll || 50);
      cap = setTimeout(() => {
        test();
        finish(null);
      }, timeout);
    });
  }

  /**
   * Verify something a page can take back a beat after the action (a framework reverting a click, a date picker
   * rejecting a format it only parses as it closes). One look right after the action sees the state BEFORE the
   * revert. This watches the revert window instead: true once check() has held continuously for `hold` ms
   * (so a value that sticks returns after `hold`, not `max`), false when it has not held by `max` ms.
   */
  async function holds(check, hold, max) {
    const t0 = Date.now();
    let since = null;
    for (;;) {
      let v = false;
      try {
        v = !!check();
      } catch (e) {
        v = false;
      }
      const now = Date.now();
      if (!v) since = null;
      else if (since == null) since = now;
      if (v && now - since >= hold) return true;
      if (now - t0 >= max) return false;
      await sleep(25);
    }
  }

  function refOf(el) {
    let r = el.getAttribute(REF);
    if (!r) {
      const next = Number(doc.documentElement.getAttribute('data-jb-next') || 1);
      r = String(next);
      el.setAttribute(REF, r);
      doc.documentElement.setAttribute('data-jb-next', String(next + 1));
    }
    return r;
  }

  function byRef(ref) {
    const el = doc.querySelector(`[${REF}="${String(ref).replace(/"/g, '')}"]`);
    if (!el) throw new Error(`ref ${ref} not found on this page (it changed?): take a new snapshot`);
    return el;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (!el.getClientRects().length) return false;
    const s = root.getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  function textOfIds(ids) {
    return clean(
      String(ids || '')
        .split(/\s+/)
        .map((id) => doc.getElementById(id))
        .filter(Boolean)
        .map((n) => n.textContent)
        .join(' ')
    );
  }

  /** Best human label for a control. */
  // Rendered text only (hidden "No results" / "Loading" helpers stay out).
  const shownText = (n) => (n.nodeType === 1 ? (n.innerText != null ? n.innerText : n.textContent) : n.textContent) || '';

  /** Text of a <label>, minus the branch that holds the control (Lever wraps the whole field in it). */
  function labelText(l, el) {
    if (!l.contains(el)) return shownText(l);
    return Array.from(l.childNodes).filter((n) => !(n.contains && n.contains(el)) && n !== el).map(shownText).join(' ');
  }

  const POPUP = /popper|popup|datepicker|dropdown|menu|listbox|tooltip/i;

  /** The question title of a field container: its own <label>/<legend>/"question-title" child that holds no control. */
  function questionTitle(container, el) {
    if (!container || !container.children) return '';
    for (const c of container.children) {
      if (c === el || c.contains(el)) continue;
      const titled = c.tagName === 'LABEL' || c.tagName === 'LEGEND' || /question-title|question__title|field-label|form-label/i.test(c.className || '');
      // An option's own label (label[for] of a radio / checkbox) is not the question.
      const target = c.tagName === 'LABEL' && c.htmlFor ? doc.getElementById(c.htmlFor) : null;
      if (target && target.tagName === 'INPUT' && /^(radio|checkbox)$/.test(target.type)) continue;
      if (!titled || (c.querySelector && c.querySelector('input, select, textarea, button'))) continue;
      const t = clean(shownText(c));
      if (t) return t;
    }
    return '';
  }

  // Placeholder-ish text a control shows for itself, never the question ("Select One", "Yes Required").
  const POOR_LABEL = /^(select( one)?|please select|choose( one)?|(yes|no)|required|((select one|yes|no)\s+required))\W*$/i;

  /**
   * Workday application questions: the question sits in a legend / label / richText of the enclosing
   * `formField-*` container, not on the control (QUARRYHALL 2026-10-09: labels read "Select One", "Yes Required", or the
   * first checkbox option). The first title in the container that holds no control and is not an option's label.
   */
  function workdayTitle(el) {
    const ff = el.closest('[data-automation-id^="formField-"]');
    if (!ff) return '';
    for (const c of ff.querySelectorAll('legend, label, [data-automation-id="richText"]')) {
      if (c === el || c.contains(el) || (c.querySelector && c.querySelector('input, select, textarea, button'))) continue;
      if (c.closest('[role="listbox"], [role="option"], [role="radiogroup"], [role="menu"]')) continue;
      const target = c.tagName === 'LABEL' && c.htmlFor ? doc.getElementById(c.htmlFor) : null;
      if (target && target.tagName === 'INPUT' && /^(radio|checkbox)$/.test(target.type)) continue;
      const t = clean(shownText(c)).replace(/\s*\*?\s*\brequired\b\s*\*?\s*$/i, '');
      if (t.length > 2 && !POOR_LABEL.test(t)) return t;
    }
    return '';
  }

  function labelOf(el) {
    const parts = [];
    if (el.labels && el.labels.length) parts.push(Array.from(el.labels).map((l) => labelText(l, el)).join(' '));
    if (el.getAttribute('aria-labelledby')) parts.push(textOfIds(el.getAttribute('aria-labelledby')));
    if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
    const wrap = el.closest('label');
    if (wrap) parts.push(labelText(wrap, el));
    let label = clean(parts.find((p) => clean(p)) || '');
    if (!label) {
      // The field container's question title (Ashby: label[for=<field path>] beside the control).
      for (let node = el.parentElement, i = 0; node && i < 4 && !label; node = node.parentElement, i++) label = questionTitle(node, el);
    }
    if (!label) {
      // Nearest preceding text inside the field's container (up to 3 levels), popups left out.
      let node = el;
      for (let i = 0; i < 3 && node && !label; i++) {
        node = node.parentElement;
        if (!node) break;
        const t = clean(
          Array.from(node.childNodes)
            .filter((n) => n !== el && !(n.contains && n.contains(el)) && !(n.nodeType === 1 && POPUP.test(n.className || '')))
            .map(shownText)
            .join(' ')
        );
        if (t && t.length < 300) label = t;
      }
    }
    if (!label) label = el.getAttribute('placeholder') || el.getAttribute('title') || el.name || el.id || '';
    if (POOR_LABEL.test(label) || !label) label = workdayTitle(el) || label;
    return cutLabel(label);
  }

  function groupLabel(input) {
    let g = input.closest('fieldset, [role="radiogroup"], [role="group"]');
    const all = groupInputs(input);
    const wd = workdayTitle(input);
    if (wd) return cutLabel(wd);
    while (g && all.some((i) => !g.contains(i))) g = g.parentElement && g.parentElement.closest('fieldset, [role="radiogroup"], [role="group"]');
    if (g) {
      const legend = g.querySelector('legend');
      if (legend) return cutLabel(legend.textContent);
      if (g.getAttribute('aria-labelledby')) return cutLabel(textOfIds(g.getAttribute('aria-labelledby')));
      if (g.getAttribute('aria-label')) return cutLabel(g.getAttribute('aria-label'));
      const qt = questionTitle(g, input);
      if (qt) return cutLabel(qt);
    }
    // Walk up until the container holds the whole group, then take the text that comes before it
    // (the question precedes its options: Lever's .application-label, most custom forms).
    const name = input.name;
    let c = input.parentElement;
    while (c && name && c.querySelectorAll(`input[name="${CSS.escape(name)}"]`).length < groupInputs(input).length) c = c.parentElement;
    for (let node = c, i = 0; node && node !== doc.body && i < 4; node = node.parentElement, i++) {
      let t = node.parentElement ? questionTitle(node.parentElement, input) : '';
      for (let sib = node.previousElementSibling; sib && !t; sib = sib.previousElementSibling) {
        if (sib.querySelector && sib.querySelector('input, select, textarea')) break; // another field
        t = clean(shownText(sib));
      }
      if (t) return cutLabel(t);
    }
    if (c && c.parentElement) {
      const t = clean(shownText(c.parentElement));
      if (t) return cutLabel(t.split(/\n/)[0]);
    }
    return cut(name || '');
  }

  const GROUP_BOX = 'fieldset, [role="group"], [role="radiogroup"], [class*="checkbox-group" i], [class*="radio-group" i]';

  function groupInputs(input) {
    const scope = input.form || doc;
    const byName = input.name ? Array.from(scope.querySelectorAll(`input[type="${input.type}"][name="${CSS.escape(input.name)}"]`)) : [input];
    // Workday repeats a panel's boxes under one name ("currentlyWorkHere" in every Work Experience panel): a box alone
    // in its formField-* question is its own field, not a group spanning the panels.
    const own = byName.length > 1 && input.closest('[data-automation-id^="formField-"]');
    if (own && own.querySelectorAll(`input[type="${input.type}"]`).length === 1) return [input];
    if (byName.length > 1) return byName;
    // Every box named after its own option: the group is the boxes of the nearest group container,
    // when none of them shares a name with another.
    // (The nearest match can be one option's own wrapper, "...checkbox-group-option-checkbox": go up
    // to the first container that holds more than one box.)
    for (let box = input.closest(GROUP_BOX); box; box = box.parentElement && box.parentElement.closest(GROUP_BOX)) {
      const same = Array.from(box.querySelectorAll(`input[type="${input.type}"]`));
      if (same.length < 2) continue;
      const names = new Set(same.map((i) => i.name || refOf(i)));
      return names.size === same.length ? same : byName;
    }
    // Workday: a checkbox question is a formField-* container of boxes, each named after its own option.
    const ff = input.closest('[data-automation-id^="formField-"]');
    if (ff) {
      const same = Array.from(ff.querySelectorAll(`input[type="${input.type}"]`));
      if (same.length > 1) return same;
    }
    return byName;
  }

  function choiceText(i) {
    const f = AF().filler;
    return f && f.choiceLabel ? f.choiceLabel(i) : labelOf(i);
  }

  function isRequired(el, label) {
    if (el.required) return true;
    // Oracle Recruiting Cloud: each field sits in its own .input-row whose label carries
    // input-row__label--required, or does not. That label decides before aria-required / a "*" in the text:
    // Oracle puts aria-required on optional inputs too (Address Line 2/3, Care Of, Tax District), and the
    // address block is one fieldset, so the fieldset rule below took them as required (2026-10-08, Quarrymere /
    // Florida Blue / Cedarmere).
    const row = el.closest('.input-row');
    if (row && row.querySelector('.input-row__label')) return !!row.querySelector('.input-row__label--required');
    if (el.getAttribute('aria-required') === 'true' || /[*✱]\s*$|^\s*[*✱]|\(required\)/i.test(label || '')) return true;
    if (row) return false; // a row without a label of its own (agreements, composite phone): no row verdict to add
    // Ashby: the asterisk is CSS on the question title (class "_required_xxxx").
    const entry = el.closest('[data-field-path], [class*="field-entry" i], fieldset');
    return !!(entry && entry.querySelector('label[class*="required" i], legend[class*="required" i], [class*="question-title"][class*="required" i]'));
  }

  // Questions about the employer's AI-use policy are never consent boxes: the owner answers them.
  const AI_POLICY = /\bAI\b.*\b(policy|use|assist)|artificial intelligence|generative|chatgpt|llm/i;

  function isConsent(label) {
    const qa = AF().qa;
    const t = String(label || '');
    if (AI_POLICY.test(t)) return false;
    if (/arbitrat|agreement to|please read (the|our) .*(agreement|policy|notice|terms)|acknowledg(e|ment)/i.test(t)) return true;
    if (qa && qa.isConsent && qa.isConsent(t)) return true;
    return /\b(i (agree|accept|acknowledge|certify|consent|authorize|attest|confirm|understand)|terms (of|and) (use|service)|privacy (policy|notice)|e-?signature|electronic signature|signature)\b/i.test(t);
  }

  // Owner rule (2026-10-08): never opt in to job alerts, marketing, newsletters, texts or
  // "consider me for other roles". These read like consent ("I agree to receive updates about
  // new job opportunities") but are spam: an optional one is left (or made) unticked; only a box
  // the form requires to go on is ticked.
  const OPT_IN = /\b(receive|send me|get|sign me up for)\b.{0,40}\b(updates?|alerts?|notifications?|newsletters?|marketing|promotions?|promotional|communications?|offers|news|emails? about)|\bmarketing\b|newsletter|job alerts?|talent (community|network|pool|pipeline)|\b(consider|contact|notify) me\b.{0,30}\b(other|future|similar|new)\b|future (job |career )?opportunit|new job opportunit|other (open )?(roles|positions|jobs|opportunit)|similar (roles|positions|jobs)|\bsubscribe\b|text messages?|\bsms\b/i;

  function isOptIn(label) {
    return OPT_IN.test(String(label || ''));
  }

  /**
   * Consent flag for a field: an opt-in is never consent, required or not (the policy must not tick it).
   * A required opt-in box goes to the owner (audit 2026-10-08: a required one used to be ticked).
   */
  function markConsent(item, label) {
    if (isOptIn(label)) item.optIn = true;
    if (isConsent(label) && !item.optIn) item.consent = true;
  }

  /** A typed-signature box: its name / id or its section says signature. */
  function isSignature(el) {
    const own = `${el.name || ''} ${el.id || ''} ${el.getAttribute('data-automation-id') || ''}`;
    if (/signature/i.test(own)) return true;
    const sec = el.closest('[id*="signature" i], [class*="signature" i]');
    return !!sec;
  }

  function isComboLike(el) {
    if (el.getAttribute('role') === 'combobox') return true;
    if (el.getAttribute('aria-haspopup') === 'listbox') return true;
    if (el.getAttribute('data-uxi-widget-type') === 'selectinput') return true;
    if (el.closest('.select__control')) return true;
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* Reading the page                                                   */
  /* ---------------------------------------------------------------- */

  // Fields meant for bots (docs/ATS-FLOWS.md): never listed, never filled.
  function isHoneypot(el) {
    if (el.getAttribute('data-automation-id') === 'beecatcher') return true;
    if (el.closest('[class*="honeypot" i], [id*="honeypot" i], [name*="honeypot" i]')) return true;
    return /for robots|leave (this )?(field )?(blank|empty)/i.test(el.getAttribute('aria-label') || el.getAttribute('placeholder') || '');
  }

  const CONTROL = 'input, select, textarea, [role="combobox"], button[aria-haspopup="listbox"]';
  const SKIP_INPUT = /^(hidden|submit|button|image|reset|search)$/;

  // An international phone box shows its dial code ("+1 ") before any number: that is still empty.
  const dialOnly = (el) => el.tagName === 'INPUT' && el.type === 'tel' && /^\+\d{1,4}\s*$/.test(el.value || '');

  function readValue(el) {
    const tag = el.tagName;
    if (dialOnly(el)) return '';
    if (isButtonGroup(el)) return pressedText(el);
    if (tag === 'SELECT') {
      const o = el.options[el.selectedIndex];
      const f = AF().filler;
      if (!o || (f && f.isEmpty && f.isEmpty(el))) return '';
      return clean(o.textContent);
    }
    if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      const group = groupInputs(el);
      if (el.type === 'checkbox' && group.length === 1) return el.checked ? 'checked' : '';
      return group.filter((i) => i.checked).map(choiceText).join('; ');
    }
    if (tag === 'INPUT' && el.type === 'file') return el.files && el.files.length ? Array.from(el.files).map((f) => f.name).join(', ') : '';
    if (tag === 'BUTTON') return clean(el.textContent);
    if (el.getAttribute('role') === 'combobox' && tag !== 'INPUT') {
      // iCIMS dropdowns show "— Make a Selection —" / "Please select a country" in a placeholder span:
      // that is an empty field, not an answer (YARROWMERE 2026-10-08: three required ones were never asked).
      if (el.querySelector('.dropdown-placeholder, [class*="placeholder" i]') && !el.querySelector('[class*="single-value" i]')) return '';
      const t = clean(el.textContent);
      return /^(—\s*)?(make a selection|please select( a [a-z]+)?|select( one)?\.*)(\s*—)?$/i.test(t) ? '' : t;
    }
    // react-select: the typed-in <input> is empty after a pick; the choice is shown beside it.
    if (!el.value && isComboLike(el)) {
      const box = el.closest('.select__control, [class*="-control"], [class*="select-shell" i]');
      const shown = box && box.querySelectorAll('[class*="single-value"], [class*="multi-value__label"]');
      if (shown && shown.length) return Array.from(shown).map((n) => clean(n.textContent)).join('; ');
    }
    // Workday multiselect (Country Phone Code): the search <input> stays empty, the pick is a pill beside it
    // (Glenmoor 2026-10-09 stopped as empty_required with "United States of America (+1)" selected).
    if (!el.value && el.closest && el.closest('[data-automation-id="multiSelectContainer"]')) {
      const pills = el.closest('[data-automation-id="multiSelectContainer"]').querySelectorAll('[data-automation-id="selectedItem"]');
      if (pills.length) return Array.from(pills).map((n) => clean(n.textContent)).join('; ');
    }
    return cut(el.value || '', 300);
  }

  function optionsOf(el) {
    if (isButtonGroup(el)) return pillsOf(el).map((b) => clean(b.textContent));
    if (el.tagName === 'SELECT') {
      return Array.from(el.options)
        .map((o) => clean(o.textContent))
        .filter((t) => t && !/^(select|choose|please select|--)/i.test(t))
        .slice(0, 60);
    }
    if (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox')) {
      const g = groupInputs(el);
      return g.length > 1 || el.type === 'radio' ? g.map(choiceText).slice(0, 60) : null;
    }
    return null;
  }

  function kindOf(el) {
    const tag = el.tagName;
    if (isButtonGroup(el)) return 'buttons';
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox') return groupInputs(el).length > 1 ? 'checkboxes' : 'checkbox';
      if (isComboLike(el)) return 'combobox';
      return t;
    }
    return isComboLike(el) ? 'combobox' : tag.toLowerCase();
  }

  /** Every visible control (radio/checkbox groups once), plus file inputs even when hidden. */
  function listFields() {
    const out = [];
    const seenGroups = new Set();
    for (const el of doc.querySelectorAll(CONTROL)) {
      if (el.closest(`[${REF}-ignore]`)) continue;
      if (isHoneypot(el)) continue;
      const tag = el.tagName;
      const type = (el.type || '').toLowerCase();
      if (tag === 'INPUT' && SKIP_INPUT.test(type)) continue;
      if (el.disabled) continue;
      if (el.parentElement && isButtonGroup(el.parentElement)) continue; // the button group stands for it
      const isFile = tag === 'INPUT' && type === 'file';
      const isChoice = tag === 'INPUT' && (type === 'radio' || type === 'checkbox');
      if (isChoice) {
        const g = groupInputs(el);
        const key = type + ':' + refOf(g[0]);
        if (seenGroups.has(key)) continue;
        // Custom-styled choices hide the input and show the label.
        const shown = g.some((i) => isVisible(i) || Array.from(i.labels || []).some(isVisible));
        if (!shown) continue;
        seenGroups.add(key);
        const label = type === 'radio' || g.length > 1 ? groupLabel(el) : labelOf(el);
        out.push({ el, label, kind: kindOf(el), required: g.some((i) => isRequired(i, label)) || isRequired(el, label) });
        continue;
      }
      // react-select hides its search <input> (opacity 0) once a value is picked: judge the control box.
      const box = isComboLike(el) ? el.closest('.select__control, [class*="-control"]') || el : el;
      if (!isFile && !isVisible(box)) continue;
      // A react-select's inner <input> stands for the whole control.
      const label = labelOf(el);
      out.push({ el, label, kind: isFile ? 'file' : kindOf(el), required: isRequired(el, label) });
    }
    for (const g of buttonGroups()) {
      if (g.el.closest(`[${REF}-ignore]`)) continue;
      const label = labelOf(g.el);
      out.push({ el: g.el, label, kind: 'buttons', required: isRequired(g.el, label) });
    }
    return out;
  }

  /*
   * Toggle buttons that answer one question ("pills"): Ashby yes/no (`button[aria-pressed]` side by side in one
   * box) and Oracle Recruiting Cloud (cx-select-pills: `ul[aria-label=<question>] > li > button`, aria-pressed
   * on Fernhaven's yes/no, role="radio" + aria-checked on TI's Title). The box is one field of kind 'buttons':
   * label = the question, options = the pill texts, value = the pressed one(s).
   */
  // Rippling's consent radios are <div role="radio"> inside a role="radiogroup" (no <input>): the same kind of field.
  const ARIA_RADIO = '[role="radio"]:not(input):not(button)';
  const PILL = `button[aria-pressed], button[role="radio"], ${ARIA_RADIO}`;
  const isOn = (b) => b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-checked') === 'true';
  // A child of a pill box: the button itself, or the only button of the list item that wraps it.
  function pillIn(c) {
    if (c.matches(PILL)) return c;
    if ((c.tagName === 'LI' || /^(listitem|presentation|none)$/.test(c.getAttribute('role') || '')) && c.children.length === 1 && c.firstElementChild.matches(PILL)) return c.firstElementChild;
    return null;
  }
  function pillsOf(box) {
    if (box.getAttribute('role') === 'radiogroup') {
      const r = Array.from(box.querySelectorAll(ARIA_RADIO));
      if (r.length >= 2) return r;
    }
    return Array.from(box.children).map(pillIn).filter(Boolean);
  }
  // The box whose pills include `b` (two or more of them), or null.
  function pillBox(b) {
    if (b.matches(ARIA_RADIO)) {
      const grp = b.closest('[role="radiogroup"]');
      if (grp && pillsOf(grp).length >= 2) return grp;
    }
    const p = b.parentElement;
    if (!p) return null;
    if (pillsOf(p).length >= 2) return p;
    const g = p.parentElement;
    return g && pillIn(p) === b && pillsOf(g).length >= 2 ? g : null;
  }

  /** Containers of toggle buttons that answer one question (Ashby / Oracle pills): [{ el, buttons }]. */
  function buttonGroups() {
    const out = [];
    const seen = new Set();
    for (const b of doc.querySelectorAll(PILL)) {
      const box = pillBox(b);
      if (!box || seen.has(box) || box.closest('header, nav, footer')) continue;
      seen.add(box);
      const buttons = pillsOf(box).filter(isVisible);
      if (buttons.length >= 2 && buttons.length <= 12) out.push({ el: box, buttons });
    }
    return out;
  }
  const isButtonGroup = (el) => el.tagName !== 'BUTTON' && pillsOf(el).length >= 2;
  const pressedText = (el) => pillsOf(el).filter(isOn).map((b) => clean(b.textContent)).join('; ');

  const ACTION = /^(apply|submit|next|continue|save|review|sign ?in|log ?in|create|register|sign ?up|start|proceed|back|previous|use my last|autofill|upload|i'?m interested|done|finish|confirm|verify|send)/i;

  function listButtons() {
    const out = [];
    const sel = 'button, input[type="submit"], input[type="button"], [role="button"], a[href], [role="tab"], [role="link"]';
    for (const el of doc.querySelectorAll(sel)) {
      if (!isVisible(el)) continue;
      // A disabled button is listed (flagged `disabled`) only when it is the form's own Apply / Submit: Rippling's
      // Apply stays disabled until the SMS consent radios are answered, and the driver must see it to know why it waits.
      const off = el.disabled || el.getAttribute('aria-disabled') === 'true';
      if (off && !(el.tagName === 'BUTTON' && /^(apply|submit)\b/i.test((el.innerText || '').trim()))) continue;
      if (el.getAttribute('aria-haspopup') === 'listbox') continue; // a dropdown, not an action
      if (el.tagName === 'BUTTON' && el.matches(PILL) && pillBox(el)) continue; // an answer, not an action
      // innerText of an icon link is just a space / &nbsp;: fall through to its aria-label.
      const text = cut((el.innerText || '').trim() || el.value || el.getAttribute('aria-label') || el.title || '', 80);
      if (!text) continue;
      const isLink = el.tagName === 'A';
      // Links matter only when they look like an action (Apply, Sign in, Create account...).
      // An icon link marked role="button" that deletes a row (iCIMS "Delete Professional Experience (5)") is an action too.
      const roleButton = el.getAttribute('role') === 'button' && /^(delete|remove)\b/i.test(text);
      if (isLink && !roleButton && !ACTION.test(text) && !/apply|account|sign|log ?in|register|continue|next/i.test(text)) continue;
      const item = { ref: refOf(el), text, tag: el.tagName.toLowerCase() };
      if (isLink) item.href = cut(el.href, 300);
      if (el.getAttribute('data-automation-id')) item.aid = el.getAttribute('data-automation-id');
      if (el.type === 'submit') item.submit = true;
      if (off) item.disabled = true;
      if (el.getAttribute('data-testid')) item.testid = el.getAttribute('data-testid');
      if (el.closest('header, nav, footer') && !el.closest('form')) item.chrome = true;
      out.push(item);
      if (out.length >= 120) break;
    }
    return out;
  }

  function bodyText(max) {
    const b = doc.body;
    return b ? cut(b.innerText || b.textContent || '', max || 20000) : '';
  }

  const CONFIRM = /(congratulations!? ?(your application|you'?ve applied)?|application submitted!|has successfully been submitted|was successfully submitted|you have successfully applied|thank you for (applying|your (job )?application|submitting)|thanks for applying|thank you for confirming your job application|you have confirmed your job application\.\s*(you applied on\b|$)|application (has been |was )?(successfully )?(submitted|received|sent|complete)|we('ve| have) received your application|your application (is|has been) (submitted|received|complete)|successfully (submitted|applied)|you('ve| have) (successfully )?applied)/i;
  const ALREADY = /(you('ve| have) already applied|already (submitted|applied) (an application|for this)|duplicate application)/i;
  const CLOSED = /(no longer (accepting applications|available|open)|position (has been )?(filled|closed)|job (posting )?(is )?(closed|expired|not found)|this (job|posting|position|requisition) (is )?(closed|no longer)|page (you('re| are) looking for )?(could not be|can'?t be|was not) found|^404\b)/i;
  const VERIFY = /(verify your (email|account|e-mail)|verification (code|email|link)|check your (email|inbox)|confirm your email|we('ve| have) sent (a|an) (code|email|link)|enter the (code|passcode)|one-time (code|passcode))/i;

  function captchaState() {
    const found = [];
    for (const f of doc.querySelectorAll('iframe')) {
      const src = f.src || '';
      const shown = isVisible(f);
      if (!shown) continue;
      const big = f.getBoundingClientRect().height > 150;
      if (/recaptcha\/(api2|enterprise)\/bframe/.test(src) && big) found.push('recaptcha-challenge');
      else if (/recaptcha\/(api2|enterprise)\/anchor/.test(src) && !/size=invisible/.test(src)) found.push('recaptcha-checkbox');
      else if (/hcaptcha\.com/.test(src) && /frame=challenge/.test(src) && big) found.push('hcaptcha-challenge');
      else if (/hcaptcha\.com/.test(src) && /frame=checkbox/.test(src)) found.push('hcaptcha-checkbox');
      else if (/challenges\.embervale\.com/.test(src)) found.push('turnstile');
    }
    if (/^(just a moment|attention required)/i.test(doc.title) || /verify you are (a )?human|checking your browser/i.test(bodyText(3000))) found.push('interstitial');
    return found;
  }

  function errorTexts() {
    const out = new Set();
    const sel = '[role="alert"], [aria-live="assertive"], .error, .errors, .error-message, .field-error, .invalid-feedback, [data-automation-id="errorMessage"], [data-automation-id*="error" i], [class*="error" i]:not(input):not(select):not(textarea):not(form):not(body)';
    for (const el of doc.querySelectorAll(sel)) {
      if (!isVisible(el)) continue;
      const t = cut(el.innerText || el.textContent, 240);
      if (!t || t.length < 3) continue;
      out.add(t);
      if (out.size >= 15) break;
    }
    for (const el of doc.querySelectorAll('[aria-invalid="true"]')) {
      if (!isVisible(el)) continue;
      out.add('invalid: ' + labelOf(el));
      if (out.size >= 25) break;
    }
    return Array.from(out);
  }

  function signals() {
    const text = bodyText(30000);
    const pw = Array.from(doc.querySelectorAll('input[type="password"]')).filter(isVisible);
    // Oracle drops a submitted application on my-profile with a toast that fades in seconds (Fernhaven 2026-10-09: the
    // driver looked after it was gone). An "Applied on <today>" row under ACTIVE JOB APPLICATIONS says the same.
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const appliedToday = /\/my-profile\b/i.test(root.location.pathname || '') && /active job applications/i.test(text) && text.includes(`Applied on ${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`);
    return {
      confirmation: CONFIRM.test(text) || appliedToday,
      alreadyApplied: ALREADY.test(text),
      closed: CLOSED.test(text) || /^(404|page not found)/i.test(doc.title),
      verifyEmail: VERIFY.test(text),
      captcha: captchaState(),
      passwordFields: pw.length,
      securityCode: !!Array.from(doc.querySelectorAll('#security-input-0, input[autocomplete="one-time-code"], input[id*="security-input" i]')).find(isVisible),
      workdayPage: (doc.querySelector('[data-automation-id^="applyFlow"][data-automation-id$="Page"]') || { getAttribute: () => null }).getAttribute('data-automation-id'),
      uploading: !!Array.from(doc.querySelectorAll('[class*="upload-working" i], [class*="uploading" i], [data-automation-id="file-upload-in-progress"]')).find(isVisible),
      errors: errorTexts(),
      embeddedForms: (AF().autofill && AF().autofill.embeddedForms ? AF().autofill.embeddedForms(doc) : []),
      // Background tabs throttle timers and pause rendering: lets the driver log whether a stalled step ran in a hidden tab.
      visibility: doc.visibilityState,
      focus: typeof doc.hasFocus === 'function' ? doc.hasFocus() : null,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                         */
  /* ---------------------------------------------------------------- */

  // "Please specify" / "If yes, explain" alone means nothing: name it after the question it follows.
  const FOLLOW_UP = /^(please )?(specify|explain|describe|list)\b|^if (yes|other|so|applicable)\b|^other\b.{0,20}$/i;
  function withParents(items) {
    let prev = null;
    for (const it of items) {
      const base = String(it.label || '').replace(/[*✱:\s]+$/, '');
      if (prev && base.length < 60 && FOLLOW_UP.test(base) && !FOLLOW_UP.test(prev)) it.label = cutLabel(`${prev} / ${it.label}`);
      else prev = String(it.label || '').replace(/[*✱:\s]+$/, '');
    }
    return items;
  }

  JB.snapshot = function snapshot(opts) {
    const o = opts || {};
    const fields = withParents(listFields()).map((f) => {
      const item = { ref: refOf(f.el), label: f.label, kind: f.kind, required: f.required, value: readValue(f.el) };
      if (f.kind === 'file') item.for = fileKind(f.el);
      const opt = optionsOf(f.el);
      if (opt) item.options = opt;
      if (f.kind === 'checkbox') markConsent(item, f.label);
      return item;
    });
    const out = {
      url: root.location.href,
      title: doc.title,
      heading: cut((Array.from(doc.querySelectorAll('h1, h2')).find(isVisible) || {}).textContent || '', 150),
      top: root.top === root,
      adapter: AF().autofill ? AF().autofill.pickAdapter(doc).name : null,
      fields,
      buttons: listButtons(),
      signals: signals(),
    };
    if (o.text) out.text = bodyText(o.textMax || 15000);
    return out;
  };

  /* ---------------------------------------------------------------- */
  /* Repeating sections: work history, education, certifications        */
  /* ---------------------------------------------------------------- */

  /*
   * JB.repeaters(): the page's repeating history sections, for lib/history.js nextRepeaterAction (every application
   * lists the owner's jobs, school and certifications, even in an optional empty section; the owner 2026-10-09).
   *   { ats, sections: [{ kind: 'work'|'edu'|'cert', title, ats, add, entries: [{ title, subtitle, invalid, del, edit,
   *     fields }], open: { fields, save, cancel } | null }] }
   * Workday: My Experience groups ("Work Experience" h4 > panels "Work Experience 1" h5 with a Delete, "Add" /
   * "Add Another" = data-automation-id add-button); a field's key is its formField-<name>; a date is one field
   * (kind 'date', value "M/YYYY"). Oracle: .apply-flow-block--tile-profile-items blocks of saved tiles (title,
   * subtitle, "Fields to fix", Edit / Delete icons) plus the inline form Add / Edit opens (SAVE / CANCEL). Anything
   * else: a heading that names the section, the fields up to the next heading of its level, entries split where the
   * first field's label comes round again.
   */
  const REP_KINDS = [
    ['work', /^(work|professional|employment|job)\b.*\b(experience|history)\b|^(work )?experience\b|^employment\b|^work history\b/i],
    ['edu', /^education\b/i],
    ['cert', /^(licen[cs]es?|certifications?|certificates?)\b/i],
  ];
  function repKind(t) {
    const s = clean(t).replace(/[*✱]/g, '').replace(/\s*\(\d+\)\s*$/, '').replace(/\brequired\b.*$/i, '').trim();
    for (const [k, re] of REP_KINDS) if (re.test(s) && s.length < 60) return k;
    return null;
  }

  // One field as the snapshot reports it, plus the Workday formField key; a Workday date (Month / Year spinbuttons)
  // is one field, its value the sections joined ("6/2026").
  function repFields(box, all, dates) {
    const out = [];
    for (const f of all) {
      if (!box.contains(f.el)) continue;
      const wrap = f.el.closest('[data-automation-id="dateInputWrapper"]');
      if (wrap) {
        if (dates.has(wrap)) continue;
        dates.add(wrap);
      }
      const ff = f.el.closest('[data-automation-id^="formField-"]');
      const item = { ref: refOf(f.el), label: wrap ? workdayTitle(f.el) || f.label : f.label, kind: wrap ? 'date' : f.kind, required: f.required, value: readValue(f.el) };
      if (wrap) {
        const sec = (n) => wrap.querySelector(`[data-automation-id="dateSection${n}-input"]`);
        item.value = [sec('Month'), sec('Day'), sec('Year')].filter(Boolean).map((i) => i.value).filter(Boolean).join('/');
      }
      if (ff) item.key = ff.getAttribute('data-automation-id').slice('formField-'.length);
      const opt = wrap ? null : optionsOf(f.el);
      if (opt) item.options = opt.slice(0, 40);
      out.push(item);
    }
    // Dates the snapshot left out (DUNVALE My Experience 2026-10-09: no From / To at all, so the two EXU jobs could not
    // be told apart and their start dates were never set): every date wrapper in the box, read straight off the page.
    for (const wrap of box.querySelectorAll('[data-automation-id="dateInputWrapper"]')) {
      if (dates.has(wrap) || !isVisible(wrap)) continue;
      dates.add(wrap);
      const sec = (n) => wrap.querySelector(`[data-automation-id="dateSection${n}-input"]`);
      const first = sec('Month') || sec('Day') || sec('Year');
      if (!first) continue;
      const ff = wrap.closest('[data-automation-id^="formField-"]');
      const legend = ff && ff.querySelector('legend');
      const item = {
        ref: refOf(first),
        label: (legend && clean(legend.textContent).replace(/[*✱]/g, '').trim()) || workdayTitle(first) || 'Date',
        kind: 'date',
        required: !!(ff && ff.querySelector('abbr, [class*="required" i]')),
        value: [sec('Month'), sec('Day'), sec('Year')].filter(Boolean).map((i) => i.value).filter(Boolean).join('/'),
      };
      if (ff) item.key = ff.getAttribute('data-automation-id').slice('formField-'.length);
      out.push(item);
    }
    return out;
  }

  const btnText = (b) => clean(b.innerText || b.textContent || b.getAttribute('aria-label') || b.title || '');
  const usable = (b) => b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';

  function workdayRepeaters(page, all) {
    const out = [];
    const dates = new Set();
    for (const g of page.querySelectorAll('[role="group"][aria-labelledby]')) {
      const h = doc.getElementById(g.getAttribute('aria-labelledby'));
      if (!h || /\d+\s*$/.test(clean(h.textContent))) continue; // a numbered panel, not a section
      const kind = repKind(h.textContent);
      if (!kind || out.some((x) => x.el.contains(g))) continue;
      const panels = Array.from(g.querySelectorAll('[role="group"][aria-labelledby]')).filter((p) => {
        const ph = doc.getElementById(p.getAttribute('aria-labelledby'));
        return ph && /^h[1-6]$/i.test(ph.tagName) && /\d+\s*$/.test(clean(ph.textContent));
      });
      const entries = panels.map((p) => {
        const ph = doc.getElementById(p.getAttribute('aria-labelledby'));
        const del = Array.from(p.querySelectorAll('button')).find((b) => /^delete$/i.test(btnText(b)));
        return { title: clean(ph.textContent), subtitle: '', invalid: false, del: del ? refOf(del) : null, edit: null, fields: repFields(p, all, dates) };
      });
      const add = Array.from(g.querySelectorAll('[data-automation-id="add-button"], button')).find((b) => !panels.some((p) => p.contains(b)) && (b.getAttribute('data-automation-id') === 'add-button' || /^add( another)?$/i.test(btnText(b))));
      out.push({ el: g, kind, title: clean(h.textContent), ats: 'workday', add: usable(add) ? refOf(add) : null, entries, open: null });
    }
    return out;
  }

  function oracleRepeaters(all) {
    const out = [];
    for (const blk of doc.querySelectorAll('.apply-flow-block--tile-profile-items')) {
      const t = blk.querySelector('.apply-flow-block__title');
      const kind = t && repKind(t.textContent);
      if (!kind) continue;
      const tiles = Array.from(blk.querySelectorAll('article[class*="profile-item-tile"]'));
      const part = (tile, c) => clean((tile.querySelector(`[class*="profile-item-tile__summary-${c}"]`) || {}).textContent || '');
      const entries = tiles.map((tile) => {
        const edit = tile.querySelector('[class*="profile-item-tile__edit-item-icon"]');
        const del = tile.querySelector('[class*="profile-item-tile__delete-icon"]');
        return {
          title: part(tile, 'title'),
          subtitle: part(tile, 'subtitle'),
          invalid: /--invalid\b/.test(tile.className) || !!tile.querySelector('[data-profile-item-invalid="true"]'),
          del: del ? refOf(del) : null,
          edit: edit ? refOf(edit) : null,
          fields: [],
        };
      });
      // The inline form Add / Edit opens: every control in the block (saved tiles hold none).
      const fields = repFields(blk, all, new Set());
      const btns = Array.from(blk.querySelectorAll('button')).filter(isVisible);
      const save = btns.find((b) => /^save$/i.test(btnText(b)));
      const cancel = btns.find((b) => /^cancel$/i.test(btnText(b)));
      const add = blk.querySelector('[class*="profile-item-tile__new-tile"]');
      out.push({
        kind,
        title: clean(t.textContent),
        ats: 'oracle',
        add: usable(add) && isVisible(add) ? refOf(add) : null,
        entries,
        open: fields.length ? { fields, save: save ? refOf(save) : null, cancel: cancel ? refOf(cancel) : null } : null,
      });
    }
    return out;
  }

  const HEAD = 'h1, h2, h3, h4, h5, h6, legend, [role="heading"]';
  const levelOf = (h) => (/^H[1-6]$/.test(h.tagName) ? Number(h.tagName[1]) : Number(h.getAttribute('aria-level')) || 7);
  const after = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  function genericRepeaters(all) {
    const out = [];
    const heads = Array.from(doc.querySelectorAll(HEAD)).filter(isVisible);
    const buttons = Array.from(doc.querySelectorAll('button, [role="button"], a[href], input[type="button"]')).filter(isVisible);
    heads.forEach((h, i) => {
      const kind = repKind(h.textContent);
      if (!kind) return;
      // A legend owns its fieldset; a heading owns what follows it up to the next heading of its level or above.
      const box = h.tagName === 'LEGEND' ? h.parentElement : null;
      const end = box ? null : heads.slice(i + 1).find((x) => levelOf(x) <= levelOf(h) && !h.contains(x));
      const inside = (el) => (box ? box.contains(el) : after(h, el) && (!end || after(el, end)));
      const fields = all.filter((f) => inside(f.el) && f.kind !== 'file');
      const mine = buttons.filter(inside);
      const add = mine.find((b) => /^\+?\s*add\b/i.test(btnText(b)) && !/\b(file|attach|resume|cover|link|website|url)\b/i.test(btnText(b)));
      if (!fields.length && !add) return;
      const dels = mine.filter((b) => /^(remove|delete)\b/i.test(btnText(b)) && !/\b(file|attach|resume|cover)\b/i.test(btnText(b)));
      // Entries: a new one starts where the first field's label comes round again.
      const items = repFields(box || doc.body, fields, new Set());
      const entries = [];
      for (const f of items) {
        if (!entries.length || f.label === items[0].label) entries.push({ title: '', subtitle: '', invalid: false, del: null, edit: null, fields: [] });
        entries[entries.length - 1].fields.push(f);
      }
      // Remove buttons pair with the last entries (a first entry often has none).
      dels.forEach((b, k) => {
        const e = entries[entries.length - dels.length + k];
        if (e) e.del = refOf(b);
      });
      const prev = out[out.length - 1];
      // "Employment 1", "Employment 2" headings are one section.
      if (prev && prev.kind === kind && prev.mergeable) {
        prev.entries.push(...entries);
        prev.add = add ? refOf(add) : prev.add;
        return;
      }
      out.push({ kind, title: clean(h.textContent), ats: 'generic', add: add ? refOf(add) : null, entries, open: null, mergeable: /\d+\s*$/.test(clean(h.textContent)) });
    });
    return out.map(({ mergeable, ...x }) => x);
  }

  JB.repeaters = function repeaters() {
    const all = listFields();
    const wd = doc.querySelector('[data-automation-id="applyFlowMyExpPage"]');
    let ats = 'generic';
    let sections;
    if (wd) {
      ats = 'workday';
      sections = workdayRepeaters(wd, all).map(({ el, ...x }) => x);
    } else if (doc.querySelector('.apply-flow-block--tile-profile-items')) {
      ats = 'oracle';
      sections = oracleRepeaters(all);
    } else sections = genericRepeaters(all);
    return { ats, sections };
  };

  JB.text = (o) => bodyText((o && o.max) || 40000);

  /** The page as HTML (scripts and our ref markers kept), for offline regression fixtures. */
  JB.capture = function capture() {
    return '<!doctype html>\n' + doc.documentElement.outerHTML;
  };

  /** Debugging live sites: the markup around a ref (`up` levels above it), trimmed. */
  JB.html = function html(o) {
    let el = byRef(o.ref);
    for (let i = 0; i < (o.up || 0) && el.parentElement; i++) el = el.parentElement;
    return cut(el.outerHTML.replace(/\s+/g, ' '), o.max || 4000);
  };

  /** Resolve after the DOM has been quiet for `quiet` ms (or `max` ms passed). */
  JB.waitQuiet = function waitQuiet(o) {
    const quiet = (o && o.quiet) || 700;
    const max = (o && o.max) || 8000;
    return new Promise((resolve) => {
      let timer = null;
      const start = Date.now();
      const done = () => {
        mo.disconnect();
        clearTimeout(timer);
        clearTimeout(cap);
        resolve(Date.now() - start);
      };
      const mo = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(done, quiet);
      });
      mo.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(done, quiet);
      const cap = setTimeout(done, max);
    });
  };

  /**
   * One Formhand pass. data = { profile, qaEntries, standardAnswers }.
   * Returns what was filled and what is still missing (`needs`).
   */
  JB.fill = async function fill(data) {
    const A = AF();
    if (!A.autofill) throw new Error('Formhand engine not loaded in this frame');
    const d = data || {};
    const out = await A.autofill.run({
      doc,
      profile: d.profile || {},
      profileName: 'jobbot',
      qaEntries: d.qaEntries || [],
      standardAnswers: d.standardAnswers || {},
      quiet: true,
    });
    // Formhand reports radio / checkbox groups one box at a time (generic adapter): keep one
    // entry per group, labelled with the group's question.
    const seen = new Set();
    const results = out.results.filter((r) => {
      const el = r.el;
      if (!(el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox'))) return true;
      const g = groupInputs(el);
      if (g.length === 1) return true;
      const key = el.type + ':' + refOf(g[0]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const fields = results.map((r) => {
      const el = r.el;
      const grouped = el.tagName === 'INPUT' && (el.type === 'radio' || (el.type === 'checkbox' && groupInputs(el).length > 1));
      const mine = grouped ? groupLabel(el) : labelOf(el);
      const theirs = clean(r.desc.label);
      // Formhand's label of a field wrapped in its <label> drags in hidden helper text ("No location found...").
      const label = grouped || !theirs || (mine && theirs.startsWith(clean(mine).replace(/….*/, '')) && theirs.length > mine.length + 15) ? mine : cutLabel(theirs);
      const item = {
        ref: refOf(el),
        label,
        kind: r.desc.inputType,
        required: !!r.desc.required,
        status: r.status,
        state: r.state || null,
        source: r.match ? r.match.source : null,
      };
      if (grouped) item.kind = el.type === 'radio' ? 'radio' : 'checkboxes';
      // Required by the page's own marker (✱ / * on the group's question, aria-required) while
      // Formhand judged the control on its own: an empty one is still the owner's to answer.
      if (!item.required && (grouped ? groupInputs(el).some((i) => isRequired(i, label)) || isRequired(el, label) : isRequired(el, label))) item.required = true;
      if (item.required && !item.state && r.status !== 'filled' && !readValue(el)) item.state = 'unknown';
      // Formhand judges a group by its first box: an unticked first box reads "unknown" even when
      // another option is already ticked (an earlier answer). The group has its answer; don't ask again.
      // Checkbox groups only: a radio the PAGE pre-selected ("No" to sponsorship) is not the owner's answer.
      if (grouped && el.type === 'checkbox' && item.state === 'unknown' && readValue(el)) {
        item.state = 'filled';
        item.status = 'filled';
      }
      if (dialOnly(el)) {
        // Formhand "filled" it, the widget kept only the dial code.
        item.state = 'unknown';
        item.dialCode = el.value.trim();
      }
      if (isSignature(el)) item.signature = true;
      if (el.placeholder) item.placeholder = cut(el.placeholder, 60);
      if (r.desc.context) item.section = cut(r.desc.context, 80);
      if (el.tagName === 'SELECT' || el.type === 'radio' || el.type === 'checkbox') {
        const opt = optionsOf(el);
        if (opt) item.options = opt;
      }
      markConsent(item, label);
      return item;
    });
    withParents(fields);
    // Required fields Formhand did not list at all (unusual widgets): add them from the plain scan.
    const listed = new Set(fields.map((f) => f.ref));
    // Custom dropdowns that are not an <input> / <select> (Rippling's EEO <div role="combobox"> boxes, question in a
    // sibling <p>): the engine never sees them. Answer the owner's standard questions (gender, race, Hispanic,
    // veteran, disability...) here, through the same option matcher the engine uses.
    const STD = A.standard;
    for (const f of STD ? listFields() : []) {
      const ref = refOf(f.el);
      if (listed.has(ref) || f.kind !== 'combobox' || f.el.tagName === 'INPUT' || f.el.tagName === 'SELECT' || readValue(f.el)) continue;
      const det = STD.detect({ label: f.label, inputType: 'select', context: '' });
      const answer = det && (d.standardAnswers || {})[det.id];
      if (!answer) continue;
      let ok = false;
      let picked = '';
      try {
        const texts = await JB.options({ ref });
        const m = STD.matchOption(texts.map((t) => ({ text: t })), det.id, answer);
        if (m) {
          const r = await JB.set({ ref, value: texts[m.index] });
          ok = !!r.ok;
          picked = texts[m.index];
        }
      } catch (e) {
        ok = false;
      }
      listed.add(ref);
      fields.push({ ref, label: f.label, kind: 'combobox', required: f.required, status: ok ? 'filled' : 'skipped', state: ok ? 'filled' : f.required ? 'unknown' : 'skipped', source: ok ? 'standard:' + det.id : null, ...(ok ? { value: picked } : {}) });
    }
    for (const f of listFields()) {
      const ref = refOf(f.el);
      if (listed.has(ref) || !f.required || f.kind === 'file') continue;
      if (readValue(f.el)) continue;
      const item = { ref, label: f.label, kind: f.kind, required: true, status: 'unlisted', state: 'unknown' };
      if (isSignature(f.el)) item.signature = true;
      if (f.el.placeholder) item.placeholder = cut(f.el.placeholder, 60);
      const opt = optionsOf(f.el);
      if (opt) item.options = opt;
      markConsent(item, f.label);
      fields.push(item);
    }
    // Owner policy: tick consent / acknowledgment / authorization boxes.
    if (d.policy && d.policy.autoConsent) {
      for (const f of fields) {
        if (!f.consent || f.status === 'filled') continue;
        const el = byRef(f.ref);
        if (el.type === 'checkbox' && !el.checked) {
          press(el);
          // A framework that refuses the click reverts it a beat later (not always within a tick): the box
          // must stay ticked through a short window, not just read ticked right after the press.
          if (await holds(() => el.checked, 250, 500)) {
            f.status = 'filled';
            f.state = 'filled';
            f.source = 'policy:autoConsent';
          }
        }
      }
    }
    // Owner rule: optional job-alert / marketing / "other roles" boxes end unticked, even when
    // the page (or an earlier pass) ticked them.
    for (const f of fields) {
      if (!f.optIn || f.required) continue;
      const el = byRef(f.ref);
      if (el && el.type === 'checkbox' && el.checked) {
        press(el);
        if (await holds(() => !el.checked, 250, 500)) {
          f.status = 'filled';
          f.state = 'filled';
          f.source = 'owner:no-opt-in';
        }
      }
    }
    // Close anything the pass left open (a date picker's calendar, a dropdown menu).
    const W = AF().widgets;
    if (W && W.pressOutside) W.pressOutside(doc);
    const files = listFields()
      .filter((f) => f.kind === 'file')
      .map((f) => ({ ref: refOf(f.el), label: f.label, required: f.required, value: readValue(f.el), for: fileKind(f.el) }));
    return {
      adapter: out.adapter,
      step: out.step || null,
      company: out.company ? out.company.name : null,
      counts: out.counts,
      fallback: out.fallback || null,
      fields,
      files,
      // 'review' = Formhand filled it with low confidence (near-tie, keyword match in a free-text box,
      // or the value did not visibly stick). Reported once with the value so it is checked, never assumed.
      needs: fields
        .filter((f) => f.state === 'unknown' || f.state === 'review')
        .map((f) => (f.state === 'review' ? { ...f, review: true, value: readValue(byRef(f.ref)) } : f)),
    };
  };

  /* ------------------------------ input ------------------------------ */

  /** Full mouse press with no allow-list (the agent may press anything except consent boxes). */
  function press(el) {
    const view = el.ownerDocument.defaultView;
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (e) {
      /* ignore */
    }
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const P = view.PointerEvent || view.MouseEvent;
    const M = view.MouseEvent;
    el.dispatchEvent(new P('pointerdown', { ...base, buttons: 1, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new M('mousedown', { ...base, buttons: 1 }));
    try {
      el.focus({ preventScroll: true });
    } catch (e) {
      /* ignore */
    }
    el.dispatchEvent(new P('pointerup', { ...base, buttons: 0, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new M('mouseup', { ...base, buttons: 0 }));
    if (el.isConnected) el.dispatchEvent(new M('click', { ...base, buttons: 0 }));
  }

  function fire(el, type) {
    el.dispatchEvent(new el.ownerDocument.defaultView.Event(type, { bubbles: true, composed: true }));
  }

  function setNative(el, value) {
    const f = AF().filler;
    if (f && f.setNative) return f.setNative(el, 'value', value);
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    fire(el, 'input');
    fire(el, 'change');
  }

  /** Index of the option text that best matches `value` (exact > prefix > contains > word overlap). */
  // The same answer worded differently across forms: "No" = "I am not" / "I do not" / "None";
  // "Prefer not to say" = "Decline to self-identify" / "I don't wish to answer".
  const DECLINE = /\b(decline\w*|prefer not|don ?t wish|do not wish|choose not|rather not|not (to )?(answer|disclose|say|specify)|wish not|opt ?out)\b/;
  const NEGATED = /\b(not|no|don ?t|do not|never|none|neither)\b/;
  function meaning(t) {
    if (DECLINE.test(t)) return 'decline';
    if (/^(yes|y|true)\b/.test(t) || (/^i (am|do|will|have|can|would)\b/.test(t) && !NEGATED.test(t))) return 'yes';
    if (/^(no|n|false|none)\b/.test(t) || /^i (am|do|will|have|can|would) not\b|^i (don ?t|won ?t|can ?t|haven ?t)\b|^never\b/.test(t)) return 'no';
    return null;
  }

  // Honesty guard (Cedarhall 2026-10-09: "No" picked "Yes – North Korea"): an option naming a sanctioned or
  // foreign country is only ever picked when the value itself names that country.
  const COUNTRY_RISK = /\b(north korea|dprk|iran|syria|cuba|crimea|russia|belarus|venezuela|sudan|myanmar|donetsk|luhansk)\b/;
  function riskyPick(text, value) {
    const m = COUNTRY_RISK.exec(norm(text));
    return !!m && !norm(value).includes(m[1]);
  }
  function bestIndex(texts, value) {
    const k = bestIndexRaw(texts, value);
    if (k < 0 || riskyPick(texts[k], value)) return -1;
    // A yes / no answer never takes the option that means the opposite.
    const want = meaning(norm(value));
    const got = meaning(norm(texts[k]));
    return (want === 'yes' && got === 'no') || (want === 'no' && got === 'yes') ? -1 : k;
  }
  function bestIndexRaw(texts, value) {
    const i = bestIndexText(texts, value);
    if (i >= 0) return i;
    // Same meaning, other words: only when exactly one option means it.
    const want = meaning(norm(value));
    if (!want) return -1;
    const hits = texts.map((t, k) => (meaning(norm(t)) === want ? k : -1)).filter((k) => k >= 0);
    return hits.length === 1 ? hits[0] : -1;
  }

  function bestIndexText(texts, value) {
    const v = norm(value);
    if (!v) return -1;
    const ns = texts.map(norm);
    let i = ns.indexOf(v);
    if (i >= 0) return i;
    // Whole words only: "no" is not the start of "north".
    const w = (x) => ` ${x} `;
    i = ns.findIndex((t) => t && (w(t).startsWith(w(v)) || w(v).startsWith(w(t))) && Math.min(t.length, v.length) >= 2);
    if (i >= 0) return i;
    i = ns.findIndex((t) => t && (w(t).includes(w(v)) || (t.length > 3 && w(v).includes(w(t)))));
    if (i >= 0) return i;
    const vw = new Set(v.split(' '));
    let best = -1;
    let score = 0;
    ns.forEach((t, k) => {
      const w = t.split(' ').filter(Boolean);
      if (!w.length) return;
      const s = w.filter((x) => vw.has(x)).length / Math.max(w.length, vw.size);
      if (s > score) {
        score = s;
        best = k;
      }
    });
    return score >= 0.5 ? best : -1;
  }

  /**
   * The options of THIS dropdown's menu: react-select and ARIA comboboxes name their listbox in
   * aria-controls / aria-owns; else the menu rendered inside the widget's shell. A menu another field
   * left open must not leak its options (Northfield: GPA ranges listed under "graduation date").
   */
  function menuOptions(el) {
    const input = el.tagName === 'INPUT' ? el : el.querySelector('input');
    const live = (list) => {
      const v = Array.from(list).filter(isVisible);
      return v.length ? v : null; // empty = not found: fall back to the page-wide scan
    };
    const ids = [input, el].filter(Boolean).map((n) => n.getAttribute('aria-controls') || n.getAttribute('aria-owns')).filter(Boolean);
    for (const id of ids) {
      const lb = doc.getElementById(id);
      const got = lb && live(lb.querySelectorAll('[role="option"]'));
      if (got) return got;
    }
    // A menu rendered next to the control, inside this field's own wrapper only: stop before a wrapper
    // that also holds another field (its open menu is not ours).
    const control = el.closest('[class*="__control"], [class*="-control"]:not(.form-control)') || el;
    for (let shell = control.parentElement, i = 0; shell && i < 3; shell = shell.parentElement, i++) {
      const others = Array.from(shell.querySelectorAll('input, select, textarea, [role="combobox"]')).filter((n) => n !== el && n !== input && !el.contains(n) && !(input && input.contains(n)));
      if (others.length) break;
      const opt = shell.querySelector('[role="option"]');
      const menu = opt && (opt.closest('[role="listbox"], [class*="menu" i]') || opt.parentElement);
      const got = menu && live(menu.querySelectorAll('[role="option"]'));
      if (got) return got;
    }
    return null;
  }

  function closeMenu(el) {
    const input = el.tagName === 'INPUT' ? el : el.querySelector('input');
    if (input) input.dispatchEvent(new root.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }

  function isMultiCombo(el) {
    const box = el.closest('[class*="value-container"], .select__control, [class*="-control"]');
    return !!(box && (/--is-multi|multi/i.test(box.className || '') || box.querySelector('[class*="--is-multi"]') || el.getAttribute('aria-multiselectable') === 'true'));
  }

  /** The search box of a combobox's popup when it is not inside the combobox (iCIMS `#<id>_ctnr`). */
  function popupSearch(el) {
    const ids = [el.id && el.id + '_ctnr', el.getAttribute('aria-controls'), el.getAttribute('aria-owns')].filter(Boolean);
    for (const id of ids) {
      const box = doc.getElementById(id);
      const box2 = box && (box.matches('input') ? box : box.querySelector('input[type="text"], input[type="search"], input:not([type])'));
      if (box2 && isVisible(box2)) return box2;
    }
    return null;
  }

  /**
   * The wrapper of one dropdown (control + its menu): up to three levels above the control, stopping before
   * a wrapper that also holds another field (its menu / spinner is not ours).
   */
  function comboShell(el) {
    const input = el.tagName === 'INPUT' ? el : el.querySelector('input');
    const control = el.closest('[class*="__control"], [class*="-control"]:not(.form-control)') || el;
    let shell = control;
    for (let n = control.parentElement, i = 0; n && i < 3; n = n.parentElement, i++) {
      const others = Array.from(n.querySelectorAll('input, select, textarea, [role="combobox"]')).filter((x) => x !== el && x !== input && !el.contains(x) && !(input && input.contains(x)));
      if (others.length) break;
      shell = n;
    }
    return shell;
  }

  // What a loader looks like across ATS widgets: react-select's "loading-indicator", MUI's "-loading", Workday's
  // data-automation-id="loadingSpinner", skeleton rows, role=progressbar, aria-busy, a "Loading..." line.
  // The class / id test wants "load" at the start of a word ("upload", "download" are not loaders) and not "loaded".
  const LOADER_SEL = '[aria-busy="true"], [role="progressbar"], [data-automation-id*="load" i], [class*="load" i], [class*="spinner" i], [class*="skeleton" i]';
  const LOADER_WORD = /(?:^|[\s_-])(?:load(?!ed\b)\w*|spinner|skeleton)(?:$|[\s_-])/i;
  const LOADING_TEXT = /^(?:loading|searching)(?: (?:options|results|suggestions|matches))?\s*(?:\.{1,3}|…)?$/i;
  const NOTICE_SEL = '[class*="menu-notice" i], [class*="no-options" i], [class*="noOptions"], [class*="no-results" i], [class*="noResults"]';
  const NOTICE_TEXT = /^(?:no (?:options|results|matches|suggestions|items|data)(?: (?:found|available))?|nothing found)\s*\.?$/i;

  const isLoaderEl = (n) =>
    n.matches('[aria-busy="true"], [role="progressbar"]') || LOADER_WORD.test((n.getAttribute('class') || '') + ' ' + (n.getAttribute('data-automation-id') || ''));

  /**
   * What this dropdown shows besides options: { loading, notice }.
   *   loading  a spinner / skeleton / progressbar / aria-busy / "Loading..." line is up in the dropdown's shell, its
   *            listbox (aria-controls / aria-owns) or its iCIMS popup: the list is not final yet
   *   notice   the text of a "No options" / "No results found" line ('' when none shows)
   */
  function menuState(el) {
    const input = el.tagName === 'INPUT' ? el : el.querySelector('input');
    const roots = [comboShell(el)];
    const ids = [input, el].filter(Boolean).map((n) => n.getAttribute('aria-controls') || n.getAttribute('aria-owns')).filter(Boolean);
    if (el.id) ids.push(el.id + '_ctnr');
    for (const id of ids) {
      const box = doc.getElementById(id);
      if (box && !roots.includes(box)) roots.push(box);
    }
    let loading = false;
    let notice = '';
    for (const r of roots) {
      if (!loading && (r.getAttribute('aria-busy') === 'true' || Array.from(r.querySelectorAll(LOADER_SEL)).some((n) => isLoaderEl(n) && isVisible(n)))) loading = true;
      if (!notice) {
        const n = Array.from(r.querySelectorAll(NOTICE_SEL)).find(isVisible);
        if (n) notice = clean(n.textContent);
      }
      if (loading && notice) break;
      // Text-only notices and loaders (hashed class names): a leaf element whose whole text says so.
      if (!loading || !notice) {
        const leaves = r.querySelectorAll('*');
        for (let k = 0; k < leaves.length && k < 600 && !(loading && notice); k++) {
          const n = leaves[k];
          if (n.children.length || n.getAttribute('role') === 'option') continue;
          const t = clean(n.textContent);
          if (!t || t.length > 40) continue;
          if (!loading && LOADING_TEXT.test(t) && isVisible(n)) loading = true;
          else if (!notice && NOTICE_TEXT.test(t) && isVisible(n)) notice = t;
        }
      }
    }
    return { loading, notice };
  }

  /**
   * Wait for a dropdown's option list to be usable, condition-driven (no fixed sleeps). Resolves { opts, i, why }.
   *   match    an option matches `want` and the list has held still for `still` ms (700 ms while a loader shows)
   *   listed   `want` is null (just reading the choices) and the list has held still
   *   nomatch  options are shown, none matches, and the list held still for `idle` ms (never while loading; with a
   *            typed query not before `noMatchAfter` ms, a remote search can answer that late)
   *   closed   nothing opened within `open` ms (`openLoading` while a loader shows). A "No options" notice ends it
   *            sooner only when it has stood for `notice` ms AND `noticeAfter` ms have passed since typing: many
   *            widgets show "No options" for the whole search debounce, before the results arrive.
   *   cap      `cap` ms passed and the list is still changing / loading (async lists keep their longer budget)
   * Budgets are for LIVE sites, whose remote lists are slower than saved pages: after typing, a first list gets 4 s
   * (it still returns as soon as a stable matching list shows). A typed query (`query`) makes the list suspect
   * until it has been 450 ms since typing or every option contains the query: an async list first shows its
   * default options and filters a debounce later.
   * o.read(elapsedMs) returns the option elements to judge.
   */
  async function awaitMenu(el, want, o) {
    const t0 = Date.now();
    const q = o.query == null ? '' : norm(o.query);
    const lim = { open: q ? 4000 : 2500, openLoading: 7000, still: 150, idle: q ? 1500 : 600, noMatchAfter: q ? 2500 : 0, notice: 1500, noticeAfter: q ? 2000 : 0, cap: 9000, ...o };
    let sig = null;
    let since = t0;
    let opts = [];
    let i = -1;
    const res = await waitFor(() => {
      const now = Date.now();
      const elapsed = now - t0;
      opts = lim.read(elapsed);
      const { loading, notice } = menuState(el);
      const s = opts.map((n) => n.textContent).join('|') + '#' + (loading ? 'L' : '') + notice;
      if (s !== sig) {
        sig = s;
        since = now;
      }
      i = want != null && opts.length ? bestIndex(opts.map((n) => n.innerText || n.textContent), want) : -1;
      const quiet = now - since;
      if (!opts.length) {
        if (notice && !loading && quiet >= lim.notice && elapsed >= lim.noticeAfter) return { why: 'closed' };
        return elapsed >= (loading ? lim.openLoading : lim.open) ? { why: 'closed' } : null;
      }
      const fresh = !q || elapsed >= 450 || opts.every((n) => norm(n.textContent).includes(q));
      const calm = (quiet >= lim.still && !loading) || quiet >= 700;
      if (want == null) return calm && fresh ? { why: 'listed' } : null;
      if (i >= 0) return calm && fresh ? { why: 'match' } : null;
      return quiet >= lim.idle && elapsed >= lim.noMatchAfter && !loading && fresh ? { why: 'nomatch' } : null;
    }, lim.cap, 50);
    return { opts, i, why: res ? res.why : 'cap' };
  }

  /** Did the dropdown take a choice? (react-select shows it beside the input, others in the input / value text.) */
  function comboHolds(el) {
    // react-select keeps typed search text in its <input> without picking anything (Glenfield's grad
    // date took "December 2027" as text and the form refused it): only a shown choice counts there.
    const vc = el.closest('[class*="value-container" i], [class*="ValueContainer"]');
    const box = vc ? vc.parentElement : null;
    const shown = box && box.querySelector('[class*="single-value" i], [class*="singleValue"], [class*="multi-value__label" i], [class*="multiValue"]');
    return vc ? !!shown : !!readValue(el);
  }

  async function comboPick(el, value, query) {
    const W = AF().widgets;
    const before = new Set(Array.from(doc.querySelectorAll('[role="option"]')));
    const control = el.closest('.select__control') || el;
    const input = el.tagName === 'INPUT' ? el : el.querySelector('input');
    // A menu left open (e.g. by an earlier failed pick) closes on a press, and the text typed
    // next is thrown away on blur: only focus it then.
    const flagged = () => (input && input.getAttribute('aria-expanded') === 'true') || /menu-is-open/.test(control.className || '');
    const isOpen = () => flagged() || !!menuOptions(el);
    if (flagged() && input) input.focus();
    else {
      press(control);
      // Typing opens most menus by itself, so a text box only gets a moment to react to the press.
      await waitFor(() => isOpen() || popupSearch(el), input ? 150 : 400, 25);
    }
    // iCIMS dropdowns (<a role="combobox">) keep their search box in a popup next to them
    // (`#<id>_ctnr` / aria-controls), and their long lists (US states) load as you scroll: type there so the list filters.
    const search = input || popupSearch(el);
    let typed = null;
    if (search && !search.readOnly) {
      typed = String(query || value);
      // Type without a blur: react-select clears its search text on blur (setNative blurs).
      if (W && W.typeText) W.typeText(search, typed);
      else setNative(search, typed);
    }
    // Async lists (Greenhouse School, location search) first show a default list, then the
    // search results: keep reading until an option matches or the list stops changing (longer while a loader shows).
    const read = (elapsed) => menuOptions(el) || Array.from(doc.querySelectorAll('[role="option"]')).filter((o) => isVisible(o) && (!before.has(o) || elapsed > 800));
    const { opts, i } = await awaitMenu(el, value, { read, query: typed });
    if (!opts.length) {
      if (input) {
        input.dispatchEvent(new root.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        await waitFor(() => comboHolds(el), 300, 25);
      }
      const ok = comboHolds(el);
      return ok ? { ok, note: 'no option list appeared; pressed Enter' } : { ok, error: 'no option list appeared and nothing was picked; run `jobctl options` to see the choices' };
    }
    if (i < 0) {
      if (input) input.dispatchEvent(new root.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      return { ok: false, error: 'no option matches', options: opts.slice(0, 40).map((o) => cut(o.innerText || o.textContent, 100)) };
    }
    const chose = cut(opts[i].innerText || opts[i].textContent, 100);
    const shownBefore = readValue(el);
    // Did the field take the choice? It shows something new, or already shows this one.
    const took = () => {
      if (!comboHolds(el)) return false;
      const now = readValue(el);
      return now !== shownBefore || norm(now).includes(norm(chose)) || norm(now) === norm(value);
    };
    // The list can be re-rendered between our read and the press (a debounced search landing, a blur re-render):
    // then the node we hold is detached and takes no click. Find the option again by its text.
    const refind = () => {
      const now = read(Infinity);
      const k = now.length ? bestIndex(now.map((o) => o.innerText || o.textContent), chose) : -1;
      return k >= 0 ? now[k] : null;
    };
    const picked = await pickOption(opts[i], took, refind);
    // A short tail lets the widget finish re-rendering before the next action (a multi-select pick follows at once).
    if (picked) await sleep(40);
    return picked ? { ok: true, chose } : { ok: false, chose, error: `pressed "${chose}" but the field does not show it; run \`jobctl options\` or pick it by hand` };
  }

  /**
   * Press a list option and confirm the pick registered: took() turns true within ~600 ms. If it did not and the
   * node we pressed is gone (the list re-rendered under us), press the re-found option once more. A live option
   * that took no click is not pressed again: on a toggle (multi-select) a second press would undo the first.
   */
  async function pickOption(target, took, refind) {
    for (let tries = 0; tries < 2; tries++) {
      if (!target.isConnected) {
        const next = refind();
        if (!next) return false;
        target = next;
      }
      press(target);
      if (await waitFor(took, 600, 25)) return true;
      if (target.isConnected && isVisible(target)) return false;
    }
    return false;
  }

  /** A text box that wants a pick from its own suggestion list (Lever "Current location"). */
  function isAutocomplete(el) {
    if (el.tagName !== 'INPUT' || !/^(text|search|)$/.test(el.type || '')) return false;
    if (/^(list|both)$/.test(el.getAttribute('aria-autocomplete') || '')) return true;
    const box = el.parentElement;
    return !!(box && box.querySelector('[class*="dropdown-results" i], [class*="suggestion" i], [class*="autocomplete" i] [class*="result" i]'));
  }

  async function autocompletePick(el, value, query) {
    const W = AF().widgets;
    const before = new Set(Array.from(doc.querySelectorAll('[role="option"]')));
    const scope = el.parentElement || doc;
    const typed = String(query || value);
    if (W && W.typeText) W.typeText(el, typed);
    else setNative(el, typed);
    const read = () => {
      const local = Array.from(scope.querySelectorAll('[role="option"], [class*="dropdown-results" i] > *, [class*="suggestion" i] li, [class*="suggestion" i] > div'));
      const global = Array.from(doc.querySelectorAll('[role="option"]')).filter((o) => !before.has(o));
      return Array.from(new Set(local.concat(global))).filter((o) => isVisible(o) && clean(o.innerText || o.textContent));
    };
    // Suggestions arrive after the page's debounce (and a network call): wait for them, but give up on
    // "nothing ever appeared" after 2.5 s (a loader keeps the full 5 s).
    const { opts, i } = await awaitMenu(el, value, { read, query: typed });
    if (i < 0) {
      return { ok: false, error: opts.length ? 'no suggestion matches' : 'no suggestions appeared', options: opts.slice(0, 20).map((o) => cut(o.innerText || o.textContent, 100)) };
    }
    const chose = cut(opts[i].innerText || opts[i].textContent, 100);
    let target = opts[i];
    // The pick took when the box holds more than the typed search (or exactly the suggestion) and the list is gone.
    const took = () => !!el.value && (norm(el.value) !== norm(typed) || norm(el.value) === norm(chose)) && (!target.isConnected || !isVisible(target));
    const refind = () => {
      const now = read();
      const k = now.length ? bestIndex(now.map((o) => o.innerText || o.textContent), chose) : -1;
      if (k >= 0) target = now[k];
      return k >= 0 ? target : null;
    };
    const picked = await pickOption(target, took, refind);
    if (picked) await sleep(40);
    return { ok: picked, chose, value: cut(el.value, 200), ...(picked ? {} : { error: `pressed "${chose}" but the box does not show it` }) };
  }

  const TRUE = /^(y|yes|true|1|on|check|checked|tick)$/i;

  /** "MM/DD/YYYY", "MM/YYYY" or "YYYY-MM-DD" into Workday's Month / Day / Year spinbuttons. */
  async function setDateSections(wrap, value) {
    const v = value.trim();
    let m = /^(\d{1,2})\/(?:(\d{1,2})\/)?(\d{4})$/.exec(v);
    let d = m && { month: m[1], day: m[2] || '', year: m[3] };
    if (!d && (m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(v))) d = { month: m[2], day: m[3] || '', year: m[1] };
    // Year-only dates (Workday education "From" / "To (Actual or Expected)").
    if (!d && /^\d{4}$/.test(v)) d = { month: '', day: '', year: v };
    if (!d) return { ok: false, error: 'date sections want MM/DD/YYYY' };
    const sec = (n) => wrap.querySelector(`[data-automation-id="dateSection${n}-input"]`);
    const parts = [[sec('Month'), d.month], [sec('Day'), d.day || (d.month ? '1' : '')], [sec('Year'), d.year]].filter(([i, t]) => i && t);
    if (!parts.length) return { ok: false, error: 'no date section for this value' };
    for (const [input, text] of parts) {
      const want = String(Number(text));
      input.focus();
      setNative(input, '');
      for (const ch of String(text)) {
        const init = { key: ch, code: `Digit${ch}`, keyCode: 48 + Number(ch), which: 48 + Number(ch), bubbles: true, cancelable: true, composed: true };
        input.dispatchEvent(new input.ownerDocument.defaultView.KeyboardEvent('keydown', init));
        input.dispatchEvent(new input.ownerDocument.defaultView.KeyboardEvent('keypress', init));
        setNative(input, input.value + ch);
        input.dispatchEvent(new input.ownerDocument.defaultView.KeyboardEvent('keyup', init));
      }
      if (String(Number(input.value.replace(/\D/g, '') || 'NaN')) !== want) setNative(input, text);
      await sleep(50);
    }
    // Workday commits a date to the form on focusout of the wrapper, not on the section's own events (DUNVALE 2026-10-09:
    // an education "From" year showed 2023 and saved as "No Response"): blur for real, then the bubbling focusout.
    const lastInput = parts[parts.length - 1][0];
    fire(lastInput, 'blur');
    lastInput.dispatchEvent(new lastInput.ownerDocument.defaultView.FocusEvent('focusout', { bubbles: true, composed: true }));
    try {
      lastInput.blur();
    } catch (e) {
      /* not focusable */
    }
    await sleep(50);
    const got = parts.map(([i]) => i.value).join('/');
    return { ok: parts.every(([i, t]) => Number(i.value.replace(/\D/g, '')) === Number(t)), value: got };
  }

  /**
   * Put text in a box AND make the framework take it (Ashby LinkedIn 2026-10-09: the box showed the value, the form
   * said "Missing entry for required field"): focus, native set, input + change, then blur + focusout (React
   * validates / commits on focusout). A page that is still hydrating drops events fired at its not-yet-attached
   * handlers, so on a young page the commit is repeated once hydration has had a moment; then the field's own
   * error text decides: an error still beside it gets one clean retype.
   */
  function fieldError(el) {
    if (el.getAttribute('aria-invalid') === 'true') return true;
    const box = el.closest('[data-field-path], [class*="field-entry" i], [class*="fieldEntry" i], [class*="form-field" i], .field') || el.parentElement;
    return !!box && /missing entry|required field|this field is required|is required/i.test(clean(shownText(box)));
  }
  async function commitText(el, value) {
    const once = () => {
      setNative(el, value);
      fire(el, 'blur');
    };
    once();
    if (root.performance && root.performance.now() < 3000) {
      await sleep(450);
      if (el.isConnected) once();
    }
    await sleep(60);
    if (el.isConnected && el.value === value && fieldError(el)) {
      setNative(el, '');
      const W = AF().widgets;
      if (W && W.typeText) W.typeText(el, value);
      else setNative(el, value);
      fire(el, 'change');
      fire(el, 'blur');
      fire(el, 'focusout');
    }
  }

  JB.set = async function set(o) {
    const el = byRef(o.ref);
    const value = o.value == null ? '' : String(o.value);
    if (wdPromptInput(el) && /\s>\s/.test(value)) return wdPick(el, value);
    const kind = kindOf(el);
    const label = el.type === 'radio' || (el.type === 'checkbox' && groupInputs(el).length > 1) ? groupLabel(el) : labelOf(el);

    if (isButtonGroup(el)) {
      // Pills (Ashby / Oracle): press the one that matches; "A; B" presses one pill per value (multi-select pills).
      const btns = pillsOf(el);
      const texts = btns.map((b) => b.textContent);
      const wanted = value.split(/\s*;\s*/).filter(Boolean);
      const picks = []; // the texts of the pills that must end up pressed
      for (const w of wanted.length ? wanted : [value]) {
        const i = bestIndex(texts, w);
        if (i < 0) return { ok: false, error: 'no option matches', options: btns.map((b) => clean(b.textContent)) };
        picks.push(norm(btns[i].textContent));
      }
      // Oracle re-renders the whole list on a press (new nodes, sometimes a new box): every step finds the box
      // (by its question when ours was replaced) and the pill (by its text) again, never a node held from before.
      const boxNow = () => (el.isConnected ? el : (buttonGroups().find((g) => labelOf(g.el) === label) || {}).el);
      const pillNow = (t) => {
        const box = boxNow();
        return (box && pillsOf(box).find((b) => norm(b.textContent) === t)) || null;
      };
      for (const t of picks) {
        const pill = await waitFor(() => pillNow(t), 400, 25);
        if (pill && !isOn(pill)) {
          press(pill);
          // The pill flips on the click (or on the re-render that follows it).
          await waitFor(() => {
            const b = pillNow(t);
            return b && isOn(b);
          }, 400, 25);
        }
      }
      const live = boxNow();
      const on = live ? pillsOf(live).filter(isOn).map((b) => norm(b.textContent)) : [];
      const ok = picks.every((t) => on.includes(t));
      return { ok, value: live ? pressedText(live) : '' };
    }
    if (el.tagName === 'INPUT' && el.type === 'checkbox') {
      const group = groupInputs(el);
      if (group.length === 1) {
        if (isConsent(label) && !o.autoConsent) return { ok: false, consent: true, error: 'consent / authorization box: the owner ticks it in the browser window' };
        const want = TRUE.test(value);
        if (el.checked !== want) {
          press(el);
          await holds(() => el.checked === want, 250, 500); // stays as pressed; a late revert shows as not ok
        }
        return { ok: el.checked === want, value: readValue(el) };
      }
      const wanted = value.split(/\s*[;|]\s*/).filter(Boolean);
      const texts = group.map(choiceText);
      for (const w of wanted) {
        const i = bestIndex(texts, w);
        if (i >= 0 && !group[i].checked) press(group[i]);
      }
      return { ok: true, value: readValue(el) };
    }
    if (el.tagName === 'INPUT' && el.type === 'radio') {
      const group = groupInputs(el);
      const i = bestIndex(group.map(choiceText), value);
      if (i < 0) return { ok: false, error: 'no option matches', options: group.map(choiceText) };
      press(group[i]);
      await waitFor(() => group[i].checked, 250, 25);
      await sleep(30);
      return { ok: group[i].checked, value: readValue(el) };
    }
    if (el.tagName === 'SELECT') {
      const texts = Array.from(el.options).map((op) => op.textContent);
      const i = bestIndex(texts, value);
      if (i < 0) return { ok: false, error: 'no option matches', options: optionsOf(el) };
      const f = AF().filler;
      if (f && f.setNative) f.setNative(el, 'selectedIndex', i);
      else {
        el.selectedIndex = i;
        fire(el, 'input');
        fire(el, 'change');
      }
      return { ok: el.selectedIndex === i, value: readValue(el) };
    }
    if (el.tagName === 'INPUT' && el.type === 'file') return { ok: false, error: 'file input: use upload' };
    // Workday MM/DD/YYYY date sections (AmFam grad date, 2026-10-09): the ref is the Month spinbutton; a set
    // of "12/01/2027" typed only "12". Fill each section in turn.
    const dateWrap = el.closest('[data-automation-id="dateInputWrapper"]');
    if (dateWrap && el.getAttribute('role') === 'spinbutton') return setDateSections(dateWrap, value);
    if (kind === 'combobox' || (el.tagName === 'BUTTON' && el.getAttribute('aria-haspopup'))) {
      // Multi-select (react-select "--is-multi", Glenfield languages): "A; B; C" is one pick per value.
      const parts = value.split(/\s*;\s*/).filter(Boolean);
      if (parts.length > 1 && isMultiCombo(el)) {
        const chose = [];
        const failed = [];
        for (const v of parts) {
          const r = await comboPick(el, v, null);
          (r.ok && r.chose ? chose : failed).push(r.chose || v);
        }
        return { ok: !failed.length, chose: chose.join('; '), value: readValue(el), ...(failed.length ? { error: 'no option matches: ' + failed.join('; ') } : {}) };
      }
      return comboPick(el, value, o.query);
    }
    if (el.isContentEditable) {
      el.focus();
      el.textContent = value;
      fire(el, 'input');
      return { ok: true, value: cut(el.textContent) };
    }
    if (isAutocomplete(el)) {
      if (el.value) setNative(el, '');
      return autocompletePick(el, value, o.query);
    }
    // Plain text-like control.
    if (o.clear !== false && el.value) setNative(el, '');
    await commitText(el, value);
    // Date pickers parse on close and drop what they cannot read ("12/2027" -> ""): close it, then check.
    if (el.closest('.react-datepicker-wrapper, [class*="datepicker" i], [class*="date-picker" i]')) {
      const W = AF().widgets;
      if (W && W.pressOutside) W.pressOutside(doc);
      // Parsing happens as the calendar closes: wait for it to be gone (or the box cleared), then the value must
      // survive a short hold (a picker that rejects the format clears the box a beat after it closes).
      await waitFor(() => !el.value || !doc.querySelector('.react-datepicker-popper, [class*="datepicker" i][class*="popper" i], [class*="calendar" i][role="dialog"]'), 400, 25);
      if (!(await holds(() => !!el.value, 300, 500))) return { ok: false, error: 'the date picker rejected this format', value: '', placeholder: el.placeholder || null };
    }
    // Phone widgets reformat ("(555) 010-0100" -> "(555) 010-0100"): compare the digits.
    const digits = (t) => String(t).replace(/\D/g, '');
    if (el.type === 'tel' && digits(value).length >= 7) return { ok: digits(el.value).endsWith(digits(value).slice(-10)), value: cut(el.value, 300) };
    return { ok: el.value === value || clean(el.value) === clean(value), value: cut(el.value, 300) };
  };

  /** Options of a select / radio group, or of a custom dropdown (opened, read, closed). */
  /*
   * Workday prompts with categories (Thornby "How Did You Hear About Us?", 2026-10-09): the first list holds rows
   * with a side chevron (data-uxi-multiselectlistitem-type="2"); a click opens that row's own list under a header with a
   * Back button, and only those leaves (type "1") are answers. Picking "Online" chose nothing and the page refused to
   * move on. JB.options lists such a prompt as "Category > Leaf"; JB.set takes that path.
   */
  const WD_PROMPT = '[data-automation-id="responsiveMonikerPrompt"]';
  function wdPromptInput(el) {
    return el && el.matches && el.matches('input[data-uxi-widget-type="selectinput"]') ? el : null;
  }
  function wdRows() {
    const pop = Array.from(doc.querySelectorAll(WD_PROMPT)).filter(isVisible).pop();
    if (!pop) return null;
    const rows = Array.from(pop.querySelectorAll('[data-automation-id="promptLeafNode"]')).map((n) => {
      const opt = n.querySelector('[data-automation-id="promptOption"]');
      return { node: n, opt, label: opt ? clean(opt.getAttribute('data-automation-label') || opt.textContent) : '', category: n.getAttribute('data-uxi-multiselectlistitem-type') === '2' };
    });
    return { pop, rows, back: pop.querySelector('[data-automation-id="backButton"]'), title: clean((pop.querySelector('[data-automation-id="promptTitle"]') || {}).textContent || '') };
  }
  // The virtualized list fills in over a few frames (Thornby: 2 of 7 rows right after a Back): the rows once their
  // count holds still.
  async function wdSettled(first) {
    let last = first;
    for (let i = 0, same = 0; i < 12 && last; i++) {
      await sleep(80);
      const n = wdRows();
      if (!n) return last;
      same = n.rows.length === last.rows.length && !!n.back === !!last.back ? same + 1 : 0;
      last = n;
      if (same >= 2) break;
    }
    return last;
  }
  async function wdOpen(input) {
    if (!(wdRows() || {}).rows) press(input);
    const got = await waitFor(() => {
      const r = wdRows();
      return r && r.rows.length ? r : null;
    }, 3000, 50);
    return got && wdSettled(got);
  }
  async function wdInto(label) {
    const r = wdRows();
    const row = r && r.rows.find((x) => x.label === label);
    if (!row) return null;
    press(row.opt);
    const got = await waitFor(() => {
      const n = wdRows();
      return n && n.back && n.title === label && n.rows.length ? n : null;
    }, 3000, 50);
    return got && wdSettled(got);
  }
  async function wdBack() {
    const r = wdRows();
    if (!r || !r.back) return;
    press(r.back.closest('[data-automation-id="multiSelectHeader"]') || r.back);
    const got = await waitFor(() => {
      const n = wdRows();
      return n && !n.back ? n : null;
    }, 3000, 50);
    if (got) await wdSettled(got);
  }
  /** ["Online > LinkedIn", ...] for a prompt with categories, else null (a flat prompt keeps the usual path). */
  async function wdTree(input) {
    let top = await wdOpen(input);
    // Left open inside a category (an earlier pick that went nowhere): back to the first list.
    if (top && top.back) {
      await wdBack();
      top = wdRows();
    }
    if (!top || !top.rows.some((x) => x.category)) {
      closeMenu(input);
      return null;
    }
    const out = [];
    for (const row of top.rows.map((x) => ({ label: x.label, category: x.category }))) {
      if (!row.category) {
        out.push(row.label);
        continue;
      }
      // Each category from the first list again: a Back can also close the prompt (virtualized rows re-render).
      const now = await wdOpen(input);
      if (now && now.back) await wdBack();
      const sub = await wdInto(row.label);
      if (sub) out.push(...sub.rows.map((x) => `${row.label} > ${x.label}`));
      await wdBack();
    }
    closeMenu(input);
    return out;
  }
  /** Pick "Category > Leaf" in a Workday prompt; ok when the pill shows the leaf. */
  async function wdPick(input, path) {
    const [cat, leaf] = path.split(/\s+>\s+/);
    const top = await wdOpen(input);
    if (!top) return { ok: false, error: 'the prompt did not open' };
    if (top.back) await wdBack();
    const sub = await wdInto(cat);
    const row = sub && sub.rows.find((x) => x.label === leaf);
    if (!row) {
      closeMenu(input);
      return { ok: false, error: `no "${leaf}" under "${cat}"` };
    }
    press(row.opt);
    const box = input.closest('[data-automation-id="multiSelectContainer"]') || input.closest('[data-automation-id^="formField-"]') || input.parentElement;
    const shown = await waitFor(() => Array.from(box.querySelectorAll('[data-automation-id="selectedItem"], [data-automation-id="promptOption"]')).some((x) => clean(x.textContent) === leaf), 3000, 50);
    closeMenu(input);
    return { ok: !!shown, value: shown ? leaf : '' };
  }

  JB.options = async function options(o) {
    const el = byRef(o.ref);
    // A Workday prompt with categories lists its leaves as "Category > Leaf".
    if (wdPromptInput(el)) {
      const tree = await wdTree(el);
      if (tree) return tree;
    }
    const direct = optionsOf(el);
    // iCIMS ajax dropdowns keep an empty hidden <select> next to them: an empty list means "open the menu".
    if (direct && (direct.length || el.tagName === 'SELECT')) return direct;
    const before = new Set(Array.from(doc.querySelectorAll('[role="option"]')));
    press(el.closest('.select__control') || el);
    const read = () => menuOptions(el) || Array.from(doc.querySelectorAll('[role="option"]')).filter((x) => isVisible(x) && !before.has(x));
    const input = el.tagName === 'INPUT' ? el : el.querySelector('input') || popupSearch(el);
    const search = !!(o.query && input && !input.readOnly);
    // With a search to type next, the unfiltered list only gets a moment (async lists show nothing until you type).
    let { opts } = await awaitMenu(el, null, search ? { read, open: 400 } : { read });
    // Async lists (Greenhouse Discipline / School) show nothing until you type: search for o.query.
    if (search) {
      const W0 = AF().widgets;
      if (W0 && W0.typeText) W0.typeText(input, String(o.query));
      else setNative(input, String(o.query));
      ({ opts } = await awaitMenu(el, null, { read, query: String(o.query) }));
    }
    const texts = opts.slice(0, 80).map((x) => cut(x.innerText || x.textContent, 100));
    if (input && o.query) setNative(input, '');
    closeMenu(el);
    const W = AF().widgets;
    if (W && W.pressOutside) W.pressOutside(doc);
    else doc.body.dispatchEvent(new root.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return texts;
  };

  JB.click = async function click(o) {
    const el = byRef(o.ref);
    const label = labelOf(el);
    if (el.tagName === 'INPUT' && el.type === 'checkbox' && isConsent(label) && !o.autoConsent) {
      return { ok: false, consent: true, error: 'consent / authorization box: the owner ticks it in the browser window' };
    }
    const a = el.closest('a[href]');
    // A link that opens a new window would be blocked as a popup: hand its URL back instead.
    if (a && /^https?:/.test(a.href) && (a.target === '_blank' || o.navigate)) return { ok: true, navigate: a.href };
    press(el);
    return { ok: true };
  };

  // Every element matching `sel`, open shadow roots included (SmartRecruiters oneclick-ui 2026-10-10: the whole
  // form lives in spl-input / spl-autocomplete web components, so doc.querySelector sees no fields at all).
  // Firefox content scripts see page-defined custom elements through Xray: `shadowRoot` can read null there,
  // `openOrClosedShadowRoot` is the extension-only way in (closed roots too).
  const shadowOf = (el) => (el && (el.openOrClosedShadowRoot || el.shadowRoot)) || null;
  function deepAll(sel, root = doc, out = []) {
    root.querySelectorAll(sel).forEach((el) => out.push(el));
    root.querySelectorAll('*').forEach((el) => shadowOf(el) && deepAll(sel, shadowOf(el), out));
    return out;
  }
  function deepLabel(el) {
    let host = el.getRootNode && el.getRootNode().host;
    const own = el.getAttribute('aria-label') || el.placeholder || el.name || el.id || '';
    for (let i = 0; i < 4 && host; i++) {
      const l = host.getAttribute && (host.getAttribute('label') || host.getAttribute('aria-label'));
      if (l) return clean(l);
      host = host.getRootNode && host.getRootNode().host;
    }
    return clean(own);
  }

  /** Visible text of the page with open shadow roots flattened in (what `jobctl text` misses on web-component forms). */
  JB.deepText = async function deepText() {
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === 3) { const t = node.textContent.trim(); if (t) parts.push(t); return; }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node.nodeType === 1 && /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(node.tagName)) return;
      if (node.nodeType === 1 && node.matches('input[type=radio], input[type=checkbox], [role=radio], [role=checkbox]')) {
        parts.push(node.checked || node.getAttribute('aria-checked') === 'true' ? '(x)' : '( )');
      }
      if (shadowOf(node)) walk(shadowOf(node));
      const kids = node.nodeType === 1 && node.tagName === 'SLOT' ? node.assignedNodes() : node.childNodes;
      kids.forEach(walk);
    };
    walk(doc.body);
    return parts.join(' ');
  };

  /**
   * Pick option `option` (regex) of the question matching `question` (regex) on a web-component form: walks the
   * composed tree in page order and clicks the first radio / checkbox / option-like element after the question
   * whose text matches (SmartRecruiters screening questions, 2026-10-10).
   */
  JB.deepPick = async function deepPick(o) {
    const q = new RegExp(o.question, 'i');
    const opt = new RegExp(o.option, 'i');
    let armed = false;
    let hit = null;
    // Option widgets only (a bare <label> inside a radio's own shadow root matched the wrong group).
    const CLICK = o.box ? 'spl-checkbox, input[type=checkbox], [role=checkbox]' : 'spl-radio, input[type=radio], [role=radio], [role=option]';
    const textOf = (el) => clean(el.getAttribute('label') || el.getAttribute('aria-label') || el.innerText || el.textContent || '');
    const walk = (node) => {
      if (hit) return;
      if (node.nodeType === 3) { if (!armed && q.test(node.textContent)) armed = true; return; }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node.nodeType === 1 && /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|HEAD)$/.test(node.tagName)) return;
      if (armed && node.nodeType === 1 && node.matches(CLICK)) {
        let t = textOf(node);
        if (!t && node.id) { const l = node.getRootNode().querySelector(`label[for="${node.id}"]`); if (l) t = textOf(l); }
        if (t && opt.test(t)) { hit = node; return; }
      }
      if (shadowOf(node)) walk(shadowOf(node));
      (node.nodeType === 1 && node.tagName === 'SLOT' ? node.assignedNodes() : node.childNodes).forEach(walk);
    };
    walk(doc.body);
    if (!hit) return { ok: false, error: armed ? 'question found, no option matches ' + o.option : 'no question matches ' + o.question };
    hit.scrollIntoView({ block: 'center' });
    press(hit);
    const box = hit.matches('input') ? hit : hit.querySelector('input') || (shadowOf(hit) && shadowOf(hit).querySelector('input'));
    return { ok: true, tag: hit.tagName.toLowerCase(), text: cut(textOf(hit), 80), checked: box ? box.checked : undefined };
  };

  /** Markup around the first text matching `pattern` in the composed tree, `up` levels out (debugging web components). */
  JB.deepHtml = async function deepHtml(o) {
    const re = new RegExp(o.pattern, 'i');
    let found = null;
    const walk = (node) => {
      if (found) return;
      if (node.nodeType === 3) { if (re.test(node.textContent)) found = node.parentNode; return; }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node.nodeType === 1 && /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|HEAD)$/.test(node.tagName)) return;
      if (shadowOf(node)) walk(shadowOf(node));
      node.childNodes.forEach(walk);
    };
    walk(doc.body);
    let el = found;
    const up = (n) => (n.nodeType === 11 ? n.host : n.parentNode && n.parentNode.nodeType === 11 ? n.parentNode.host : n.parentNode);
    if (el && el.nodeType === 11) el = el.host;
    for (let i = 0; el && i < Number(o.up || 3); i++) el = up(el) || el;
    return el ? cut(el.outerHTML || '', 6000) : { found: !!found };
  };

  /** Inputs inside shadow roots (snapshot can't see them): index, label, type, value. */
  JB.deepFields = async function deepFields() {
    return deepAll('input, textarea, select')
      .filter((el) => el.type !== 'hidden' && !(isHoneypot && el.matches('input') && isHoneypot(el)))
      .map((el, i) => ({ i, label: deepLabel(el), type: el.type || el.tagName.toLowerCase(), value: cut(el.value || '', 60) }));
  };

  /** Type `value` into the deep field whose label matches `label` (regex) or index `i`. */
  JB.deepType = async function deepType(o) {
    const all = deepAll('input, textarea, select').filter((el) => el.type !== 'hidden');
    const re = o.label ? new RegExp(o.label, 'i') : null;
    const el = re ? all.find((e) => re.test(deepLabel(e))) : all[Number(o.i)];
    if (!el) return { ok: false, error: 'no deep field matches ' + (o.label || o.i) };
    if (isHoneypot && el.matches('input') && isHoneypot(el)) return { ok: false, error: 'honeypot field' };
    if (o.value === '' || o.value == null) {
      el.scrollIntoView({ block: 'center' });
      return { ok: true, label: deepLabel(el), scrolled: true };
    }
    try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    setNative(el, o.value);
    el.dispatchEvent(new el.ownerDocument.defaultView.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: o.value }));
    fire(el, 'blur');
    el.dispatchEvent(new el.ownerDocument.defaultView.FocusEvent('focusout', { bubbles: true, composed: true }));
    return { ok: true, label: deepLabel(el), value: el.value };
  };

  /** Click the first element matching a CSS selector (hand fixes: links no snapshot lists). */
  JB.pressSelector = async function pressSelector(o) {
    const el = doc.querySelector(o.selector) || deepAll(o.selector)[0];
    if (!el) return { ok: false, error: 'nothing matches ' + o.selector };
    if (isHoneypot && el.matches('input') && isHoneypot(el)) return { ok: false, error: 'honeypot field' };
    press(el);
    return { ok: true, text: cut(el.innerText || el.value || '', 80) };
  };

  /** Click the first visible button / link whose text matches `pattern` (a regex source). */
  JB.clickText = async function clickText(o) {
    const re = new RegExp(o.pattern, o.flags || 'i');
    const btn = listButtons().find((b) => re.test(b.text));
    if (!btn) return { ok: false, error: 'no button matches ' + o.pattern };
    const res = await JB.click({ ref: btn.ref });
    return { ...res, ref: btn.ref, text: btn.text };
  };

  /* ------------------------------ files ------------------------------ */

  function fileScore(input, which) {
    const near = [labelOf(input), input.name, input.id, input.getAttribute('aria-label'), input.getAttribute('data-automation-id')];
    let node = input;
    for (let i = 0; i < 4 && node; i++) {
      node = node.parentElement;
      if (node) near.push(cut(node.innerText || '', 300));
    }
    const t = near.filter(Boolean).join(' ').toLowerCase();
    const resume = /resume|résumé|\bcv\b|curriculum/.test(t);
    const cover = /cover/.test(t);
    const transcript = /transcript/.test(t);
    if (which === 'resume') return resume && !cover ? 3 : resume ? 2 : !cover && !transcript ? 1 : 0;
    if (which === 'cover') return cover ? 3 : 0;
    if (which === 'transcript') return transcript ? 3 : 0;
    return 1;
  }

  /**
   * What a file slot is for, from its own question text (Greenhouse's buttons all read "Attach";
   * the question "Resume/CV" / "Cover Letter" / "...transcript" sits above them).
   */
  function fileKind(input) {
    let t = [labelOf(input), input.name, input.id, input.getAttribute('aria-label'), input.getAttribute('data-automation-id')].filter(Boolean).join(' ');
    // Greenhouse: the slot sits in div[role=group][aria-labelledby=upload-label-...] several levels up.
    const group = input.closest('[role="group"][aria-labelledby]');
    if (group) t += ' ' + textOfIds(group.getAttribute('aria-labelledby'));
    for (let node = input.parentElement, i = 0; node && i < 7; node = node.parentElement, i++) {
      const qt = questionTitle(node, input);
      if (qt) {
        t += ' ' + qt;
        break;
      }
      const own = clean(Array.from(node.childNodes).filter((n) => !(n.contains && n.contains(input))).map(shownText).join(' '));
      if (own && own.length < 200 && /resume|résumé|\bcv\b|cover|transcript/i.test(own)) {
        t += ' ' + own;
        break;
      }
    }
    if (/autofill|auto-fill|autopopulate|parse your resume/i.test(t)) return 'autofill';
    if (/cover/i.test(t)) return 'cover';
    if (/transcript/i.test(t)) return 'transcript';
    if (/resume|résumé|\bcv\b|curriculum/i.test(t)) return 'resume';
    return 'other';
  }

  /** Put a file into a file input. o = { ref?, which: resume|cover|transcript, name, mime, b64 } */
  JB.upload = async function upload(o) {
    let input = o.ref ? byRef(o.ref) : null;
    if (!input) {
      const all = Array.from(doc.querySelectorAll('input[type="file"]')).filter((i) => !i.disabled);
      const ranked = all.map((i) => ({ i, s: fileScore(i, o.which || 'resume') })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
      input = ranked.length ? ranked[0].i : null;
    }
    if (!input) return { ok: false, error: `no file input for ${o.which || 'resume'} on this page` };
    if (input.files && input.files.length && !o.force) return { ok: true, skipped: 'already has ' + input.files[0].name, ref: refOf(input) };
    const bin = root.atob(o.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new root.File([bytes], o.name, { type: o.mime || 'application/octet-stream' });
    const dt = new root.DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    fire(input, 'input');
    fire(input, 'change');
    // Drop zones that ignore change events on their hidden input.
    const zone = input.closest('[class*="drop" i], [data-automation-id*="drop" i]');
    if (zone) {
      try {
        const view = doc.defaultView;
        zone.dispatchEvent(new view.DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      } catch (e) {
        /* not every zone wants a drop */
      }
    }
    if (input.files && input.files.length) return { ok: true, ref: refOf(input), label: labelOf(input) };
    // Workday takes the file and clears its hidden input (2026-10-09: UMBERMOOR / Coppermoor / Glenmoor all logged
    // "FAILED" with the file attached). Success = the file's name listed next to the input.
    return { ok: await uploadListed(input, o.name), ref: refOf(input), label: labelOf(input) };
  };

  async function uploadListed(input, name, waitMs = 8000) {
    const box = input.closest('[data-automation-id*="FileUpload" i], [class*="upload" i], form') || doc.body;
    const want = String(name || '').toLowerCase();
    const end = Date.now() + waitMs;
    for (;;) {
      if (want && (box.innerText || box.textContent || '').toLowerCase().includes(want)) return true;
      if (Date.now() > end) return false;
      await new Promise((r) => root.setTimeout(r, 100));
    }
  }

  /* ------------------------------ sign-in ------------------------------ */

  /**
   * Fill a sign-in or create-account form. o = { email, password }.
   * Fills every visible email/username box and every visible password box
   * (create-account forms have a "verify password" box). Consent boxes on the
   * form are reported, never ticked.
   */
  JB.authFill = async function authFill(o) {
    const vis = Array.from(doc.querySelectorAll('input')).filter((i) => isVisible(i) && !i.disabled && !i.readOnly && !isHoneypot(i));
    const pw = vis.filter((i) => i.type === 'password');
    const emails = vis.filter((i) => i.type === 'email' || /e-?mail|user ?name|login/i.test(`${i.name} ${i.id} ${i.autocomplete} ${labelOf(i)} ${i.getAttribute('data-automation-id') || ''}`));
    const filled = [];
    for (const e of emails.filter((i) => i.type !== 'password')) {
      if (e.value !== o.email) setNative(e, o.email);
      filled.push(refOf(e));
    }
    for (const p of pw) {
      setNative(p, o.password);
      fire(p, 'blur');
      filled.push(refOf(p));
    }
    const unticked = Array.from(doc.querySelectorAll('input[type="checkbox"]')).filter((c) => (isVisible(c) || Array.from(c.labels || []).some(isVisible)) && !c.checked);
    // Sign-up forms: never an "email me job alerts / marketing" box. A required one goes to the owner.
    const consent = unticked.filter((c) => !isOptIn(labelOf(c))).map((c) => ({ ref: refOf(c), label: labelOf(c) }));
    const requiredOptIns = unticked.filter((c) => isOptIn(labelOf(c)) && isRequired(c, labelOf(c))).map((c) => ({ ref: refOf(c), label: labelOf(c) }));
    return { ok: filled.length > 0, emailFields: emails.length, passwordFields: pw.length, filled, uncheckedBoxes: consent, requiredOptIns, buttons: listButtons().filter((b) => /sign|log|create|register|continue|submit|verify/i.test(b.text)) };
  };

  /* ------------------------------ Handshake ------------------------------ */

  /**
   * Handshake's native Apply modal (exu.joinhandshake.com/jobs/<id>, 2026-10-09): a role=dialog titled
   * "Apply to <employer>" with one fieldset per required document ("Attach your resume" / transcript / cover
   * letter). A slot holds either the document Handshake pre-picked (a green chip: <h5>name</h5> + a Close button)
   * or a "Search your resumes" combobox plus an "Upload new" file input. Then employer questions, then
   * "Submit Application". Returns { modal, title, docs: [{heading, attached, removeRef, uploadRef}], buttonRefs,
   * notes } (lib/handshake-apply.js drives it).
   */
  JB.handshakeState = function handshakeState() {
    const dlg = Array.from(doc.querySelectorAll('[role="dialog"]')).find((d) => isVisible(d) && d.querySelector('[data-hook="apply-modal-content"], [id^="apply-modal-title"]'));
    if (!dlg) return { modal: false, docs: [], buttonRefs: [], notes: [] };
    const title = cut((dlg.querySelector('[id^="apply-modal-title"], h2') || {}).textContent || '', 120);
    const docs = Array.from(dlg.querySelectorAll('fieldset')).filter((fs) => /apply-modal-document-heading/.test(fs.getAttribute('aria-labelledby') || '') || fs.querySelector('input[type="file"]')).map((fs) => {
      const hid = fs.getAttribute('aria-labelledby');
      const heading = cut((hid && doc.getElementById(hid) ? doc.getElementById(hid).textContent : (fs.querySelector('h4, legend') || {}).textContent) || '', 120);
      const chip = fs.querySelector('[role="status"], .rosetta-inline-alert');
      const attached = chip ? cut((chip.querySelector('h5') || chip).textContent || '', 160) : null;
      const close = chip ? Array.from(chip.querySelectorAll('button')).find((b) => /close|remove/i.test(b.getAttribute('aria-label') || b.textContent || '')) : null;
      const input = fs.querySelector('input[type="file"]');
      return { heading, attached: attached || null, removeRef: close ? refOf(close) : null, uploadRef: input ? refOf(input) : null };
    });
    const buttonRefs = Array.from(dlg.querySelectorAll('button, a[href], [role="button"]')).filter(isVisible).map(refOf);
    const notes = Array.from(dlg.querySelectorAll('[data-hook="apply-modal-content"] form > div > div:first-child div')).map((d) => cut(d.textContent || '', 200)).filter((t, i, a) => t && a.indexOf(t) === i && !a.some((o) => o !== t && o.includes(t)) && /does not match|not eligible|required|only/i.test(t)).slice(0, 3);
    return { modal: true, title, docs, buttonRefs, notes };
  };

  /* ------------------------------ page-context requests ------------------------------ */

  /**
   * Fetch a URL as the page itself would (its cookies, its origin): sites whose job data sits behind a login
   * (Handshake) answer their own JSON endpoints only to the logged-in page. Firefox content scripts have
   * `content.fetch` for page-origin requests; the plain fetch carries the extension's principal instead.
   * o = { url, method?, headers?, body? (string), max? (chars kept, default 2 MB) }.
   * Returns { ok, status, url, contentType, json? | text? }.
   */
  JB.fetchJson = async function fetchJson(o) {
    const f = (root.content && root.content.fetch) || root.fetch;
    const init = { method: o.method || 'GET', credentials: 'include', headers: Object.assign({ accept: 'application/json' }, o.headers || {}) };
    if (o.body != null) init.body = o.body;
    const res = await f.call(root.content || root, o.url, init);
    const text = await res.text();
    const out = { ok: res.ok, status: res.status, url: res.url, contentType: res.headers.get('content-type') || '' };
    try {
      out.json = JSON.parse(text);
    } catch (e) {
      out.text = text.slice(0, o.max || 2000000);
    }
    return out;
  };

  /** URLs this page has requested (Resource Timing), newest last: finding a site's JSON endpoints. */
  JB.resources = function resources(o) {
    const re = o && o.match ? new RegExp(o.match, 'i') : null;
    return (root.performance.getEntriesByType('resource') || [])
      .map((e) => ({ url: e.name, type: e.initiatorType }))
      .filter((e) => !re || re.test(e.url))
      .slice(-((o && o.max) || 200));
  };

  JB.ready = true;
})(typeof globalThis !== 'undefined' ? globalThis : this);
