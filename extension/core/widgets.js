/*
 * core/widgets.js
 *
 * Operating custom dropdown widgets (Workday buttons, Greenhouse react-select,
 * Avature select2) the way a person would: open, wait for the popup, optionally
 * type a query, pick the option whose text matches, check it stuck, close.
 *
 * Safety: press() is the ONLY function in the extension that synthesizes a
 * click, and it uses an allow-list. It will press a radio, a checkbox, a
 * combobox / listbox opener, or an option inside a popup. It refuses submit and
 * reset buttons, links, anything in a page footer / button bar, and any other
 * element. Next, Save and Continue, Submit, Back and Cancel can never be pressed.
 *
 * Waiting is event driven: MutationObserver plus a light poll (some widgets only
 * change DOM properties, which observers cannot see), always with a timeout.
 * There are no fixed sleeps. fillPopup() calls are serialized: only one popup is
 * ever open at a time, even if two callers race.
 */
(function (root) {
  'use strict';

  const AF = (root.AF = root.AF || {});
  const matcher = AF.matcher || (typeof require === 'function' ? require('./matcher.js') : null);

  const POPUP_TIMEOUT = 2500; // popup must appear within this
  const RESULTS_TIMEOUT = 4000; // ajax/search results (Avature, Greenhouse school)
  const VERIFY_TIMEOUT = 1500; // selected value must show within this
  const POLL_MS = 100;

  /* ------------------------------------------------------------------ */
  /* Small DOM helpers                                                    */
  /* ------------------------------------------------------------------ */

  function clean(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function isShown(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    if (!el.getClientRects().length) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  /* ------------------------------------------------------------------ */
  /* The click guard                                                      */
  /* ------------------------------------------------------------------ */

  // Containers that hold page navigation (Avature button bar, Workday footer).
  // Workday's header (utilityButtonBar) holds a language picker that is an
  // aria-haspopup=listbox button: page chrome, never ours to open.
  const NAV_CONTAINER =
    '.button-bar, .ButtonBarField, footer, [data-automation-id="pageFooter"], ' +
    '[data-automation-id^="bottom-navigation"], [data-automation-id^="pageFooter"], ' +
    'header, [data-automation-id="utilityButtonBar"], [data-automation-id="selectedItemList"]';

  /** True only for elements that are part of a form control we are operating. */
  function isSafeTarget(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (/^(submit|reset|image)$/.test(type)) return false;
    if (tag === 'button' && type !== 'button' && !el.hasAttribute('aria-haspopup')) return false;
    if (el.closest('a[href]')) return false;
    if (el.closest(NAV_CONTAINER)) return false;
    if (el.closest('form button[type="submit"], form input[type="submit"]')) return false;

    const role = el.getAttribute('role');
    if (tag === 'input' && (type === 'radio' || type === 'checkbox')) return true;
    if (role === 'radio' || role === 'checkbox') return true;
    if (role === 'option') return true;
    if (role === 'combobox') return true;
    if (el.getAttribute('aria-haspopup') === 'listbox') return true;
    // react-select's control wraps its combobox input.
    if (el.matches('.select__control') && el.querySelector('input[role="combobox"]')) return true;
    // Workday multiselect prompt: a search box (no type, no role) that opens its
    // result list when clicked (verified on the Workday captures, 2026-10-02).
    if (tag === 'input' && el.getAttribute('data-uxi-widget-type') === 'selectinput') return true;
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Synthetic input                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * A full mouse press (pointerdown, mousedown, pointerup, mouseup, click), so
   * widgets that listen on any one of those react: react-select opens on
   * mousedown, select2 selects on mouseup, Workday and radios act on click.
   * Returns false (and does nothing) if the guard refuses the element.
   */
  function press(el) {
    if (!isSafeTarget(el)) return false;
    const view = el.ownerDocument.defaultView;
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    };
    const P = view.PointerEvent || view.MouseEvent;
    const M = view.MouseEvent;
    el.dispatchEvent(new P('pointerdown', { ...base, buttons: 1, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new M('mousedown', { ...base, buttons: 1 }));
    el.dispatchEvent(new P('pointerup', { ...base, buttons: 0, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new M('mouseup', { ...base, buttons: 0 }));
    if (el.isConnected) el.dispatchEvent(new M('click', { ...base, buttons: 0 }));
    return true;
  }

  const KEY_CODES = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Tab: 9, Backspace: 8 };

  /** keydown + keyup for one named key (Escape, Enter, ArrowDown...). */
  function key(el, name) {
    if (!el || !el.isConnected) return;
    const view = el.ownerDocument.defaultView;
    const code = KEY_CODES[name] || 0;
    const init = { key: name, code: name, keyCode: code, which: code, bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new view.KeyboardEvent('keydown', init));
    el.dispatchEvent(new view.KeyboardEvent('keyup', init));
  }

  /** Put `text` into a search/filter input the way typing would announce it. */
  function typeText(input, text) {
    const view = input.ownerDocument.defaultView;
    try {
      input.focus({ preventScroll: true });
    } catch (e) {
      /* not focusable: events below still work */
    }
    const desc = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value');
    desc.set.call(input, text);
    const last = text.slice(-1);
    input.dispatchEvent(new view.KeyboardEvent('keydown', { key: last, bubbles: true }));
    input.dispatchEvent(new view.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    input.dispatchEvent(new view.KeyboardEvent('keyup', { key: last, bubbles: true }));
  }

  /** mousedown/mouseup on <body>: how select2 and friends notice "clicked outside". No click. */
  function pressOutside(doc) {
    const view = doc.defaultView;
    const init = { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 };
    doc.body.dispatchEvent(new view.MouseEvent('mousedown', { ...init, buttons: 1 }));
    doc.body.dispatchEvent(new view.MouseEvent('mouseup', init));
  }

  /* ------------------------------------------------------------------ */
  /* Waiting                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve with check()'s first truthy result, re-checking on every DOM
   * mutation and every POLL_MS; resolve null after `timeout` ms.
   */
  function waitFor(doc, check, timeout) {
    return new Promise((resolve) => {
      let done = false;
      let obs = null;
      let poll = null;
      let timer = null;
      const finish = (v) => {
        if (done) return;
        done = true;
        if (obs) obs.disconnect();
        root.clearInterval(poll);
        root.clearTimeout(timer);
        resolve(v || null);
      };
      const test = () => {
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
      obs = new root.MutationObserver(test);
      obs.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      poll = root.setInterval(test, POLL_MS);
      timer = root.setTimeout(() => {
        test();
        finish(null);
      }, timeout || POPUP_TIMEOUT);
    });
  }

  /**
   * Resolve once the page has stopped changing for `quiet` ms (or after `max`).
   * Used after a dropdown fill, before rescanning for fields it revealed.
   */
  function settle(doc, quiet, max) {
    const q = quiet || 150;
    return new Promise((resolve) => {
      let quietTimer = null;
      const obs = new root.MutationObserver(() => {
        root.clearTimeout(quietTimer);
        quietTimer = root.setTimeout(done, q);
      });
      const hard = root.setTimeout(done, max || 2000);
      function done() {
        obs.disconnect();
        root.clearTimeout(quietTimer);
        root.clearTimeout(hard);
        resolve();
      }
      obs.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      quietTimer = root.setTimeout(done, q);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Option choice                                                        */
  /* ------------------------------------------------------------------ */

  function optionText(el) {
    return clean(el.getAttribute('data-af-option-text') || el.textContent);
  }

  /** Strict choice among option elements (see matcher.matchOption). */
  function chooseOption(optionEls, key, value) {
    const list = optionEls.map((o) => ({
      text: optionText(o),
      value: '',
      disabled: o.getAttribute('aria-disabled') === 'true',
    }));
    const pick = matcher.matchOption(list, key, value);
    return pick ? { el: optionEls[pick.index], text: list[pick.index].text, confidence: pick.confidence } : null;
  }

  // Search word per matcher.degreeFamily() index.
  const DEGREE_WORDS = ['Bachelor', 'Master', 'Doctor', 'Associate', 'High School'];

  /**
   * What to type into a filtering widget, most specific first. Typing "CA"
   * into a server-side search would return Jamaica and Carolina; the full
   * name is the better query.
   */
  function searchTerms(key, value) {
    // Standard answers (EEO lists, yes/no) are short: read the list as opened.
    if (/^std:/.test(String(key || ''))) return [null];
    const v = clean(value);
    const variants = matcher.valueVariants(key, v);
    const terms = [];
    if (key === 'state') {
      const full = variants.filter((x) => x.length > 3).sort((a, b) => b.length - a.length)[0];
      if (full) terms.push(full);
    }
    if (key === 'country' || key === 'phoneCountryCode') terms.push(variants[0] && /^(usa?|u\.s\.a?\.?)$/i.test(variants[0]) ? 'United States' : v);
    if (key === 'gradMonth') terms.push(variants.find((x) => /^[a-z]{4,}$/i.test(x)) || v);
    terms.push(v);
    // "Bachelor of Science" finds nothing in a list of "Bachelor's Degree"...
    if (key === 'degree') {
      const word = DEGREE_WORDS[matcher.degreeFamily(v)];
      if (word) terms.push(word);
    }
    // Last resort: an empty query lists everything (select2/react-select).
    terms.push('');
    return [...new Set(terms)].filter((t, i) => t !== '' || i > 0);
  }

  /* ------------------------------------------------------------------ */
  /* The dropdown routine                                                 */
  /* ------------------------------------------------------------------ */

  let chain = Promise.resolve();
  let openCount = 0;
  let maxOpen = 0;

  /** Run fn after every earlier fillPopup finished: never two popups at once. */
  function serial(fn) {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  }

  /**
   * Fill one custom dropdown. `spec` describes the widget:
   *   doc, key, value, force
   *   current()        text currently shown, '' when empty / placeholder
   *   open()           press the opener; returns false if refused
   *   popup()          the open listbox element, or null
   *   options(popup)   selectable option elements
   *   loading(popup)   true while results are being fetched (optional)
   *   noResults(popup) true when the popup says "No results" (optional)
   *   search()         input to type a query into, or null (optional)
   *   submitSearch     press Enter after typing (Workday prompts) (optional)
   *   choose(option)   select it (default: press(option)) (optional)
   *   verify(text)     true when the widget now shows `text`
   *   close()          close the popup (Escape etc.)
   * Returns { status: 'filled'|'skipped'|'nomatch'|'unverified'|'failed', confidence }.
   *   'unverified' = tried twice, the value did not stick: outline orange.
   */
  function fillPopup(spec) {
    return serial(() => fillPopupNow(spec));
  }

  async function fillPopupNow(spec) {
    if (!spec.force && spec.current()) return { status: 'skipped' };
    if (spec.value == null || clean(spec.value) === '') return { status: 'nomatch' };

    let last = { status: 'failed' };
    for (let attempt = 0; attempt < 2; attempt++) {
      // The first try's value may have landed late: then do not pick again.
      if (attempt > 0 && spec.current()) return { status: 'unverified', confidence: 0 };
      try {
        last = await attemptOnce(spec);
      } finally {
        await ensureClosed(spec);
      }
      if (last.status === 'filled' || last.status === 'nomatch' || last.status === 'refused') break;
    }
    if (last.status === 'refused') return { status: 'failed' };
    if (last.status === 'failed') return { status: 'unverified', confidence: 0 };
    return last;
  }

  async function attemptOnce(spec) {
    const doc = spec.doc;
    if (!spec.popup()) {
      if (spec.open() === false) return { status: 'refused' };
    }
    const popup = await waitFor(doc, () => spec.popup(), spec.popupTimeout || POPUP_TIMEOUT);
    if (!popup) return { status: 'failed' };
    openCount++;
    maxOpen = Math.max(maxOpen, openCount);

    try {
      const search = spec.search ? spec.search() : null;
      const terms = search ? searchTerms(spec.key, spec.value) : [null];
      let answered = false;
      for (const term of terms) {
        // Prompts that search on Enter do nothing with an empty query.
        if (term === '' && spec.submitSearch) continue;
        if (term != null) {
          typeText(search, term);
          if (spec.submitSearch && term) key(search, 'Enter');
        }
        const found = await waitForChoice(spec);
        if (found && found.pick) {
          const choose = spec.choose || press;
          if (choose(found.pick.el) === false) return { status: 'refused' };
          const ok = await waitFor(doc, () => spec.verify(found.pick.text), VERIFY_TIMEOUT);
          return ok ? { status: 'filled', confidence: found.pick.confidence } : { status: 'failed' };
        }
        if (found) answered = true; // options or "no results": the widget works
      }
      // The popup answered every query, never with an option we accept.
      return answered ? { status: 'nomatch' } : { status: 'failed' };
    } finally {
      openCount--;
    }
  }

  /**
   * Wait until the popup has finished loading, then look for our option.
   * Resolves { pick } on a match, { options: true } if options are shown but
   * none matches (after one more quiet period, in case more are streaming in),
   * { empty: true } on a "no results" notice, or null if nothing ever appeared.
   */
  async function waitForChoice(spec) {
    const doc = spec.doc;
    const look = () => {
      const p = spec.popup();
      if (!p || (spec.loading && spec.loading(p))) return null;
      const opts = spec.options(p);
      if (!opts.length) return spec.noResults && spec.noResults(p) ? { empty: true } : null;
      const pick = chooseOption(opts, spec.key, spec.value);
      return pick ? { pick } : { options: true };
    };
    const first = await waitFor(doc, look, RESULTS_TIMEOUT);
    if (!first || first.pick || first.empty) return first;
    await settle(doc, 150, 1000);
    return look() || first;
  }

  async function ensureClosed(spec) {
    if (!spec.popup()) return;
    spec.close();
    if (await waitFor(spec.doc, () => !spec.popup(), 800)) return;
    pressOutside(spec.doc);
    await waitFor(spec.doc, () => !spec.popup(), 800);
  }

  /** Listboxes present right now; pair with newListbox() to find a portaled popup. */
  function listboxes(doc) {
    return new Set(Array.from(doc.querySelectorAll('[role="listbox"]')));
  }

  function newListbox(doc, before) {
    const all = Array.from(doc.querySelectorAll('[role="listbox"]')).filter((l) => !before.has(l) && isShown(l));
    return all.length ? all[all.length - 1] : null;
  }

  AF.widgets = {
    isSafeTarget,
    press,
    key,
    typeText,
    pressOutside,
    waitFor,
    settle,
    fillPopup,
    chooseOption,
    optionText,
    searchTerms,
    isShown,
    clean,
    listboxes,
    newListbox,
    stats: () => ({ openCount, maxOpen }),
  };

  if (typeof module === 'object' && module.exports) module.exports = AF.widgets;
})(typeof globalThis !== 'undefined' ? globalThis : this);
