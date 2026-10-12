/*
 * adapters/workday.js — Workday application flow (*.myworkdayjobs.com,
 * *.myworkday.com, *.myworkdaysite.com).
 *
 * VERIFIED (2026-10-02) against a real five-step application on one tenant
 * (<company>.wd5.myworkdayjobs.com, fixtures/workday/): My Information, My
 * Experience, Application Questions, Voluntary Disclosures, Review. Every
 * selector below that is marked "seen" was confirmed there; the rest
 * (UNVERIFIED) are Workday conventions we have not seen yet and stay as
 * accelerators with ARIA / label-text fallbacks. Other tenants may differ:
 * add a capture from a second tenant before trusting tenant-specific details.
 *
 * Real markup, in short (details in CLAUDE.md "Workday"):
 *   page body       div[data-automation-id=applyFlow<Step>Page]; the footer
 *                   (Save and Continue / Submit / Back) is OUTSIDE it.
 *   questions       div[data-automation-id=formField-<field>] > label[for] or
 *                   fieldset > legend; controls carry no automation id.
 *                   Application questions: legend > div#rich-label<n> (long
 *                   rich text), formField-<32 hex>.
 *   sections        div[role=group][aria-labelledby=<Name>-section] + h4
 *                   (the id is sometimes missing: then no section).
 *   dropdowns       button[aria-haspopup=listbox] "Select One" (aria-label
 *                   "<Label> <shown> Required"), followed by a value-holding
 *                   input[type=text] that is NOT a field; popup portaled to
 *                   <body>: ul[role=listbox] > li[role=option] (first row a
 *                   disabled "Select One"); aria-controls only while open.
 *   prompts         input[data-uxi-widget-type=selectinput] (no type / role)
 *                   in multiselectInputContainer; type + Enter searches;
 *                   picks show as selectedItem pills. The results popup was
 *                   never captured open: its markup is UNVERIFIED.
 *   checkbox groups fieldset[data-automation-id$=-CheckboxGroup] (grid of
 *                   boxes without a name); question = the outer legend.
 *   radios          fieldset > legend + inputs sharing a name (no radiogroup role).
 *   dates           dateInputWrapper > dateSectionMonth-input / dateSectionYear-input
 *                   (role=spinbutton, no type); education years are year-only.
 *   repeaters       group "Work Experience" > panels "Work Experience <n>" (h5);
 *                   group "Education" > "Education 1" (filled) ... (skipped).
 *   never touched   phone-sms-opt-in (an unlabelled SMS consent box), the
 *                   header language picker, footer, Add / Delete buttons.
 *
 * Detection is by hostname ONLY (a saved page: the URL it was saved from):
 * other career sites (a Phenom site, for one) link to myworkdayjobs.com, so page
 * content is not evidence.
 * Next / Save and Continue / Submit are never pressed (core/widgets.js press()
 * refuses them; they are outside the page body we scan anyway).
 */
(function (root) {
  'use strict';

  const AF = (root.AF = root.AF || {});
  const generic = AF.adapters.generic;
  const widgets = AF.widgets;
  const matcher = AF.matcher;
  const filler = AF.filler;

  const HOSTS = /(^|\.)(myworkdayjobs|myworkday|myworkdaysite)\.com$/;

  // data-automation-id values. "seen" = on the real Workday captures.
  const AID = {
    // seen: MyInfo, MyExp, PrimaryQuestions, VoluntaryDisclosures, Review.
    // UNVERIFIED: SecondaryQuestions, SelfIdentify (not on this tenant).
    pages: {
      applyFlowMyInfoPage: 'myInformation',
      applyFlowMyExpPage: 'myExperience',
      applyFlowPrimaryQuestionsPage: 'applicationQuestions',
      applyFlowSecondaryQuestionsPage: 'applicationQuestions',
      applyFlowVoluntaryDisclosuresPage: 'voluntaryDisclosures',
      applyFlowSelfIdentifyPage: 'selfIdentify',
      applyFlowReviewPage: 'review',
    },
    activeStep: 'progressBarActiveStep', // seen (li > label "current step 1 of 5" + label "<Step>")
    formFieldPrefix: 'formField-', // seen (suffix: field name, 32-hex question id, or empty)
    multiselect: 'multiselectInputContainer', // seen
    selectedItem: 'selectedItem', // seen (pill, div[role=option])
    selectedItemList: 'selectedItemList', // seen (the pills' ul[role=listbox]: never a popup)
    promptOption: 'promptOption', // seen inside pills only; popup rows UNVERIFIED
    promptLeaf: 'promptLeafNode', // UNVERIFIED
    checkboxGroupSuffix: '-CheckboxGroup', // seen
    smsOptIn: 'phone-sms-opt-in', // seen: unlabelled SMS consent box, never touched
    dateMonth: 'dateSectionMonth-input', // seen
    dateDay: 'dateSectionDay-input', // UNVERIFIED (no MM/DD/YYYY date seen)
    dateYear: 'dateSectionYear-input', // seen
    dateWrapper: 'dateInputWrapper', // seen
  };

  // Education 1 fields by formField id (seen): profile keys. firstYearAttended
  // ("From") has no profile key; lastYearAttended is "To (Actual or Expected)".
  const EDU_KEYS = {
    school: 'school',
    degree: 'degree',
    fieldOfStudy: 'major',
    gradeAverage: 'gpa',
    lastYearAttended: 'gradYear',
  };

  // Step names as the progress bar / page heading spell them (label-text fallback).
  const STEP_TEXT = [
    [/\bmy information\b/i, 'myInformation'],
    [/\bmy experience\b/i, 'myExperience'],
    [/\bapplication questions?\b/i, 'applicationQuestions'],
    [/\bvoluntary disclosures?\b/i, 'voluntaryDisclosures'],
    [/\bself[- ]?identify\b|\bdisability\b/i, 'selfIdentify'],
    [/^review$/i, 'review'],
  ];

  // Section headings of repeating blocks (each entry has its own Delete button).
  // seen: "Work Experience" / "Work Experience <n>", "Education", "Websites".
  const REPEATER_HEADING = /^(work experience|experience|education|certifications?|licen[cs]es?|languages?|websites?|training)\b/i;
  const FIRST_EDUCATION = /^education 1$/i; // seen (h5 of the first education panel)
  const PLACEHOLDER_BUTTON = /^(select one|select|choose one|none selected|)$/i; // "Select One" seen

  const aid = (v) => `[data-automation-id="${v}"]`;

  function detect(doc) {
    const loc = doc.location;
    if (loc && loc.protocol !== 'file:') return HOSTS.test(loc.hostname || '');
    // A saved page (file://): the URL it was saved from (capture meta, og:url, canonical).
    const meta = doc.querySelector('meta[name="af-capture-url"], meta[property="og:url"], link[rel="canonical"]');
    const url = meta ? meta.getAttribute('content') || meta.getAttribute('href') : '';
    try {
      return !!url && HOSTS.test(new root.URL(url).hostname);
    } catch (e) {
      return false;
    }
  }

  /** Which step of the apply flow this page is. */
  function step(doc) {
    for (const [id, name] of Object.entries(AID.pages)) {
      if (doc.querySelector(aid(id))) return name;
    }
    const active = doc.querySelector(aid(AID.activeStep));
    const texts = [];
    // "current step 1 of 5" and "My Information" are two labels with no space between.
    if (active) active.querySelectorAll('label').forEach((l) => texts.push(generic.clean(l.textContent)));
    if (active) texts.push(generic.clean(active.textContent).replace(/^.*\bof \d+/i, ''));
    doc.querySelectorAll('h1, h2, h3, [role="heading"]').forEach((h) => texts.push(generic.clean(h.textContent)));
    for (const t of texts) {
      for (const [re, name] of STEP_TEXT) if (re.test(t)) return name;
    }
    return 'unknown';
  }

  /* ------------------------------------------------------------------ */
  /* Structure                                                            */
  /* ------------------------------------------------------------------ */

  // The container's OWN heading: aria-labelledby, or a heading at most two
  // levels down. (A deep querySelector would hand a page wrapper the heading of
  // its first sub-section and make every field look "repeating".)
  function headingOf(container) {
    const doc = container.ownerDocument;
    const by = container.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).filter(Boolean).map((id) => doc.getElementById(id)).filter(Boolean);
      if (t.length) return generic.clean(t.map((n) => n.textContent).join(' '));
    }
    const h = container.querySelector(
      ':scope > :is(h2, h3, h4, legend, [role="heading"]), :scope > * > :is(h2, h3, h4, legend, [role="heading"])'
    );
    return h ? generic.clean(h.textContent) : '';
  }

  /**
   * Inside a repeating block? Its section is titled "Work Experience",
   * "Education", "Websites"..., or the entry itself is numbered
   * ("Work Experience 1"). UNVERIFIED heuristic, see header.
   */
  function isInRepeater(el, stop, memo) {
    // `memo` (optional, one findFields call only): ancestor -> verdict of the walk that
    // starts at that ancestor, so every shared container's heading is read once per scan
    // instead of once per control (the page is not touched between the reads of one scan).
    let result = false;
    const visited = [];
    for (let n = el.parentElement; n && n !== stop; n = n.parentElement) {
      if (memo && memo.has(n)) {
        result = memo.get(n);
        break;
      }
      visited.push(n);
      if (!n.matches('section, fieldset, [role="group"], [data-automation-id]')) continue;
      const h = headingOf(n);
      // The first education entry is filled from the profile (Phase 3).
      // The innermost heading decides, so "Education 1" wins over "Education".
      if (h && FIRST_EDUCATION.test(h)) {
        result = false;
        break;
      }
      if (h && (REPEATER_HEADING.test(h) || /^[A-Za-z ]+ \d+$/.test(h))) {
        result = true;
        break;
      }
    }
    if (memo) for (const n of visited) memo.set(n, result);
    return result;
  }

  /** The question container for a control: formField-* div, else fieldset/group. */
  function questionOf(el) {
    return (
      el.closest(`[data-automation-id^="${AID.formFieldPrefix}"]`) ||
      el.closest('fieldset, [role="group"], [role="radiogroup"]') ||
      el.parentElement
    );
  }

  // generic.textWithoutControls() clones the node to strip form controls. When there are
  // none inside (the usual case: a label or legend of plain rich text, up to ~1,500 chars)
  // the clone's text IS the node's text, so skip the clone.
  const CONTROLS = 'input, textarea, select, option, script, style, button';
  function textOf(node) {
    return node.querySelector(CONTROLS) ? generic.textWithoutControls(node) : generic.clean(node.textContent);
  }

  function questionLabel(el) {
    const doc = el.ownerDocument;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const parts = by.split(/\s+/).filter(Boolean).map((id) => doc.getElementById(id)).filter((n) => n && n !== el);
      const t = generic.clean(parts.map((n) => textOf(n)).join(' '));
      if (t) return t;
    }
    if (el.id) {
      const l = doc.querySelector(`label[for="${el.id.replace(/["\\]/g, '\\$&')}"]`);
      if (l) return textOf(l);
    }
    const q = questionOf(el);
    const l = q && q.querySelector('label, legend');
    if (l && !l.contains(el)) return textOf(l);
    return '';
  }

  function questionRequired(el, label) {
    const q = questionOf(el);
    return (
      el.getAttribute('aria-required') === 'true' ||
      / Required$/.test(el.getAttribute('aria-label') || '') ||
      !!(q && q.querySelector('abbr[title="required"], [aria-required="true"]')) ||
      /\*\s*$|^\s*\*/.test(label)
    );
  }

  /**
   * The section a control sits in: the h4 of its role=group ("Legal Name",
   * "Address", "Education 1"), never the question's own legend. Application
   * questions are their own legends (the relatives question lists "guardian"
   * and "spouse", which as a section would veto it like an emergency contact).
   */
  function sectionOf(el, memo) {
    // `memo` (optional, one findFields call only): ancestor -> section found from it upwards.
    const doc = el.ownerDocument;
    let result = '';
    const visited = [];
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (memo && memo.has(n)) {
        result = memo.get(n);
        break;
      }
      visited.push(n);
      if (n.getAttribute('role') !== 'group' || !n.hasAttribute('aria-labelledby')) continue;
      if (n.getAttribute('data-automation-id') === AID.dateWrapper) continue;
      const t = generic.clean(
        n.getAttribute('aria-labelledby').split(/\s+/).filter(Boolean).map((id) => doc.getElementById(id)).filter(Boolean)
          .map((x) => x.textContent).join(' ')
      );
      if (t) {
        result = t;
        break;
      }
    }
    if (memo) for (const n of visited) memo.set(n, result);
    return result;
  }

  /** formField-<name> of the control's question ('' for application questions' hex ids). */
  function fieldName(el) {
    const f = el.closest(`[data-automation-id^="${AID.formFieldPrefix}"]`);
    const n = f ? f.getAttribute('data-automation-id').slice(AID.formFieldPrefix.length) : '';
    return /^[0-9a-f]{32}$/.test(n) ? '' : n;
  }

  function baseDesc(el, label, headings, inputType, m) {
    const name = fieldName(el);
    const desc = {
      label: label.replace(/\s*\*\s*$/, ''),
      hints: [name, el.getAttribute('name'), el.id].filter((h) => h && !/^[0-9a-f]{32}$/.test(h) && !/--[0-9a-f]{32}$/.test(h)),
      context: sectionOf(el, m && m.sec),
      autocomplete: el.getAttribute('autocomplete') || '',
      inputType,
      required: questionRequired(el, label),
    };
    if (EDU_KEYS[name] && /^education \d+$/i.test(desc.context)) desc.keyHint = EDU_KEYS[name];
    return desc;
  }

  /* ------------------------------------------------------------------ */
  /* Button dropdown                                                      */
  /* ------------------------------------------------------------------ */

  function dropdownField(btn, headings, m) {
    const doc = btn.ownerDocument;
    const label = questionLabel(btn);
    let before = m ? m.listboxes() : widgets.listboxes(doc);

    const current = () => {
      const t = generic.clean(btn.textContent);
      return PLACEHOLDER_BUTTON.test(t) ? '' : t;
    };
    const popup = () => {
      const id = btn.getAttribute('aria-controls') || btn.getAttribute('aria-owns');
      let lb = id ? doc.getElementById(id) : null;
      if (lb && lb.getAttribute('role') !== 'listbox') lb = lb.querySelector('[role="listbox"]');
      if (!lb && btn.getAttribute('aria-expanded') === 'true') lb = widgets.newListbox(doc, before);
      return lb && widgets.isShown(lb) ? lb : null;
    };

    return {
      el: btn,
      revealing: true,
      read: current,
      desc: baseDesc(btn, label, headings, 'select', m),
      fill: (value, ctx) =>
        widgets.fillPopup({
          doc,
          key: ctx.key,
          value,
          force: ctx.force,
          current,
          open: () => {
            before = widgets.listboxes(doc);
            return widgets.press(btn);
          },
          popup,
          options: (lb) =>
            Array.from(lb.querySelectorAll('[role="option"]')).filter((o) => o.getAttribute('aria-disabled') !== 'true'),
          verify: (text) => matcher.normalize(current()) === matcher.normalize(text),
          close: () => {
            const lb = popup();
            widgets.key(lb || btn, 'Escape');
          },
        }),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Multiselect prompt (type to search)                                  */
  /* ------------------------------------------------------------------ */

  function promptField(input, headings, m) {
    const doc = input.ownerDocument;
    const box = input.closest(aid(AID.multiselect)) || questionOf(input);
    const label = questionLabel(input);
    let before = m ? m.listboxes() : widgets.listboxes(doc);

    const pills = () =>
      Array.from(box.querySelectorAll(`${aid(AID.selectedItem)}, [role="listbox"]:not(${aid(AID.selectedItemList)}) [aria-selected="true"]`))
        .map((p) => generic.clean(p.textContent))
        .filter(Boolean);
    const popup = () => {
      const id = input.getAttribute('aria-controls');
      let lb = id ? doc.getElementById(id) : null;
      if (lb && lb.getAttribute('role') !== 'listbox') lb = lb.querySelector('[role="listbox"]');
      if (!lb) lb = widgets.newListbox(doc, before);
      if (lb && lb.matches(aid(AID.selectedItemList))) return null; // the pills, not results
      return lb && widgets.isShown(lb) ? lb : null;
    };

    return {
      el: input,
      markEl: box,
      revealing: true,
      read: () => pills().join(', '),
      desc: baseDesc(input, label, headings, 'select', m),
      fill: (value, ctx) =>
        widgets.fillPopup({
          doc,
          key: ctx.key,
          value,
          force: ctx.force,
          current: () => pills().join(', '),
          open: () => {
            before = widgets.listboxes(doc);
            return widgets.press(input);
          },
          popup,
          // Only leaves are answers; category rows (they have children) are not.
          options: (lb) =>
            Array.from(lb.querySelectorAll(`[role="option"], ${aid(AID.promptOption)}`)).filter(
              (o) =>
                o.getAttribute('aria-disabled') !== 'true' &&
                o.getAttribute('aria-expanded') == null &&
                !o.querySelector('[role="option"]')
            ),
          loading: (lb) => !!lb.querySelector('[data-automation-id="loadingSpinner"], [aria-busy="true"]'),
          search: () => input,
          submitSearch: true,
          verify: (text) => pills().some((p) => matcher.normalize(p) === matcher.normalize(text)),
          close: () => widgets.key(input, 'Escape'),
        }),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Dates                                                                */
  /* ------------------------------------------------------------------ */

  /** "05/2027", "2027-05" (+ optional day) or a bare "2027" -> { month, day, year } */
  function parseDate(value) {
    const v = String(value || '').trim();
    if (/^\d{4}$/.test(v)) return { month: '', day: '', year: v };
    let m = /^(\d{1,2})\/(?:(\d{1,2})\/)?(\d{4})$/.exec(v);
    if (m) return { month: m[1].padStart(2, '0'), day: m[2] ? m[2].padStart(2, '0') : '', year: m[3] };
    m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(v);
    if (m) return { month: m[2], day: m[3] || '', year: m[1] };
    return null;
  }

  // Workday keeps the month unpadded ("3") while showing "03": compare numbers.
  function setSection(input, text) {
    const ok = () => {
      const got = input.value.replace(/\D/g, '');
      return got !== '' && Number(got) === Number(text);
    };
    filler.setNative(input, 'value', text);
    if (ok()) return true;
    // UNVERIFIED live: the Day / Year sections of an MM/DD/YYYY date dropped a value set from script
    // (2026-10-09); type the digits the way the keyboard would.
    filler.setNative(input, 'value', '');
    const view = input.ownerDocument.defaultView;
    try {
      input.focus({ preventScroll: true });
    } catch (e) {
      /* not focusable: the events below still reach it */
    }
    for (const ch of String(text)) {
      const init = { key: ch, code: `Digit${ch}`, keyCode: 48 + Number(ch), which: 48 + Number(ch), bubbles: true, cancelable: true, composed: true };
      input.dispatchEvent(new view.KeyboardEvent('keydown', init));
      input.dispatchEvent(new view.KeyboardEvent('keypress', init));
      filler.setNative(input, 'value', input.value + ch);
      input.dispatchEvent(new view.KeyboardEvent('keyup', init));
    }
    return ok();
  }

  /** Workday date sections: MM / (DD /) YYYY spinbuttons in one wrapper. */
  function dateSectionsField(parts, headings, m) {
    const first = parts.month || parts.year;
    const wrap = first.closest(aid(AID.dateWrapper));
    // The spinbuttons are only labelled "Month" / "Year"; the question is the legend.
    const q = questionOf(first);
    const legend = q && q.querySelector('legend');
    const label = (legend && textOf(legend)) || questionLabel(wrap || first) || questionLabel(first);
    const desc = baseDesc(first, label, headings, 'text', m);
    return {
      el: first,
      markEl: first.closest(aid(AID.dateWrapper)) || questionOf(first),
      desc,
      read: () => [parts.month, parts.day, parts.year].filter(Boolean).map((i) => i.value).filter(Boolean).join('/'),
      fill: async (value, ctx) => {
        // Skipped only when every section has a value: a month alone (Day / Year dropped) is refilled.
        const cur = [parts.month, parts.day, parts.year].filter(Boolean).every((i) => i.value.replace(/\D/g, ''));
        if (cur && !ctx.force) return { status: 'skipped' };
        const d = parseDate(value);
        if (!d || (parts.month && !d.month)) return { status: 'nomatch' };
        let confidence = 1;
        let day = d.day;
        if (parts.day && !day) {
          day = '01'; // profile has month + year only: first of the month, review it
          confidence = 0.6;
        }
        const ok = [
          parts.month ? setSection(parts.month, d.month) : true,
          parts.day ? setSection(parts.day, day) : true,
          parts.year ? setSection(parts.year, d.year) : true,
        ].every(Boolean);
        return ok ? { status: 'filled', confidence } : { status: 'unverified' };
      },
    };
  }

  /** One text input with an MM/YYYY or MM/DD/YYYY mask (placeholder). */
  function maskedDateField(input, headings, m) {
    const mask = (input.getAttribute('placeholder') || '').toUpperCase();
    const label = questionLabel(input);
    return {
      el: input,
      desc: baseDesc(input, label, headings, 'text', m),
      fill: async (value, ctx) => {
        if (input.value.trim() && !ctx.force) return { status: 'skipped' };
        const d = parseDate(value);
        if (!d) return { status: 'nomatch' };
        const needsDay = /DD/.test(mask);
        const text = needsDay ? `${d.month}/${d.day || '01'}/${d.year}` : `${d.month}/${d.year}`;
        filler.setNative(input, 'value', text);
        if (input.value.replace(/\D/g, '') !== text.replace(/\D/g, '')) return { status: 'unverified' };
        return { status: 'filled', confidence: needsDay && !d.day ? 0.6 : 1 };
      },
    };
  }

  function findDateSections(scope) {
    const groups = new Map();
    const sel =
      `${aid(AID.dateMonth)}, ${aid(AID.dateDay)}, ${aid(AID.dateYear)}, ` +
      'input[role="spinbutton"][aria-label*="Month" i], input[role="spinbutton"][aria-label*="Day" i], ' +
      'input[role="spinbutton"][aria-label*="Year" i]';
    for (const input of scope.querySelectorAll(sel)) {
      const wrap = input.closest(aid(AID.dateWrapper)) || input.parentElement.parentElement || input.parentElement;
      const id = `${input.getAttribute('data-automation-id') || ''} ${input.getAttribute('aria-label') || ''}`;
      const part = /month/i.test(id) ? 'month' : /day/i.test(id) ? 'day' : 'year';
      if (!groups.has(wrap)) groups.set(wrap, {});
      groups.get(wrap)[part] = input;
    }
    return groups;
  }

  /* ------------------------------------------------------------------ */
  /* Field discovery                                                      */
  /* ------------------------------------------------------------------ */

  function pageRoot(doc) {
    for (const id of Object.keys(AID.pages)) {
      const n = doc.querySelector(aid(id));
      if (n) return n;
    }
    return doc.querySelector('main, [role="main"]') || doc.body;
  }

  /**
   * ctx (optional) = { seen }: the pass's WeakSet of elements already handled. Fields whose
   * `el` is in it are omitted (decided BEFORE any visibility check / descriptor building);
   * everything else is exactly what findFields(doc) returns. Grouping (radio groups, date
   * sections, checkbox groups, repeater verdicts) is still computed over all elements.
   */
  function findFields(doc, ctx) {
    if (step(doc) === 'review') return []; // nothing to fill on the review page
    const seen = ctx && ctx.seen;
    const isSeen = seen ? (el) => seen.has(el) : () => false;
    const scope = pageRoot(doc);
    const headings = Array.from(scope.querySelectorAll(generic.HEADING_SELECTOR));
    // One scan = one DOM state: per-call memos (never kept between calls, labels can change).
    let beforeSet = null;
    const m = {
      rep: new Map(), // container -> repeater verdict (isInRepeater)
      sec: new Map(), // container -> section text (sectionOf)
      // widgets.listboxes(doc) is the same set for every field of one scan: take it once.
      listboxes: () => beforeSet || (beforeSet = widgets.listboxes(doc)),
    };
    const skipRepeater = (el) => isInRepeater(el, scope, m.rep);

    const dateGroups = findDateSections(scope);
    const dateInputs = new Set();
    dateGroups.forEach((g) => Object.values(g).forEach((i) => dateInputs.add(i)));

    const promptInputs = new Set(
      Array.from(
        scope.querySelectorAll(`${aid(AID.multiselect)} input, input[data-uxi-widget-type="selectinput"]`)
      )
    );

    const maskedDates = Array.from(scope.querySelectorAll('input[type="text"][placeholder], input:not([type])[placeholder]'))
      .filter((i) => /^(MM\/YYYY|MM\/DD\/YYYY)$/i.test((i.getAttribute('placeholder') || '').trim()));
    const maskedSet = new Set(maskedDates);

    // Workday CheckboxGroups: boxes without a name, one question (the legend).
    const groups = Array.from(scope.querySelectorAll(`fieldset[data-automation-id$="${AID.checkboxGroupSuffix}"]`));
    const groupBoxes = new Set();
    groups.forEach((g) => g.querySelectorAll('input[type="checkbox"]').forEach((b) => groupBoxes.add(b)));

    const plain = generic
      .findFields(scope, {
        seen,
        // Cheap set lookups first; the repeater walk (memoized) last.
        skip: (el) =>
          dateInputs.has(el) || promptInputs.has(el) || maskedSet.has(el) || groupBoxes.has(el) ||
          isWidgetInternal(el) || skipRepeater(el),
        overrides: (el) => {
          const o = { context: sectionOf(el, m.sec) };
          const name = fieldName(el);
          if (EDU_KEYS[name] && /^education \d+$/i.test(o.context)) o.keyHint = EDU_KEYS[name];
          return o;
        },
      })
      .filter((f) => !isSeen(f.el))
      .map((f) => {
        // Radios / single boxes: the section, not the question's own legend.
        if (f.desc.inputType === 'radio' || f.desc.inputType === 'checkbox') f.desc.context = sectionOf(f.el, m.sec);
        // Application-question textareas have only the legend as a label (describe() has
        // already read the control's own label: empty means fall back to the question's).
        else if (!f.desc.label) f.desc.label = questionLabel(f.el);
        return f;
      });

    const checkGroups = groups
      .map((g) => Array.from(g.querySelectorAll('input[type="checkbox"]')))
      .filter((boxes) => boxes.length && !isSeen(boxes[0]) && !skipRepeater(boxes[0]))
      .map((boxes) => {
        const outer = boxes[0].closest(`[data-automation-id^="${AID.formFieldPrefix}"]`);
        const legend = outer && outer.querySelector('legend');
        const label = legend ? textOf(legend) : '';
        const f = generic.describeChoice(boxes, headings, {
          label: label.replace(/\s*\*\s*$/, ''),
          context: sectionOf(boxes[0], m.sec),
          inputType: 'checkboxes',
          required: boxes.some((b) => b.getAttribute('aria-required') === 'true') || /\*\s*$/.test(label),
        });
        f.markEl = boxes[0].closest('fieldset');
        return f;
      });

    const dropdowns = Array.from(scope.querySelectorAll('button[aria-haspopup="listbox"]'))
      .filter((b) => !isSeen(b) && !skipRepeater(b) && generic.isVisible(b))
      .map((b) => dropdownField(b, headings, m));

    const prompts = Array.from(promptInputs)
      .filter((i) => !isSeen(i) && !skipRepeater(i) && generic.isVisible(i))
      .map((i) => promptField(i, headings, m));

    const dates = [];
    const outlines = [];
    dateGroups.forEach((parts) => {
      const first = parts.month || parts.year;
      if (!first || isSeen(first) || !generic.isVisible(first)) return;
      const f = dateSectionsField(parts, headings, m);
      if (!skipRepeater(first)) dates.push(f);
      else if (f.desc.required) outlines.push(generic.outlineOnly(f)); // "From*" of a skipped job
    });
    maskedDates
      .filter((i) => !isSeen(i) && !skipRepeater(i) && generic.isVisible(i))
      .forEach((i) => dates.push(maskedDateField(i, headings, m)));

    // Required controls inside skipped repeaters: outline yellow, never fill.
    for (const el of scope.querySelectorAll('input:not([type="hidden"]), textarea, select, button[aria-haspopup="listbox"]')) {
      if (isSeen(el) || dateInputs.has(el) || isWidgetInternal(el) || !skipRepeater(el) || !generic.isVisible(el)) continue;
      if (el.tagName === 'BUTTON') {
        const f = dropdownField(el, headings, m);
        if (f.desc.required) outlines.push(generic.outlineOnly(f));
      } else if (AF.filler.kindOf(el) && el.type !== 'radio' && el.type !== 'checkbox') {
        const f = generic.describe(el, headings);
        if (f.desc.required) outlines.push(generic.outlineOnly(f));
      }
    }

    return generic.inDocumentOrder(plain.concat(checkGroups, dropdowns, prompts, dates, outlines));
  }

  /**
   * Inputs that belong to a widget rather than being a field: the value-holding
   * input[type=text] right after every dropdown button (seen; filling it would
   * type into Workday's widget), and the unlabelled SMS opt-in box (consent).
   */
  function isWidgetInternal(el) {
    if (el.getAttribute('data-automation-id') === AID.smsOptIn) return true;
    const prev = el.previousElementSibling;
    return el.tagName === 'INPUT' && !!prev && prev.matches('button[aria-haspopup="listbox"]');
  }

  /** Close any listbox one of our dropdowns may have left open. */
  async function cleanup(doc) {
    const open = pageRoot(doc).querySelector('button[aria-haspopup="listbox"][aria-expanded="true"]');
    if (open) widgets.key(open, 'Escape');
  }

  AF.adapters = AF.adapters || {};
  /** The review step is empty on purpose: no generic fallback there. */
  function nothingToFill(doc) {
    return step(doc) === 'review';
  }

  AF.adapters.workday = { name: 'workday', detect, step, findFields, cleanup, nothingToFill, AID, isInRepeater };

  if (typeof module === 'object' && module.exports) module.exports = AF.adapters.workday;
})(typeof globalThis !== 'undefined' ? globalThis : this);
