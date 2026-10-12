'use strict';
/*
 * `jobctl posting <url>`: read a posting straight from its ATS's public JSON API (no browser tab) and
 * pull out what the /apply gate needs in one go: pay (normalised to $/hour), how old the posting is,
 * location / work mode, term, and red flags (clearance, a required skill on the DO NOT CLAIM list,
 * grad-date window, AI-use limits). Before this, every posting took a hand-written curl + regex pass.
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./paths');
const U = require('./urls');

const get = async (url, init) => {
  const res = await fetch(url, { ...(init || {}), headers: { 'user-agent': 'Mozilla/5.0 jobbot', ...((init && init.headers) || {}) } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
};
/** A page's HTML (redirects followed, 20 s cap): for readers that parse what the server sends, never a tab. */
const getText = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 jobbot', accept: 'text/html' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
};
const strip = (html) =>
  String(html || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&[mn]dash;/g, '-')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Which API to ask, from the link. */
function locate(url) {
  const u = new URL(U.unwrap(url));
  const host = u.hostname;
  const gh = u.searchParams.get('gh_jid') || u.searchParams.get('token') || (u.pathname.match(/\/jobs\/(\d+)/) || [])[1];
  const board = u.searchParams.get('for') || (host.endsWith('greenhouse.io') ? u.pathname.split('/')[1] : null);
  if (gh && board && board !== 'embed') return { ats: 'greenhouse', board, id: gh };
  // A company careers site wrapping Greenhouse (?gh_jid=ID only): the board is usually the company
  // part of the host (lindenstonecareers.com -> lindenstone, careers.withwaymo.com -> cedarwick).
  if (u.searchParams.get('gh_jid')) {
    const name = host.replace(/^(www|careers|jobs)\./, '').split('.')[0].replace(/^with/, '').replace(/(careers|jobs)$/, '');
    return { ats: 'greenhouse', board: name, id: u.searchParams.get('gh_jid'), guessedBoard: true };
  }
  let m = host === 'jobs.ashbyhq.com' && u.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/i);
  if (m) return { ats: 'ashby', board: m[1], id: m[2] };
  m = /lever\.co$/.test(host) && u.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/i);
  if (m) return { ats: 'lever', board: m[1], id: m[2] };
  m = host.match(/^([^.]+)\.(wd\d+)\.myworkdayjobs\.com$/);
  if (m) {
    const parts = u.pathname.split('/').filter(Boolean).filter((p) => !/^[a-z]{2}-[A-Z]{2}$/.test(p));
    return { ats: 'workday', tenant: m[1], wd: m[2], site: parts[0], path: '/' + parts.slice(1).join('/') };
  }
  m = host.match(/^([^.]+)\.recruitee\.com$/);
  if (m && u.pathname.match(/^\/o\/([^/]+)/)) return { ats: 'recruitee', board: m[1], id: u.pathname.match(/^\/o\/([^/]+)/)[1] };
  // Oracle Recruiting Cloud: .../hcmUI/CandidateExperience/<lang>/sites/<site>/job/<id> (also .../requisitions/preview/<id>).
  m = u.pathname.match(/\/hcmUI\/CandidateExperience\/[^/]+\/sites\/([^/]+)\/(?:job|requisitions\/preview)\/(\d+)/);
  if (m) return { ats: 'oracle', host, site: m[1], id: m[2], page: u.origin + u.pathname };
  return { ats: U.atsOf(url) };
}

/**
 * Oracle Recruiting Cloud's public REST detail (no tab; 2026-10-09 the Fernhaven posting needed `jobctl jd` + a text file).
 * The finder wants the site NUMBER (CX_1001); a link can carry the site's name instead ("careers"), so the number is
 * read from the job page's HTML, which names it in its favicon links.
 */
async function oraclePosting(at, fetchJson = get, fetchText = getText) {
  let site = /^CX(_\d+)?$/i.test(at.site) ? at.site : null;
  let html = '';
  if (!site) {
    html = await fetchText(at.page);
    site = (html.match(/siteNumber=(CX(?:_\d+)?)\b/) || [])[1];
    if (!site) throw new Error(`oracle: no siteNumber on ${at.page}: use \`jobctl jd <url>\``);
  }
  const d = await fetchJson(`https://${at.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${at.id}%22,siteNumber=${site}`, { headers: { accept: 'application/json' } });
  const i = (d.items || [])[0];
  if (!i) throw new Error('posting not on the site any more (closed?)');
  const parts = ['ExternalDescriptionStr', 'ExternalResponsibilitiesStr', 'ExternalQualificationsStr', 'CorporateDescriptionStr', 'OrganizationDescriptionStr'].map((k) => strip(i[k])).filter(Boolean);
  const title = (html.match(/<title>([^<|]+)/) || [])[1];
  const company = title ? title.replace(/\b(careers?|jobs?|job search|candidate experience)\b/gi, '').replace(/[-–|:]+\s*$/, '').trim() : '';
  return { ...at, siteNumber: site, company: company || null, title: i.Title, location: [i.PrimaryLocation].concat((i.secondaryLocations || []).map((x) => x.Name || x.LocationName || x)).filter((x) => typeof x === 'string' && x).join('; '), workplace: i.WorkplaceType || null, posted: i.ExternalPostedStartDate || '', text: [...new Set(parts)].join(' ') };
}

/**
 * Any page that carries schema.org JobPosting JSON-LD (iCIMS career sites such as careers.ironfield.edu, and most
 * custom career sites: Google for Jobs needs it). Title, company, date, location, description and pay when stated.
 */
function jsonLdPosting(html, url, now) {
  const items = [];
  for (const m of String(html).matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let d;
    try {
      d = JSON.parse(m[1].trim());
    } catch (e) {
      continue;
    }
    for (const x of [].concat(d).flatMap((y) => (y && y['@graph'] ? y['@graph'] : [y]))) if (x && /JobPosting/.test([].concat(x['@type']).join(' '))) items.push(x);
  }
  const j = items[0];
  if (!j) return null;
  const place = [].concat(j.jobLocation || []).map((l) => (l && l.address) || {}).map((a) => [a.addressLocality, a.addressRegion].filter(Boolean).join(', ')).filter(Boolean);
  const v = (j.baseSalary && j.baseSalary.value) || {};
  const lo = Number(v.minValue || v.value || 0);
  const hi = Number(v.maxValue || v.value || 0);
  const unit = String(v.unitText || '').toLowerCase();
  const pay = lo > 0 ? ` Pay: $${lo} - $${hi || lo} per ${/hour/.test(unit) ? 'hour' : /month/.test(unit) ? 'month' : /week/.test(unit) ? 'week' : 'year'}.` : '';
  const text = ['description', 'responsibilities', 'qualifications', 'skills', 'educationRequirements'].map((k) => (typeof j[k] === 'string' ? strip(j[k]) : '')).filter(Boolean);
  const org = j.hiringOrganization && (typeof j.hiringOrganization === 'string' ? j.hiringOrganization : j.hiringOrganization.name);
  const remote = /TELECOMMUTE/i.test(String(j.jobLocationType || ''));
  return { ats: U.atsOf(url), via: 'json-ld', company: org || null, title: strip(j.title), location: place.join('; '), workplace: remote ? 'Remote' : null, posted: placeholderDate(j.datePosted, now) ? '' : j.datePosted || '', text: [...new Set(text)].join(' ') + pay };
}

/**
 * iCIMS sites that hide the posting date stamp JSON-LD datePosted with "now minus 2 years" (to the second, and
 * validThrough = now + 1 year). Taken at face value every such posting reads 730 d old and is skipped as stale,
 * so a date within a few hours of exactly 1-3 whole years ago counts as no date (the feed's age is kept).
 */
function placeholderDate(posted, now) {
  const t = Date.parse(posted || '');
  if (!Number.isFinite(t)) return false;
  const n = now || Date.now();
  for (let y = 1; y <= 3; y++) {
    const d = new Date(n);
    d.setUTCFullYear(d.getUTCFullYear() - y);
    if (Math.abs(d.getTime() - t) < 6 * 3600000) return true;
  }
  return false;
}

async function fetchPosting(url) {
  const at = locate(url);
  if (at.ats === 'greenhouse') {
    const d = await get(`https://boards-api.greenhouse.io/v1/boards/${at.board}/jobs/${at.id}?pay_transparency=true`);
    const per = (u) => (/hour/i.test(u || '') ? 'per hour' : /month/i.test(u || '') ? 'per month' : 'per year');
    const pay = (d.pay_input_ranges || []).map((r) => `$${r.min_cents / 100} - $${r.max_cents / 100} ${per(r.unit)}`).join('; ');
    return { ...at, company: d.company_name || at.board, title: d.title, location: (d.location || {}).name || '', posted: d.first_published || d.updated_at, text: strip(d.content) + (pay ? ` Pay: ${pay}.` : '') };
  }
  if (at.ats === 'ashby') {
    const d = await get(`https://api.ashbyhq.com/posting-api/job-board/${at.board}?includeCompensation=true`);
    const j = (d.jobs || []).find((x) => x.id === at.id || (x.jobUrl || '').includes(at.id));
    if (!j) throw new Error('posting not on the board any more (closed?)');
    const comp = (j.compensation || {}).compensationTierSummary;
    return { ...at, company: at.board, title: j.title, location: [j.location].concat((j.secondaryLocations || []).map((x) => x.location || x)).join('; '), workplace: j.workplaceType, posted: j.publishedAt, text: strip(j.descriptionHtml || j.descriptionPlain) + (comp ? ` Pay: ${comp}.` : '') };
  }
  if (at.ats === 'lever') {
    const j = await get(`https://api.lever.co/v0/postings/${at.board}/${at.id}`);
    const lists = (j.lists || []).map((l) => `${l.text}: ${strip(l.content)}`).join(' ');
    const sal = j.salaryRange ? ` Pay: $${j.salaryRange.min} - $${j.salaryRange.max} ${/hour/i.test(j.salaryRange.interval || '') ? 'per hour' : /month/i.test(j.salaryRange.interval || '') ? 'per month' : 'per year'}.` : '';
    return { ...at, company: at.board, title: j.text, location: (j.categories || {}).location || '', workplace: j.workplaceType, posted: j.createdAt ? new Date(j.createdAt).toISOString() : '', text: `${strip(j.descriptionPlain || j.description)} ${lists} ${strip(j.additionalPlain || '')}${sal}` };
  }
  if (at.ats === 'workday') {
    const d = await get(`https://${at.tenant}.${at.wd}.myworkdayjobs.com/wday/cxs/${at.tenant}/${at.site}${at.path}`);
    const i = d.jobPostingInfo || {};
    return { ...at, company: at.tenant, title: i.title, location: [i.location].concat(i.additionalLocations || []).filter(Boolean).join('; '), posted: i.startDate || '', postedText: i.postedOn, text: strip(i.jobDescription) };
  }
  if (at.ats === 'recruitee') {
    const d = await get(`https://${at.board}.recruitee.com/api/offers/${at.id}`);
    const j = d.offer || d;
    // Salary is a structured field on some offers ({min,max,period}) and plain text on others ("$17.3 - $26 per hour").
    const s = j.salary || {};
    const per = /hour/i.test(s.period || '') ? 'per hour' : /month/i.test(s.period || '') ? 'per month' : /week/i.test(s.period || '') ? 'per week' : 'per year';
    const sal = s.min || s.max ? ` Pay: $${s.min || s.max} - $${s.max || s.min} ${per}.` : '';
    return { ...at, company: j.company_name || at.board, title: j.title, location: j.location || [j.city, j.state_name || j.state_code, j.country].filter(Boolean).join(', '), posted: j.published_at || j.created_at, text: `${strip(j.description)} ${strip(j.requirements)}${sal}` };
  }
  if (at.ats === 'oracle') return oraclePosting(at);
  // No API: the page's own JSON-LD (iCIMS and most custom career sites). Never for login-walled job boards.
  if (!/(^|\.)(linkedin|indeed|glassdoor|joinhandshake)\.com$/i.test(new URL(U.unwrap(url)).hostname)) {
    const html = await getText(U.unwrap(url)).catch(() => '');
    const p = html && jsonLdPosting(html, url);
    if (p && p.text) return p;
  }
  throw new Error(`no public API for ${at.ats} links: use \`jobctl jd <url>\` (opens a tab)`);
}

/** Every pay figure in the text, as $/hour (yearly / 2080, monthly * 12 / 2080, bi-weekly * 26 / 2080). */
function payPerHour(text) {
  const out = [];
  text = String(text).replace(/\bUSD\s+(?=\d)/g, '$').replace(/(\$\d[\d,.]*)\s*(?:-|–|—|to)\s*(?=\d)/g, '$1 - $');
  // Whole numbers only: "$1750" read as "$175" once made Brookfield's $20/hr look like 20-175 (2026-10-09).
  const re = /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k|K)?(?:\s*(?:-|–|—|to)\s*\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k|K)?)?([^.$]{0,40})/g;
  let m;
  while ((m = re.exec(text))) {
    const n = (v, k) => (v ? Number(v.replace(/,/g, '')) * (k ? 1000 : 1) : null);
    let lo = n(m[1], m[2]);
    let hi = n(m[3], m[4] || (m[3] && m[2])) || lo;
    const unit = (m[5] || '').toLowerCase();
    if (/^\s*(m|b|mm|million|billion)\b/i.test(m[5] || '')) continue; // "$150M raised" is not pay
    const before = text.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
    const ctx = unit + ' ' + before;
    if (/annual|per year|a year/.test(unit) && lo < 20000) continue; // "$850 per EE annually" (HSA) is a benefit, not pay
    let f = null;
    if (/hour|hr\b|hourly/.test(ctx)) f = 1;
    else if (/bi-?weekly|every two weeks/.test(ctx)) f = 26 / 2080;
    else if (/month|mo\b/.test(ctx)) f = 12 / 2080;
    else if (/week/.test(ctx)) f = 1 / 40;
    else if ((/year|annual|yr\b|salary/.test(ctx) && lo >= 20000) || lo >= 20000) f = 1 / 2080;
    else if (lo >= 4000) f = 12 / 2080; // intern pay this size with no unit is monthly
    else if (lo >= 10 && lo < 200) f = 1;
    if (f == null || !lo) continue;
    lo = Math.round(lo * f * 100) / 100;
    hi = Math.round(hi * f * 100) / 100;
    if (lo >= 10 && hi <= 300) out.push({ low: lo, high: hi, raw: m[0].trim().slice(0, 60), before: before.replace(/^.*[\d$][^a-z]*/s, '') });
  }
  return out;
}

/**
 * Pay set by academic level ("Intern/Freshman/Sophomore: $30 ... Intern/Junior/Senior: $34 ... Completed
 * Master's: $38", xAI 2026-10-08): the owner is a rising senior, so his rate is the Junior/Senior tier, not
 * the overall range. Null unless the figures are tiered that way.
 */
const LEVEL = /freshm[ae]n|sophomore|junior|senior|completed (bachelor|master|ph\.?d)|master'?s|ph\.?d/i;
function payTier(pay) {
  if (pay.filter((x) => LEVEL.test(x.before)).length < 2) return null;
  return pay.find((x) => /junior|senior/i.test(x.before) && !/completed|master|ph\.?d/i.test(x.before)) || null;
}

function doNotClaim() {
  try {
    const t = fs.readFileSync(path.join(ROOT, 'tailor', 'references', 'facts.md'), 'utf8');
    const block = (t.match(/DO NOT CLAIM \([^\n]*\n([\s\S]*?)\n(?:Never confirmed|\n)/) || [])[1] || '';
    return block.replace(/\n/g, ' ').split(/,/).map((s) => s.replace(/\(.*?\)/g, '').replace(/\.$/, '').trim()).filter((s) => s && s.length < 30 && !/^any |project$/i.test(s));
  } catch (e) {
    return ['Java', 'C++', 'Rust'];
  }
}

// Non-engineering teams behind a technical-sounding title (2026-10-09: Fernhaven's "Cloud Software Security Intern" sat on the
// Commercial Sales team; /find rated it 8/10 from the title). Two distinct hits (or one in the title) set the flag.
const FAMILIES = [
  ['sales', /\b(?:inside|outside|commercial|field|enterprise|channel|retail|technical)\s+sales\b|\bsales\s+(?:team|organization|org|careers?|internship|intern|representatives?|reps?|quotas?|targets?|cycles?|pipeline)\b|\binterest in sales\b|\b(?:sales|revenue)\s+quota\b|\baccount executives?\b|\bbusiness development\b|\bcold[- ]call\w*|\bprospecting\b|\bcustomer outreach\b|\bselling\b/gi],
  ['marketing', /\bmarketing\s+(?:team|organization|org|intern|internship|campaigns?|department|strategy)\b|\bbrand (?:awareness|marketing|ambassador)\b|\bsocial media (?:content|marketing|campaigns?)\b|\bdemand generation\b|\bcontent marketing\b/gi],
  ['customer success', /\bcustomer success\b|\baccount management\b|\bclient relationships?\b|\bcustomer retention\b|\bupsell\w*/gi],
  ['recruiting / HR', /\btalent acquisition\b|\brecruiting\s+(?:team|intern|internship|coordinator)\b|\bhuman resources\b|\bsourcing candidates\b|\bHR\s+(?:team|intern|internship|department)\b/g],
  ['finance / accounting', /\b(?:finance|accounting|audit|tax)\s+(?:team|intern|internship|department|organization)\b|\bfinancial (?:analysis|planning|reporting)\b|\bgeneral ledger\b/gi],
];

/** "sales (Commercial Sales team; interest in sales)" when the posting text says it is a non-engineering team; else null. */
function roleFamily(text, title) {
  // Pay / benefits boilerplate names other teams ("Most sales positions are eligible for commission", DUNVALE): not this role.
  const body = String(text || '').split(/(?<=[.!?])\s+/).filter((x) => !/commission|non-sales|eligible for|benefits?\b|bonus/i.test(x)).join(' ');
  for (const [name, re] of FAMILIES) {
    const hits = [...new Set([...body.matchAll(re)].map((m) => m[0].replace(/\s+/g, ' ')))];
    const inTitle = [...String(title || '').matchAll(re)].length > 0;
    if (hits.length >= 2 || inTitle) return `${name} (${(hits.length ? hits : [title]).slice(0, 3).join('; ')})`;
  }
  return null;
}

const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?(?:\\s+\\d{1,2}(?:st|nd|rd|th)?,?)?(?:\\s*\\d{4})?';
const MONTH_RANGE = new RegExp(`\\b${MON}\\s*(?:-|–|—|to|through|until)\\s*${MON.replace('(jan', '(?<end>jan')}`, 'gi');

/** "spring co-op" / "fall co-op" when a co-op's dates cover a school semester (Jan-May or Sep-Dec); else null. */
function schoolTermCoop(text, title) {
  const all = `${title || ''} ${text || ''}`;
  if (!/\bco-?op\b|\bsemester[- ]long\b|\b6[- ]month (?:internship|co-?op)\b/i.test(all)) return null;
  if (/\bspring co-?op\b/i.test(title || '')) return 'spring co-op';
  if (/\bfall co-?op\b/i.test(title || '')) return 'fall co-op';
  const m = [...String(title || '').matchAll(MONTH_RANGE)].concat([...all.matchAll(MONTH_RANGE)])[0];
  if (!m) return null;
  const order = 'janfebmaraprmayjunjulaugsepoctnovdec';
  const a = order.indexOf(m[1].slice(0, 3).toLowerCase()) / 3;
  const b = order.indexOf(m.groups.end.slice(0, 3).toLowerCase()) / 3;
  if (a <= 1 && b >= 4) return 'spring co-op'; // starts Jan/Feb, runs into May or later
  if (a >= 6 && a <= 8 && b >= 10) return 'fall co-op'; // Jul-Sep start, runs to Nov/Dec
  return null;
}

/** The gate checks the /apply skill runs before rating. */
function flags(p, now) {
  const t = p.text || '';
  const f = {};
  // "Employee Polygraph Protection (Act)" is the federal EEO footer on many Workday postings, not a polygraph exam.
  const tc = t.replace(/\bemployee polygraph protection(?: act)?\b/gi, ' ');
  if (/\b(security clearance|secret clearance|ts\/sci|top secret|public trust|polygraph|obtain (?:and maintain )?a (?:security )?clearance)\b/i.test(tc)) f.clearance = true;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Required only when the nearest heading before it is a requirements one (not "Preferred" / "Nice to
  // have" / "Bonus"), it isn't followed by "is a plus" / "preferred", and it isn't one choice in a list.
  const REQ = /(required|requirements|minimum qualifications|basic qualifications|must[- ]have|you(?:'|’)ll bring|what you bring|qualifications|proficiency in)/gi;
  const OPT = /(preferred|nice[- ]to[- ]have|bonus|a plus|desired|strong candidates may also|good to have|pluses)/gi;
  const lastAt = (re, end, unlessAfter) => {
    let last = -1;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(t)) && m.index < end) {
      if (unlessAfter && unlessAfter.test(t.slice(Math.max(0, m.index - 25), m.index))) continue; // "Preferred qualifications"
      last = m.index;
    }
    return last;
  };
  const lacks = doNotClaim().filter((s) => {
    const re = new RegExp(`(^|[^A-Za-z])${esc(s)}(?![A-Za-z+#])`, /^[A-Z+#]+$/.test(s) ? 'g' : 'gi');
    let m;
    while ((m = re.exec(t))) {
      const req = lastAt(REQ, m.index, /preferred|nice[- ]to[- ]have|bonus|desired|additional/i);
      if (req < 0 || lastAt(OPT, m.index) > req) continue;
      const before = t.slice(Math.max(0, m.index - 90), m.index);
      const after = t.slice(m.index, m.index + 60);
      if (/one or more|any (?:one )?of|such as|e\.g\.|for example|or similar|or another|like\s/i.test(before)) continue;
      // The team's stack or what the intern will be exposed to, not a requirement (Ravenvale Infrastructure
      // 2026-10-11: "Technologies we use include: Linux, Kubernetes, Docker, ... Ansible", "exposure to ... Docker").
      const clause = t.slice(Math.max(0, m.index - 300), m.index).split(/[.;\n•]|\s-\s/).pop();
      if (/technologies (?:we|you(?:'|’)ll) use|\bwe use\b|our (?:tech(?:nology)? )?stack|tools we use|exposure to|you(?:'|’)ll (?:learn|gain|get)|you will (?:learn|gain|get)/i.test(clause)) continue;
      // "Python and/or Java" / "Python or Java": one choice of several (Glenmoor 2026-10-09).
      if (/\b(?:and\/or|or)\s*$/i.test(before) || /^\W?[A-Za-z+#]+\s*(?:,|\band\/or\b|\bor\b)\s*\w/i.test(after) && /\b(?:and\/or|or)\b/i.test(after.slice(0, 25))) continue;
      if (/\b(is|are|a)\s+(?:a\s+)?(plus|bonus|preferred)|nice[- ]to[- ]have/i.test(after)) continue;
      // A longer list item: "experience with Java, Kotlin, TypeScript, SQL, and/or AWS (this is a strong plus)"
      // (Ravenvale 2026-10-11): the item ends in and/or / or, or the sentence calls it a plus.
      const sentence = t.slice(m.index, m.index + 160).split(/[.;\n•]|\s-\s/)[0];
      if (/^\W?[A-Za-z+#]+\s*,/.test(after) && /,\s*(?:and\/or|or)\s+[A-Za-z+#]/i.test(sentence)) continue;
      if (/\b(?:strong|big|huge|definite)?\s*(?:plus|bonus)\b|\bpreferred\b/i.test(sentence)) continue;
      return true;
    }
    return false;
  });
  if (lacks.length) f.requiresUnclaimed = lacks;
  const grad = t.match(/graduat\w*[^.]{0,80}?(?:between|in|by|after|before|of)\s+([A-Za-z]+\s+20\d\d(?:\s*(?:-|–|and|or|to)\s*[A-Za-z]+\s+20\d\d)?)/i);
  if (grad) f.gradWindow = grad[0].slice(0, 140);
  if (/(?:not|never|don['’]t|do not)\s+(?:use|permitted to use|allowed to use)\s+(?:generative\s+)?AI|without (?:the )?(?:use|help|assistance) of AI|AI[- ]generated (?:responses|applications) will/i.test(t)) f.aiPolicy = true;
  if (/(?:return|returning) to school|at least one (?:semester|quarter) (?:of school )?remaining/i.test(t)) f.mustReturnToSchool = true; // he does (Fall 2027)
  const term = t.match(/\b((?:summer|fall|winter|spring)\s*(?:\/\s*\w+\s*)?(?:'|20)?\d{2,4}|\d{1,2}[- ]week)/gi);
  if (term) f.terms = [...new Set(term.map((x) => x.toLowerCase()))].slice(0, 6);
  // A co-op that runs through a school semester (Jan-Jun / Aug-Dec) clashes with the owner's classes (EXU until
  // Dec 2027): JCI, Manulife, Liberty Mutual 2026-10-11 were all "January - June 2027" co-ops.
  const sem = schoolTermCoop(t, p.title);
  if (sem) f.schoolTerm = sem;
  if (/\b(on-?site|in-office|in office)\b/i.test(t + ' ' + (p.workplace || ''))) f.onsite = true;
  if (/hybrid/i.test(t + ' ' + (p.workplace || ''))) f.hybrid = true;
  if (/remote/i.test((p.workplace || '') + ' ' + p.location)) f.remote = true;
  const fam = roleFamily(t, p.title);
  if (fam) f.roleFamily = fam; // not an engineering team: rate it on the team, not the title
  return f;
}

async function posting(url, now) {
  const p = await fetchPosting(url);
  const t = Date.parse(p.posted || '');
  const ageDays = Number.isFinite(t) ? Math.round((((now || Date.now()) - t) / 86400000) * 10) / 10 : null;
  const pay = payPerHour(p.text);
  const tier = payTier(pay);
  return {
    ats: p.ats,
    company: p.company,
    title: p.title,
    location: p.location,
    workplace: p.workplace || null,
    posted: p.posted || null,
    postedText: p.postedText || undefined,
    ageDays,
    stale: ageDays != null && ageDays > 7, // owner rule: skip postings older than a week
    payPerHour: tier ? { low: tier.low, high: tier.high, from: tier.raw, tier: true } : pay.length ? { low: Math.min(...pay.map((x) => x.low)), high: Math.max(...pay.map((x) => x.high)), from: pay[0].raw } : null,
    flags: flags(p),
    apply: U.applyUrl(url),
    text: p.text,
  };
}

module.exports = { posting, fetchPosting, payPerHour, payTier, flags, locate, roleFamily, oraclePosting, jsonLdPosting, placeholderDate, schoolTermCoop };
