/*
 * core/qa.js
 *
 * The Q&A bank: answers the owner gave to questions that are not profile
 * fields ("How did you hear about us?", "Desired salary", custom yes/no
 * questions). Entries come from learn mode (core/learn.js), the options page
 * and imports. Shared by every profile.
 *
 *   QAEntry = { id, question, aliases: [], answer, sensitive, createdAt, updatedAt }
 *   question / aliases are stored normalized (matcher.normalize).
 *
 * lookup(desc, entries) decides whether an entry answers a field:
 *   exact     normalized label equals the question or an alias       -> 1.0
 *   fuzzy     token overlap (Dice) >= FUZZY_MIN                       -> sim x 0.85
 * Sensitive questions (SPEC.md: work authorization, sponsorship,
 * relationships with employees, prior employment, criminal/background, EEO)
 * are classified from the PAGE's question as well as the stored flag, so a
 * harmless entry can never fuzzy-match its way onto a sensitive question:
 *   EEO                 exact only
 *   other sensitive     exact, or similarity >= SENSITIVE_MIN (near-identical wording)
 * Labels that hit the matcher's "someone else's data" veto (relatives,
 * employer...) are exact-only too. Consent / agreement / signature fields are
 * never answered or learned from the bank at all.
 */
(function (root) {
  'use strict';

  const AF = (root.AF = root.AF || {});
  const matcher = AF.matcher || (typeof require === 'function' ? require('./matcher.js') : null);

  const FUZZY_MIN = 0.75;
  const SENSITIVE_MIN = 0.95;
  const FUZZY_WEIGHT = 0.85;

  const SHORT_TOKENS = 5;

  const CATEGORIES = [
    { id: '', label: 'Not sensitive' },
    { id: 'work-authorization', label: 'Work authorization' },
    { id: 'sponsorship', label: 'Sponsorship / visa' },
    { id: 'relationships', label: 'Relationships with employees' },
    { id: 'prior-employment', label: 'Prior employment' },
    { id: 'background', label: 'Criminal / background' },
    { id: 'eeo', label: 'EEO / self-identification' },
  ];

  // Checked in order against the normalized question (and its section context
  // for EEO, whose questions are often just "Please check one of the boxes").
  const SENSITIVE = [
    ['eeo', /\b(gender|sex|race|racial|ethnicit\w*|hispanic|latin[oax]|veteran|disabilit\w*|disabled|sexual orientation|transgender|pronouns?|self identif\w*|equal (employment )?opportunity|eeo)\b/],
    ['sponsorship', /\b(sponsor\w*|visa|h ?1 ?b|immigration|green card|citizenship|citizen)\b/],
    ['work-authorization', /\b(authori[sz]\w*|eligib\w*|permitted|right) to work\b|\bwork (authori[sz]ation|permit)\b/],
    ['relationships', /\b(relatives?|related|family|spouse|partner|friends?|know anyone|relationship)\b/],
    ['prior-employment', /\b(previously|formerly|ever|prior|past|former|previous)\b.*\b(employ\w*|work\w*|intern\w*|contract\w*)\b|\bnon ?compete\b|\b(currently )?employed by\b/],
    ['background', /\b(criminal|convict\w*|felon\w*|misdemeanor|arrest\w*|background check|drug (test|screen)|plead\w* guilty|offen[cs]e)\b/],
  ];
  const EEO_CONTEXT = /\b(self identif\w*|voluntary (self )?(identification|disclosures?)|equal (employment )?opportunity|eeo|disability|veteran|demographic)\b/;

  // Consent, agreement, attestation and signatures: never learned, never filled
  // from the bank. (The one deliberate exception is the owner's own "Privacy /
  // data transfer acknowledgment" standard answer, see core/standard.js.)
  // Also authorizations / permissions ("I authorize a background check", "I give
  // permission to contact my references"), declarations ("I declare that the above
  // is true", "I hereby ..."), opt-ins (SMS, job alerts, talent community).
  // "Certification" alone is a credential question ("Do you have a PMP
  // certification?"), not an attestation: only "I certify" / "certifies" count.
  const CONSENT = /\b(i )?(agree|consent\w*|acknowledg\w*|certif(y|ies)|attest\w*|accept)\b|\bterms (and|of)\b|\bprivacy (policy|notice|statement)\b|\bsignature\b|\be ?sign\w*\b|\bsign (here|below)\b|\binitials?\b|\bi (have read|understand)\b|\b(i |we )?(authori[sz]e|give (my )?permission|grant permission|hereby|declare|i confirm)\b|\bopt ?(in|out)\b|\b(i would like to|sign me up to|add me to|subscribe)\b.*\b(receive|alerts?|texts?|sms|newsletters?|community|updates)\b|\btalent (community|network|pool)\b/;

  const STOP = new Set(
    ('a an the you your yours do does did are is am was were be been being have has had of to in for on at by as ' +
      'this that these those with or and if will would can could should please i we our us me my any it its ' +
      'what which who how').split(' ')
  );

  function tokens(norm) {
    return Array.from(new Set(String(norm || '').split(' ').filter((t) => t && !STOP.has(t))));
  }

  /** Dice coefficient over content-word sets: 1 = same words. */
  function similarity(a, b) {
    const ta = tokens(a);
    const tb = tokens(b);
    if (!ta.length || !tb.length) return 0;
    const sb = new Set(tb);
    const common = ta.filter((t) => sb.has(t)).length;
    return (2 * common) / (ta.length + tb.length);
  }

  /** '' or the sensitive category of a question (normalized or raw). */
  function sensitiveCategory(question, context) {
    const q = matcher.normalize(question);
    for (const [cat, re] of SENSITIVE) if (re.test(q)) return cat;
    if (context && EEO_CONTEXT.test(matcher.normalize(context))) return 'eeo';
    return '';
  }

  function isConsent(question) {
    return CONSENT.test(matcher.normalize(question));
  }

  /**
   * Bank entry for a field, or null.
   * desc: the field with the hiring company already replaced by {company}
   * (core/company.js applyToDesc); raw: the field as written, when different.
   * An exact match on either counts (entries learned before {company} existed
   * still name the company). Vetoes read the label as written: "{company}"
   * itself must not trip the "company / employer" veto.
   * Resolves { entry, confidence, source: 'qa-exact' | 'qa-fuzzy' }.
   */
  function lookup(desc, entries, raw) {
    const asWritten = raw || desc;
    const q = matcher.normalize(desc.label);
    if (!q || !entries || !entries.length) return null;
    if (isConsent(q) || isConsent(asWritten.label)) return null;
    if (matcher.isVetoed(asWritten, 'context')) return null;

    const rq = matcher.normalize(asWritten.label);
    const has = (e, t) => e.question === t || (e.aliases || []).includes(t);
    const exact = entries.find((e) => has(e, q)) || (rq !== q ? entries.find((e) => has(e, rq)) : null);
    if (exact) return { entry: exact, confidence: 1, source: 'qa-exact' };

    const pageCat = sensitiveCategory(asWritten.label, asWritten.context) || sensitiveCategory(q, desc.context);
    if (pageCat === 'eeo') return null;
    if (matcher.isVetoed(asWritten, 'label')) return null;
    if (tokens(q).length < 2) return null; // one word is too little to fuzzy-match

    // Short questions differ by their subject: "years of experience with Python"
    // vs "... with Java" share 3 of 4 content words (0.75). With 5 or fewer content
    // words on either side, an added or dropped word may pass, a swapped one never.
    const qt = tokens(q);
    const swapped = (text) => {
      const tt = tokens(text);
      if (Math.min(qt.length, tt.length) > SHORT_TOKENS) return false;
      return qt.some((t) => !tt.includes(t)) && tt.some((t) => !qt.includes(t));
    };
    const scored = [];
    for (const e of entries) {
      let sim = 0;
      for (const text of [e.question, ...(e.aliases || [])]) {
        const s = swapped(text) ? 0 : similarity(q, text);
        if (s > sim) sim = s;
      }
      const cat = pageCat || e.sensitive || sensitiveCategory(e.question);
      if (cat === 'eeo') continue;
      if (sim >= (cat ? SENSITIVE_MIN : FUZZY_MIN)) scored.push({ e, sim });
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.sim - a.sim);
    const [best, next] = scored;
    // Two different answers nearly tied: we cannot tell which question this is.
    if (next && best.sim - next.sim < 0.05 && matcher.normalize(next.e.answer) !== matcher.normalize(best.e.answer)) {
      return null;
    }
    return { entry: best.e, confidence: best.sim * FUZZY_WEIGHT, source: 'qa-fuzzy' };
  }

  function newId() {
    return 'qa-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /**
   * Add or update the entry for `question` (raw text). Returns
   * { entries, entry, created }. The answer is stored as typed/shown.
   */
  function learn(entries, question, answer, context) {
    const q = matcher.normalize(question); // keeps a {company} placeholder
    const now = Date.now();
    const list = (entries || []).slice();
    const i = list.findIndex((e) => e.question === q || (e.aliases || []).includes(q));
    if (i >= 0) {
      list[i] = { ...list[i], answer: String(answer), updatedAt: now };
      return { entries: list, entry: list[i], created: false };
    }
    const entry = {
      id: newId(),
      question: q,
      aliases: [],
      answer: String(answer),
      sensitive: sensitiveCategory(q, context),
      createdAt: now,
      updatedAt: now,
    };
    list.push(entry);
    return { entries: list, entry, created: true };
  }

  /* ------------------------------------------------------------------ */
  /* {company} migration (options page)                                   */
  /* ------------------------------------------------------------------ */

  const companyLib = () => AF.company || (typeof require === 'function' ? require('./company.js') : null);

  /**
   * Entries learned before {company} existed may name a company ("have you
   * ever worked at acme before"). For the given company names, what turning
   * each such entry into the {company} form would do:
   *   [{ id, from: { question, aliases, answer }, to: { question, aliases, answer },
   *      company, mergeInto?: id, conflict?: true }]
   * mergeInto: another entry already asks the converted question with the same
   * answer (the two become one). conflict: it asks it with a DIFFERENT answer
   * (left alone: the owner decides by editing one of them).
   */
  function companyConversions(entries, companyNames) {
    const lib = companyLib();
    const companies = (companyNames || []).map((n) => lib.make(n, [], 'options')).filter(Boolean);
    const list = entries || [];
    const out = [];
    const target = new Map(); // converted question -> conversion already planned in this batch
    for (const e of list) {
      let to = { question: e.question, aliases: (e.aliases || []).slice(), answer: e.answer };
      let hit = null;
      for (const co of companies) {
        const question = lib.normalizeText(to.question, co);
        const aliases = to.aliases.map((a) => lib.normalizeText(a, co));
        const answer = lib.templateAnswer(to.answer, co);
        if (question !== to.question || answer !== to.answer || aliases.join('|') !== to.aliases.join('|')) {
          to = { question, aliases: [...new Set(aliases)].filter((a) => a !== question), answer };
          hit = hit || co.name;
        }
      }
      if (!hit) continue;
      const conv = { id: e.id, from: { question: e.question, aliases: e.aliases || [], answer: e.answer }, to, company: hit };
      const same = (a, b) => matcher.normalize(a) === matcher.normalize(b);
      const other = list.find((x) => x.id !== e.id && (x.question === to.question || (x.aliases || []).includes(to.question)));
      const planned = target.get(to.question);
      const into = other ? { id: other.id, answer: other.answer } : planned ? { id: planned.id, answer: planned.to.answer } : null;
      if (into) {
        if (same(into.answer, to.answer)) conv.mergeInto = into.id;
        else conv.conflict = true;
      } else {
        target.set(to.question, conv);
      }
      out.push(conv);
    }
    return out;
  }

  /** entries after applying the conversions listed in ids (fresh entries in, see storage.updateQA). */
  function applyCompanyConversions(entries, companyNames, ids) {
    const want = new Set(ids || []);
    let list = (entries || []).slice();
    const now = Date.now();
    for (const c of companyConversions(list, companyNames)) {
      if (!want.has(c.id) || c.conflict) continue;
      if (c.mergeInto) {
        const i = list.findIndex((x) => x.id === c.mergeInto);
        if (i < 0) continue;
        const aliases = [...new Set([...(list[i].aliases || []), ...c.to.aliases])].filter((a) => a !== list[i].question);
        list[i] = { ...list[i], aliases, updatedAt: now };
        list = list.filter((x) => x.id !== c.id);
      } else {
        list = list.map((x) => (x.id === c.id ? { ...x, ...c.to, updatedAt: now } : x));
      }
    }
    return list;
  }

  AF.qa = {
    CATEGORIES,
    FUZZY_MIN,
    SENSITIVE_MIN,
    similarity,
    tokens,
    sensitiveCategory,
    isConsent,
    lookup,
    learn,
    companyConversions,
    applyCompanyConversions,
  };

  if (typeof module === 'object' && module.exports) module.exports = AF.qa;
})(typeof globalThis !== 'undefined' ? globalThis : this);
