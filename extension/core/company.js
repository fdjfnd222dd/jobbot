/*
 * core/company.js
 *
 * The hiring company, and the {company} placeholder.
 *
 * Many questions repeat across applications with only the company changed:
 * "Have you ever worked at Contoso before?", "Do you have relatives employed by
 * Vandelay Kramer?". Before the Q&A bank is searched, and before learn mode saves,
 * the company's name (and its obvious variants) is replaced with {company}, so
 * one saved answer covers every company. An ANSWER that names the company is
 * stored with the placeholder too and filled back with the current company's
 * name (always outlined orange: read it before you submit).
 *
 * detect(doc) -> Company | null, from (best first):
 *   og:site_name, the logo's alt text, "<Job> at <Company>" / "Careers at
 *   <Company>" / "<Company> Careers" page titles and headers, "You are applying
 *   for ... at <Company>", the hostname (careers.<company>.com, the Workday
 *   tenant <company>.wd5.myworkdayjobs.com, ATS board slugs such as
 *   job-boards.greenhouse.io/<company>).
 *   Company = { name, variants: [normalized], source }
 *     name      short display name ("Acme", "Vandelay Kramer Benes")
 *     variants  normalized spellings that count as the company, longest first
 *
 * Pure apart from detect(); Node tests require() it directly.
 */
(function (root) {
  'use strict';

  const AF = (root.AF = root.AF || {});
  const matcher = AF.matcher || (typeof require === 'function' ? require('./matcher.js') : null);

  const PLACEHOLDER = '{company}';

  // Words that trail a company name and are not part of what people call it.
  const SUFFIX = ['the', 'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'plc', 'corp', 'corporation',
    'co', 'company', 'companies', 'group', 'holdings', 'gmbh', 'ag', 'sa', 'nv', 'bv', 'na', 'us', 'usa',
    'industries', 'technologies', 'technology', 'labs', 'international', 'global', 'worldwide', 'enterprises'];
  const SUFFIX_SET = new Set(SUFFIX);
  // Ordinary words: never a one-word variant on their own (a company called
  // "First Prairie Bank" must not turn every "first" into {company}).
  const COMMON = new Set(('a an and of for in on at to by with from the our your my we you it is are be ' +
    'american national united general global international first capital central southern northern eastern ' +
    'western pacific atlantic federal state city county bank health energy systems solutions services service ' +
    'group data home best new one all work works job jobs career careers apply application talent team people ' +
    'hiring join us usa company corporation inc llc digital tech technology technologies media network labs ' +
    'consulting partners financial insurance foods motors airlines university college school hospital ' +
    'medical care community trust').split(' '));
  // Text around a name in titles / logos that is not the name.
  const NOISE = /\b(careers?|jobs?|job (board|application|openings?|search)|apply( now)?|application|hiring|join( us| our team)?|talent (community|network)|work(ing)? (at|for|with)|opportunit(y|ies)|logo|home( page)?|candidate (home|portal)|recruit(ing|ment)|official site|site)\b/gi;

  // Hosts that belong to an ATS or a generic site, not to the company.
  const ATS_HOST = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|myworkday\.com|myworkdaysite\.com|icims\.com|smartrecruiters\.com|eightfold\.ai|avature\.net|phenompeople\.com|jobvite\.com|taleo\.net|successfactors\.(com|eu)|workable\.com|bamboohr\.com|breezy\.hr|recruitee\.com|jazzhr\.com|applytojob\.com|careerpuck\.com|ultipro\.com|paylocity\.com|adp\.com|oraclecloud\.com|linkedin\.com|indeed\.com)$/;
  // Host labels that are never the company.
  const HOST_NOISE = new Set(['www', 'careers', 'career', 'jobs', 'job', 'apply', 'join', 'work', 'hire', 'hiring',
    'talent', 'recruiting', 'boards', 'job-boards', 'en', 'us', 'app', 'portal', 'candidate', 'external', 'global',
    'localhost', 'com', 'org', 'net', 'io', 'co', 'ai', 'uk', 'de', 'ca', 'jobs2web']);

  /* ------------------------------------------------------------------ */
  /* Names and variants                                                   */
  /* ------------------------------------------------------------------ */

  function clean(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  /** "Contoso LLP Careers | Apply" -> "Contoso LLP"; '' when nothing name-like is left. */
  function cleanName(text) {
    let t = clean(text).replace(NOISE, ' ');
    t = t.replace(/^[\s|,:;\-–—·•]+|[\s|,:;\-–—·•]+$/g, '').replace(/\s+/g, ' ').trim();
    t = t.replace(/^(the )?(at|for|with)\s+/i, '');
    // "Northwind Careers | Northwind" -> "Northwind | Northwind" -> "Northwind".
    const parts = t.split(/\s*[|•·–—]\s*/).filter(Boolean);
    if (parts.length > 1 && parts.every((p) => p.toLowerCase() === parts[0].toLowerCase())) t = parts[0];
    if (!/[A-Za-z]/.test(t) || t.length > 60 || t.split(' ').length > 6) return '';
    return t;
  }

  /** Display form: corporate suffixes and a leading "The" dropped ("The Acme Group, Inc." -> "Acme"). */
  function shortName(name) {
    const words = clean(name).replace(/[,.]+(?=\s|$)/g, '').split(' ').filter(Boolean);
    while (words.length > 1 && SUFFIX_SET.has(words[words.length - 1].toLowerCase())) words.pop();
    while (words.length > 1 && words[0].toLowerCase() === 'the') words.shift();
    return words.join(' ');
  }

  function acronym(tokens) {
    const words = tokens.filter((t) => !SUFFIX_SET.has(t) && !['of', 'and', 'for'].includes(t));
    return words.length >= 3 ? words.map((w) => w[0]).join('') : '';
  }

  /**
   * Normalized spellings that mean this company, longest first.
   * "Vandelay Kramer Benes Inc." -> vandelay kramer benes inc, vandelay kramer benes, vandelay kramer, vkb
   */
  function variantsOf(names) {
    const out = new Set();
    // whole: the name as given ("National Data", "General Health") always counts;
    // shortened forms only when they are not ordinary words.
    const add = (v, whole) => {
      if (!v || v === PLACEHOLDER || v.length < 2) return;
      if (whole) return out.add(v);
      const n = v.split(' ').length;
      if (n === 1 && (v.length < 3 || COMMON.has(v) || SUFFIX_SET.has(v))) return;
      if (n > 1 && v.split(' ').every((w) => COMMON.has(w) || SUFFIX_SET.has(w))) return;
      out.add(v);
    };
    for (const name of [].concat(names || [])) {
      const full = matcher.normalize(name).split(' ').filter(Boolean);
      if (!full.length) continue;
      let toks = full.slice();
      while (toks.length && toks[0] === 'the') toks.shift();
      add(toks.join(' '), true);
      while (toks.length > 1 && SUFFIX_SET.has(toks[toks.length - 1])) toks = toks.slice(0, -1);
      add(toks.join(' '));
      // "Vandelay Kramer Benes" -> "Vandelay Kramer": a name is often cut short, never to one word.
      for (let k = toks.length - 1; k >= 2; k--) add(toks.slice(0, k).join(' '));
      add(acronym(toks));
    }
    return Array.from(out).sort((a, b) => b.length - a.length);
  }

  function make(name, extraVariants, source) {
    const display = shortName(name);
    if (!display) return null;
    const variants = variantsOf([name, display].concat(extraVariants || []));
    if (!variants.length) return null;
    return { name: display, variants, source };
  }

  /* ------------------------------------------------------------------ */
  /* Replacing                                                            */
  /* ------------------------------------------------------------------ */

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  const SUFFIX_ALT = SUFFIX.filter((s) => s !== 'the').join('|');

  // On normalized text: "the acme group inc" / "acmes" -> {company}.
  function normalizedPattern(company) {
    const alt = company.variants.map(escapeRe).join('|');
    return new RegExp(`(?:\\bthe )?\\b(?:${alt})(?: (?:${SUFFIX_ALT})\\b)*s?(?![a-z0-9])`, 'g');
  }

  /**
   * Normalized text with the company replaced by {company}. Always returns
   * normalized text (matcher.normalize keeps the placeholder intact).
   */
  function normalizeText(text, company) {
    const norm = matcher.normalize(text);
    if (!company || !company.variants || !company.variants.length || !norm) return norm;
    return norm.replace(normalizedPattern(company), PLACEHOLDER).replace(/\s+/g, ' ').trim();
  }

  /** desc with label / context in {company} form (unchanged when no company is known). */
  function applyToDesc(desc, company) {
    if (!company) return desc;
    const label = normalizeText(desc.label, company);
    const context = normalizeText(desc.context, company);
    if (label === matcher.normalize(desc.label) && context === matcher.normalize(desc.context)) return desc;
    return { ...desc, label, context, companized: true };
  }

  // On raw text (answers keep their case and punctuation): each variant's words
  // separated by any non-alphanumerics, plus trailing corporate suffixes.
  function rawPattern(company) {
    const alt = company.variants
      .map((v) => v.split(' ').map(escapeRe).join("[^A-Za-z0-9]+"))
      .join('|');
    const suffix = `(?:,?\\s+(?:${SUFFIX_ALT})\\.?(?![A-Za-z0-9]))*`;
    // "Inc." keeps its period inside the match ("Acme Group, Inc.'s" -> "{company}'s").
    const dot = '(?:(?<=\\b(?:inc|corp|co|ltd|llc|llp))\\.)?';
    return new RegExp(`(?:\\b[Tt]he\\s+)?(?<![A-Za-z0-9])(?:${alt})${suffix}${dot}(?![A-Za-z0-9])`, 'gi');
  }

  /** An answer as stored: the company's name replaced by {company} ("I admire {company}'s culture"). */
  function templateAnswer(answer, company) {
    const a = String(answer == null ? '' : answer);
    if (!company || !company.variants || !company.variants.length) return a;
    return a.replace(rawPattern(company), PLACEHOLDER);
  }

  function hasPlaceholder(text) {
    return String(text || '').includes(PLACEHOLDER);
  }

  /** A stored answer for this page: {company} -> the company's name; null when it needs a company we do not know. */
  function renderAnswer(answer, company) {
    const a = String(answer == null ? '' : answer);
    if (!hasPlaceholder(a)) return a;
    if (!company || !company.name) return null;
    return a.split(PLACEHOLDER).join(company.name);
  }

  /** Does normalized `text` mention one of these company names (options-page migration)? */
  function mentions(text, company) {
    if (!company) return false;
    return normalizeText(text, company) !== matcher.normalize(text);
  }

  /* ------------------------------------------------------------------ */
  /* Detection                                                            */
  /* ------------------------------------------------------------------ */

  function hostCandidates(doc) {
    const out = [];
    let url = null;
    const meta = doc.querySelector('meta[name="af-capture-url"]');
    const canon = doc.querySelector('link[rel="canonical"]');
    const og = doc.querySelector('meta[property="og:url"]');
    for (const s of [doc.location && doc.location.protocol !== 'file:' ? doc.location.href : '',
      meta && meta.getAttribute('content'), og && og.getAttribute('content'), canon && canon.getAttribute('href')]) {
      if (!s) continue;
      try {
        url = new root.URL(s);
        if (/^https?:$/.test(url.protocol)) break;
      } catch (e) {
        url = null;
      }
    }
    if (!url || !/^https?:$/.test(url.protocol)) return out;
    const host = url.hostname.toLowerCase();
    const labels = host.split('.');
    const path = url.pathname.split('/').filter(Boolean);
    const wd = /^([a-z0-9-]+)\.wd\d+\.myworkday(jobs|site)?\.com$/.exec(host);
    // Eightfold ?domain=example.com, Greenhouse embeds ?for=tailspin.
    const q = url.searchParams.get('domain') || url.searchParams.get('for') || '';
    if (/^[a-z0-9-]{2,40}(\.[a-z.]{2,10})?$/i.test(q)) out.push({ text: q.toLowerCase().split('.')[0], weight: 2, kind: 'query' });
    if (wd) {
      // Workday: the tenant is usually the company ("acme"), sometimes an
      // abbreviation ("vkb" = Vandelay Kramer Benes): a hint, not a name.
      out.push({ text: wd[1], weight: 1, kind: 'tenant' });
      return out;
    }
    if (ATS_HOST.test(host)) {
      // Board slug: job-boards.greenhouse.io/<company>, jobs.lever.co/<company>,
      // jobs.ashbyhq.com/<company>, jobs.smartrecruiters.com/<Company>.
      const slug = path.find((p) => !/^(embed|job_app|jobs?|en(-\w+)?|apply|careers?)$/i.test(p) && !/^\d+$/.test(p));
      if (slug && /[a-z]/i.test(slug) && slug.length <= 40) out.push({ text: slug.toLowerCase(), weight: 1, kind: 'slug' });
      const sub = labels.length > 2 && !HOST_NOISE.has(labels[0]) && !/^(job-boards|boards|jobs|apply|app|careers)$/.test(labels[0]) ? labels[0] : '';
      if (sub) out.push({ text: sub.replace(/^careers-/, ''), weight: 1, kind: 'slug' });
      return out;
    }
    // careers.contoso.com, apply.careers.example.com, contoso.com/careers: the registrable name.
    const reg = labels.length >= 2 ? labels[labels.length - (/^(co|com|org|net|ac|gov)$/.test(labels[labels.length - 2]) && labels.length > 2 ? 3 : 2)] : '';
    if (reg && !HOST_NOISE.has(reg) && reg !== 'localhost') out.push({ text: reg, weight: 2, kind: 'host' });
    return out;
  }

  function attr(doc, sel, name) {
    const n = doc.querySelector(sel);
    return n ? clean(n.getAttribute(name)) : '';
  }

  /** schema.org JobPosting hiringOrganization.name (Workday, Eightfold, CareerPuck). */
  function jsonLdNames(doc) {
    const out = [];
    const visit = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 6) return;
      if (Array.isArray(o)) return o.forEach((x) => visit(x, depth + 1));
      const org = o.hiringOrganization;
      if (org) out.push(typeof org === 'string' ? org : org.name);
      if (o['@graph']) visit(o['@graph'], depth + 1);
    };
    for (const sc of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        visit(JSON.parse(sc.textContent), 0);
      } catch (e) {
        /* not JSON: ignore */
      }
    }
    return out.filter((n) => typeof n === 'string');
  }

  /**
   * Page text sources, each a raw name candidate. Deliberately NOT the whole
   * body: uploaded resume file names carry the company and the owner's name.
   * What the real captures offer (2026-10-02): JSON-LD on Workday / Eightfold,
   * og:site_name on Avature and company-built sites, "<Job> at <Company>" titles on Greenhouse,
   * "<Company> Logo" alts on Greenhouse boards, "© 2026 Contoso" footers.
   */
  function textCandidates(doc) {
    const out = [];
    const push = (text, weight, kind) => {
      const name = cleanName(text);
      if (name) out.push({ text: name, weight, kind });
    };
    jsonLdNames(doc).forEach((n) => push(n, 5, 'json-ld'));
    push(attr(doc, 'meta[property="og:site_name"]', 'content'), 4, 'og:site_name');
    push(attr(doc, 'meta[name="application-name"]', 'content'), 2, 'application-name');
    const ogTitle = attr(doc, 'meta[property="og:title"]', 'content');
    let m = /\bcareers? at ([A-Z0-9&][^|•·–—:]{1,60})$/i.exec(ogTitle);
    if (m) push(m[1], 3, 'og:title');

    // Logo alt "Globex Industries Logo" (not "Company Logo", " careers home", "Home").
    for (const img of doc.querySelectorAll('img[alt], [role="img"][aria-label]')) {
      const t = clean(img.getAttribute('alt') || img.getAttribute('aria-label'));
      const lm = /^(.{2,60}?)\s+logo$/i.exec(t);
      if (lm && !/^(company|site|brand|our|the|main|header|footer|home)$/i.test(lm[1])) {
        push(lm[1], 3, 'logo');
        break;
      }
    }

    // Titles: "Job Application for X at Globex Industries" (the LAST " at "),
    // "Careers at <Company>", "<Company> Careers", "Confirm application | Initech".
    const title = clean(doc.title);
    m = /.*\bat ([A-Z0-9&][^|•·–—:]{1,60}?)\s*(?:$|[|•·–—:]|\s-\s)/.exec(title);
    if (m) push(m[1], 4, 'title at');
    m = /^\s*([A-Z0-9&][^|•·–—:]{1,60}?)\s+careers?\b/i.exec(title);
    if (m) push(m[1], 3, 'title careers');
    m = /[|•·–—]\s*([^|•·–—]{2,60})$/.exec(title);
    if (m) push(m[1], 2, 'title tail');

    // Header / nav / footer: "Working at Contoso", "Careers at X", "© 2026 Contoso LLP".
    const chrome = Array.from(doc.querySelectorAll('header, nav, footer, [role="banner"], [role="contentinfo"]'))
      .map((n) => clean(n.textContent).slice(0, 2000)).join(' | ');
    m = /\b(?:working|careers?|life|jobs) at ([A-Z0-9&][\w&.']*(?: [A-Z0-9&][\w&.']*){0,3})/.exec(chrome);
    if (m) push(m[1], 2, 'nav at');
    m = /(?:©|\(c\)|copyright)\s*(?:\d{4}\s*[-–]?\s*(?:\d{4})?\s*)?([A-Z0-9&][\w&.']*(?: [A-Z0-9&][\w&.']*){0,3})/i.exec(chrome);
    if (m) push(m[1].replace(/\s+All$/i, ''), 2, 'copyright');

    // "You are applying for <Job> at <Company>."
    const top = doc.querySelector('main, [role="main"], form') || doc.body;
    const text = clean(top ? top.textContent : '').slice(0, 3000);
    m = /\byou are applying (?:for|to) [^.\n]{0,120}? at ([A-Z0-9&][\w&.,' -]{1,60}?)(?:[.!]|\s{2}|$)/.exec(text);
    if (m) push(m[1], 3, 'applying for');
    return out;
  }

  const squash = (s) => matcher.normalize(s).replace(/ /g, '');

  /**
   * The hiring company on this page, or null. Candidates from several sources
   * vote: a text candidate that agrees with the hostname (careers.contoso.com,
   * "globexindustries" = "Globex Industries") wins.
   */
  function detect(doc) {
    let texts = [];
    let hosts = [];
    try {
      texts = textCandidates(doc);
      hosts = hostCandidates(doc);
    } catch (err) {
      return null;
    }
    const agrees = (name, h) => {
      const s = squash(name);
      const toks = matcher.normalize(name).split(' ');
      const t = h.text.replace(/[^a-z0-9]/g, '');
      if (!t || t.length < 2) return false;
      return s === t || s.startsWith(t) || t.startsWith(squash(shortName(name))) || toks.includes(t) || acronym(toks) === t;
    };
    const scored = new Map();
    for (const c of texts) {
      const key = squash(shortName(c.text));
      if (!key) continue;
      const cur = scored.get(key) || { name: c.text, score: 0, sources: [] };
      cur.score += c.weight;
      cur.sources.push(c.kind);
      // The longest spelling wins; at equal length, one with capitals ("northwind logo" alt vs "Northwind Careers").
      const lower = (x) => x === x.toLowerCase();
      if ((c.text.length > cur.name.length || (c.text.length === cur.name.length && lower(cur.name) && !lower(c.text))) &&
        squash(shortName(c.text)) === key) cur.name = c.text;
      scored.set(key, cur);
    }
    for (const cur of scored.values()) {
      for (const h of hosts) if (agrees(cur.name, h)) {
        cur.score += 3;
        cur.sources.push(h.kind);
        cur.hostHint = h.text;
      }
    }
    const ranked = Array.from(scored.values()).sort((a, b) => b.score - a.score);
    const best = ranked[0];
    // One weak text source on its own (a stray "at X" in a header) is not enough.
    if (best && (best.score >= 4 || best.hostHint)) {
      const extra = best.hostHint && best.hostHint.length >= 3 && !/[^a-z0-9]/.test(best.hostHint) ? [best.hostHint] : [];
      return make(best.name, extra, best.sources.join('+'));
    }
    // Nothing on the page names it: the hostname alone ("contoso" -> "Contoso").
    const h = hosts.find((x) => x.kind === 'host' || x.kind === 'tenant') || hosts.find((x) => /^[a-z]{3,}$/.test(x.text));
    if (h && /^[a-z][a-z0-9]{2,}$/.test(h.text) && !COMMON.has(h.text)) {
      return make(h.text[0].toUpperCase() + h.text.slice(1), [], h.kind);
    }
    return null;
  }

  AF.company = {
    PLACEHOLDER,
    detect,
    make,
    variantsOf,
    shortName,
    cleanName,
    normalizeText,
    applyToDesc,
    templateAnswer,
    renderAnswer,
    hasPlaceholder,
    mentions,
  };

  if (typeof module === 'object' && module.exports) module.exports = AF.company;
})(typeof globalThis !== 'undefined' ? globalThis : this);
