/*
 * core/feedback.js
 *
 * Outlines each field after a fill so the user can review at a glance:
 *   green  = filled from a confident match
 *   orange = filled, low confidence: check it
 *   yellow = required, but we had no answer: needs you
 * Each state also has its own line style (solid / dashed / dotted), so colour is
 * not the only cue, and the yellow is a dark amber (#a67c00, 3.8:1 on white;
 * WCAG 1.4.11 asks for 3:1). The panel keeps the bright yellow: it sits on a
 * dark background, where the dark amber would lose contrast.
 *
 * Uses a data attribute plus one injected <style>, so re-running a fill just
 * replaces the attribute, and nothing on the page is restyled permanently.
 *
 * After a pass, a small summary panel (bottom right) says "X filled · Y to
 * review · Z need you". Each count is a button: clicking it scrolls to the
 * next field in that state (again = the next one). Fields to review and fields
 * that need you are also listed by label; clicking one scrolls to it.
 * Scrolling only: the panel never focuses or clicks anything on the page (a
 * focus can open a dropdown), and it holds no form controls, so a later fill
 * pass never sees it. The list is read from the live [data-af-state]
 * elements at click time, so re-rendered pages still work. A second pass
 * replaces the panel. Short messages ("Saved: ...") use notify().
 */
(function (root) {
  'use strict';

  const AF = (root.AF = root.AF || {});
  const ATTR = 'data-af-state';
  const FLASH = 'data-af-flash';
  const STYLE_ID = 'af-feedback-style';
  const TOAST_ID = 'af-feedback-toast';
  const PANEL_ID = 'af-summary';
  const STATES = ['filled', 'review', 'unknown'];
  const MAX_LISTED = 8;

  const CSS = `
    [${ATTR}="filled"]  { outline: 3px solid #2e7d32 !important; outline-offset: 1px !important; }
    [${ATTR}="review"]  { outline: 3px dashed #ef6c00 !important; outline-offset: 1px !important; }
    [${ATTR}="unknown"] { outline: 3px dotted #a67c00 !important; outline-offset: 1px !important; }
    [${FLASH}] { box-shadow: 0 0 0 6px rgba(25, 118, 210, .45) !important; transition: box-shadow .2s !important; }
    #${TOAST_ID} {
      position: fixed; z-index: 2147483647; right: 16px; bottom: 16px;
      background: #212121; color: #fff; font: 14px/1.4 sans-serif;
      padding: 10px 14px; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,.4);
      pointer-events: none; max-width: 420px;
    }
    #${PANEL_ID}, #${PANEL_ID} * { all: initial; box-sizing: border-box; font: 13px/1.4 sans-serif; color: #fff; }
    #${PANEL_ID} {
      display: block; position: fixed; z-index: 2147483647; right: 16px; bottom: 16px; width: 340px;
      max-height: 50vh; overflow: auto; background: #212121; border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,.45); padding: 10px 12px;
    }
    #${PANEL_ID} .af-head { display: flex; gap: 8px; align-items: flex-start; }
    #${PANEL_ID} .af-title { display: block; flex: 1; font-weight: bold; }
    #${PANEL_ID} .af-where { display: block; color: #bbb; margin: 2px 0 0; }
    #${PANEL_ID} button { cursor: pointer; border-radius: 4px; }
    #${PANEL_ID} button:focus-visible { outline: 2px solid #90caf9; }
    #${PANEL_ID} .af-close { padding: 0 6px; font-size: 16px; line-height: 1; color: #bbb; }
    #${PANEL_ID} .af-counts { display: flex; gap: 6px; margin: 8px 0 0; flex-wrap: wrap; }
    #${PANEL_ID} .af-count { display: inline-block; padding: 3px 8px; background: #333; border-left: 4px solid #888; }
    #${PANEL_ID} .af-count[disabled] { cursor: default; opacity: .55; }
    #${PANEL_ID} .af-count.af-filled, #${PANEL_ID} .af-item.af-filled { border-left-color: #2e7d32; }
    #${PANEL_ID} .af-count.af-review, #${PANEL_ID} .af-item.af-review { border-left-color: #ef6c00; }
    #${PANEL_ID} .af-count.af-unknown, #${PANEL_ID} .af-item.af-unknown { border-left-color: #fbc02d; }
    #${PANEL_ID} .af-list { display: block; margin: 8px 0 0; }
    #${PANEL_ID} .af-item { display: block; width: 100%; text-align: left; padding: 3px 8px; margin: 3px 0 0;
      background: #2c2c2c; border-left: 4px solid #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #${PANEL_ID} .af-more { display: block; color: #bbb; margin: 4px 0 0; }`;

  // markEl -> the field's label, for the panel's list (no page attribute needed).
  let labels = new WeakMap();

  function ensureStyle(doc) {
    const old = doc.getElementById(STYLE_ID);
    if (old && old.textContent === CSS) return;
    if (old) old.remove();
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  function clear(doc) {
    doc.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));
    const panel = doc.getElementById(PANEL_ID);
    if (panel) panel.remove();
    labels = new WeakMap();
  }

  function mark(el, state, label) {
    if (state) el.setAttribute(ATTR, state);
    else el.removeAttribute(ATTR);
    if (state && label) labels.set(el, String(label).replace(/\s+/g, ' ').trim());
  }

  /** One short message in the corner, replacing any earlier one (above the panel, if shown). */
  function notify(doc, text, ms) {
    const old = doc.getElementById(TOAST_ID);
    if (old) old.remove();
    ensureStyle(doc);
    const box = doc.createElement('div');
    box.id = TOAST_ID;
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    box.textContent = text;
    const panel = doc.getElementById(PANEL_ID);
    if (panel) box.style.setProperty('bottom', `${panel.getBoundingClientRect().height + 24}px`, 'important');
    doc.body.appendChild(box);
    root.setTimeout(() => box.remove(), ms || 5000);
  }

  /* ------------------------------------------------------------------ */
  /* Summary panel                                                        */
  /* ------------------------------------------------------------------ */

  function visible(el) {
    return el.isConnected && el.getClientRects().length > 0;
  }

  /** Marked elements in a state, in document order, as they are NOW. */
  function marked(doc, state) {
    return Array.from(doc.querySelectorAll(`[${ATTR}="${state}"]`)).filter(visible);
  }

  // Scroll only. No focus(), no click(): both can open popups or trigger page code.
  function reveal(el) {
    try {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (e) {
      el.scrollIntoView();
    }
    el.setAttribute(FLASH, '');
    root.setTimeout(() => el.removeAttribute(FLASH), 1600);
  }

  function labelOf(el) {
    return labels.get(el) || '(unlabelled field)';
  }

  function button(doc, cls, text) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    return b;
  }

  /**
   * summary(doc, { counts, profileName, companyName, where, frames })
   *   counts  what the pass (or the page + its frames) did
   *   where   extra line ("in the embedded job-boards.greenhouse.io form")
   *   frames  [url]: embedded application frames filled in place; a count
   *           with nothing marked on this page scrolls to the frame instead
   */
  function summary(doc, info) {
    const i = info || {};
    const counts = i.counts || { filled: 0, review: 0, unknown: 0 };
    ensureStyle(doc);
    const oldToast = doc.getElementById(TOAST_ID);
    if (oldToast) oldToast.remove();
    const old = doc.getElementById(PANEL_ID);
    if (old) old.remove();

    const panel = doc.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Formhand summary');

    const head = doc.createElement('div');
    head.className = 'af-head';
    const title = doc.createElement('span');
    title.className = 'af-title';
    title.setAttribute('role', 'status');
    const who = i.profileName ? ` (${i.profileName})` : '';
    const at = i.companyName ? ` at ${i.companyName}` : '';
    title.textContent = `Formhand${who}${at}: ${counts.filled} filled · ${counts.review} to review · ${counts.unknown} need you` +
      (i.where ? ` (${i.where})` : '');
    const close = button(doc, 'af-close', '×');
    close.setAttribute('aria-label', 'Close the autofill summary');
    close.addEventListener('click', () => panel.remove());
    head.append(title, close);
    panel.appendChild(head);

    const frameEls = () => (i.frames || []).map((url) => Array.from(doc.querySelectorAll('iframe[src]'))
      .find((f) => { try { return new root.URL(f.getAttribute('src'), doc.baseURI).href === url; } catch (e) { return false; } }))
      .filter(Boolean);

    const row = doc.createElement('div');
    row.className = 'af-counts';
    const names = { filled: 'filled', review: 'to review', unknown: 'need you' };
    for (const state of STATES) {
      const b = button(doc, `af-count af-${state}`, `${counts[state]} ${names[state]}`);
      b.title = 'Scroll to the next one';
      if (!counts[state]) b.disabled = true;
      let next = 0;
      b.addEventListener('click', () => {
        const els = marked(doc, state);
        if (!els.length) {
          const f = frameEls()[0];
          if (f) reveal(f);
          return;
        }
        if (next >= els.length) next = 0;
        reveal(els[next]);
        b.textContent = `${counts[state]} ${names[state]} (${next + 1}/${els.length})`;
        next++;
      });
      row.appendChild(b);
    }
    panel.appendChild(row);

    // What still needs the owner, by label: review first, then unknown.
    const todo = [...marked(doc, 'review').map((el) => ['review', el]), ...marked(doc, 'unknown').map((el) => ['unknown', el])];
    if (todo.length) {
      const list = doc.createElement('div');
      list.className = 'af-list';
      for (const [state, el] of todo.slice(0, MAX_LISTED)) {
        const item = button(doc, `af-item af-${state}`, labelOf(el));
        item.title = (state === 'review' ? 'Check: ' : 'Needs you: ') + labelOf(el);
        item.addEventListener('click', () => {
          if (el.isConnected) return reveal(el);
          // Re-rendered since: the same position among the live ones.
          const live = marked(doc, state);
          if (live.length) reveal(live[0]);
        });
        list.appendChild(item);
      }
      if (todo.length > MAX_LISTED) {
        const more = doc.createElement('span');
        more.className = 'af-more';
        more.textContent = `and ${todo.length - MAX_LISTED} more: use the counts above to step through them`;
        list.appendChild(more);
      }
      panel.appendChild(list);
    }
    doc.body.appendChild(panel);
    return panel;
  }

  // The profile name is shown on purpose: a cheap guard against applying with
  // the wrong address. The detected company too: {company} answers use it.
  // `where` (optional): "in the embedded job-boards.greenhouse.io form".
  function toast(doc, counts, profileName, companyName, where, frames) {
    return summary(doc, { counts, profileName, companyName, where, frames });
  }

  AF.feedback = { ATTR, PANEL_ID, TOAST_ID, ensureStyle, clear, mark, toast, summary, notify };

  if (typeof module === 'object' && module.exports) module.exports = AF.feedback;
})(typeof globalThis !== 'undefined' ? globalThis : this);
