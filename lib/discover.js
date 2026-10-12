'use strict';
/*
 * `jobctl discover`: find open internship postings fast, straight from the ATSs' public JSON APIs
 * (Greenhouse, Lever, Ashby, Workday). No browser, no login, nothing applied to. The boards to search
 * are in config/boards.json; the default filters (roles, term, cities in PLACES below) are plain
 * constants: edit them to your own search. Companies already in the tracker or applied.jsonl are
 * dropped. The list is approved by a person before anything is applied to.
 */
const fs = require('node:fs');
const path = require('node:path');
const D = require('./data');
const P = require('./paths');
const { ROOT } = P;

// 2026-10-12 search experiment: SDE / SDET / developer, data / ML / AI engineer, "Technology" and controls (OT) titles were
// dropped by the role filter (SAS SDET Cary, Epic SDET, Ravenvale Enterprise Technology, Q2 ML Engineer).
const ROLE = /network|infra|reliab|\bsre\b|security|cyber|systems|cloud|devops|platform|site reliab|\bit\b|information tech|data center|telecom|linux|operations engineer|enterprise systems|supercomput|support engineer|technical support|production support|threat|detection|incident|\bsoc\b|\bot\b|\bics\b|scada|software eng|backend|full[- ]?stack|\bsoftware\b|\bsde\b|\bsdet\b|\bswe\b|\bdeveloper|\b(ai|ml|machine learning|data)\b[^|,(]{0,25}\bengineer|solutions? engineer|technology|\btech\b|computer (science|engineering)|embedded|firmware|controls? engineer|automation engineer|information systems|forward deployed|firewall|vulnerab|penetration|pentest|red team|forensic|identity|\biam\b|appsec|\bnoc\b|sys ?admin|system admin|site admin|administrator|help ?desk|service desk|desktop support/i;
// Never-apply employers: put the names you want skipped here (regex alternation, case-insensitive).
const NEVER = /examplecorp-never-apply/i;
// Outside the US (this build targets US postings only).
const NON_US = /\b(toronto|montreal|ottawa|calgary|china|taiwan|india|malaysia|germany|ireland|france|spain|italy|tunisia|costa rica|bulgaria|(?<!new )mexico|canada|singapore|japan|korea|poland|israel|netherlands|united kingdom|\buk\b|london|paris|madrid|lisbon|portugal|new zealand|\bnz\b|australia|brazil|puerto rico|romania|czech|hungary|philippines|vietnam|colombia|bogot[aá]|peru|denmark|aarhus|qatar|doha|serbia|belgrade|brno|bangalore|bengaluru|panama|suzhou|beijing|shanghai|prc|cork|tel aviv|petah|krak[oó]w|belo horizonte|south africa|johannesburg|argentina|chile|uruguay|gbr)\b|,\s*IE\b/i;
// A US state at the end of a location part ("Dublin, OH", "Vancouver, WA", "Ontario, CA").
const US_STATE = /,\s*(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b|united states|\busa?\b|\bremote\b/i;

/** Keep a posting when any of its locations ("A; B") is in the US (case-insensitive). */
function isUsLocation(loc) {
  const parts = String(loc || '').split(/;/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return true;
  // "Remote (United Kingdom)" is not US remote (SailPoint 2026-10-09).
  return parts.some((x) => !/,\s*(ON|BC|QC|AB)\b/.test(x) && !(/\bremote\b/i.test(x) && NON_US.test(x) && !/\bU\.?S\.?A?\b|united states/i.test(x)) && (US_STATE.test(x) || PLACES.some(([, re]) => re.test(x)) || !(NON_US.test(x) || /\bCAN\b|canada/i.test(x))));
}

// Already in motion (configure to taste): don't re-apply anywhere at these.
const IN_MOTION = /^(brightco|quillstone|globex)/i;
// "Summer Analyst Program: Information Technology", "Data & Technology Summer Associate" (2026-10-12): bank-style intern titles.
// "Summer 2027" alone is safe only because ROLE still gates the title.
const INTERN = /\bintern(ship)?s?\b|\bco-?op\b|\bsummer\s+(analyst|associate)s?\b|\bsummer\s*2027\b/i;
// sales(?!force): Salesforce admin / engineering interns are on track (wexinc, 2026-10-12). The rest came with the broader
// ROLE: fab / chip "Technology" roles, quant, civil, supply chain, policy, physical security.
const OFF_TRACK = /fluid|mechanical|propulsion|electrical(?! (&|and) software)|structures|thermal|avionics|finance|marketing|sales(?!force)|legal|recruit|\bhr\b|accounting|design intern|manager|\bquant\b|quantitative|actuar|\basic\b|silicon|circuit|analog|physical design|\brtl\b|verification engineer|product management|\bcivil\b|transportation|surveying|construction|forestry|supply chain|pharm|clinical|histopath|\btax\b|real estate|\bhvac\b|wood procurement|\bcable\b|transistor|process integration|\bcmos\b|technology (architecture|research|development)|photonic|wafer|semiconductor|lithograph|test solutions|business development|partner network|policy|end markets|\bfire\b|physical security|hardware intern|wastewater/i;
// Grad-only titles ("Graduate Intern", "(Graduate/Master's)", 2026-10-12): he is an undergrad. "Undergraduate/Graduate" stays.
const NOT_TERM = /\b(spring|fall|winter)\s*(20)?2[6-7]\b(?!.*summer)|\b2026\b(?!.*2027)|phd|ph\.d|mba\b|^(?!.*undergrad).*(\bgraduate\b(?! program)|\bmaster'?s\b|postdoc)/i;
// Part-time mode (--part-time, 2026-10-12): paid remote IT work during the spring semester. Board / feed titles must say
// part-time or name the school year (Handshake hits carry employment type Part-Time instead); summer- or fall-only
// titles and grad-only ones are out; the school-semester skip does not apply and the pay floor is $15/hr.
const PART_TIME = /part[- ]?time|\bspring\s*(20)?27\b|\bspring (internship|intern|co-?op|semester)\b|\bwinter\s*(20)?27\b|academic year|school year|\bstudent (worker|assistant|technician|employee)\b/i;
const PT_NOT_TERM = /phd|ph\.d|mba\b|^(?!.*undergrad).*(\bgraduate\b(?! program)|\bmaster'?s\b|postdoc)|\b(summer|fall)\s*(20)?2[67]\b(?!.*spring)/i;
const PT_PAY_FLOOR = 15;
// The posting says the job itself is part-time ("This is a part-time, remote paid internship", "25-29hrs/wk"), not
// EEO boilerplate ("full-time, part-time, per diem": aah 2026-10-12).
const PT_TEXT = /\b(?:a|is|this) part[- ]time\b|part[- ]time,? (?:remote|paid|intern|position|role|opportunity|basis|schedule|hours)|\b[12]\d\s*(?:-|to)\s*(?:[12]\d|30)\s*(?:hrs|hours)\s*(?:\/|per|a)\s*w/i;
// "for active students in Master's and PhD programs" (Ancestry ML co-op 2026-10-12).
const GRAD_ONLY_TEXT = /students (?:enrolled )?in (?:a |an )?(?:master'?s|graduate|ph\.?d)\b/i;
/** A title for part-time mode (handshake: Handshake already said Part-Time). */
const partTimeFits = (t, role, handshake) => (role || ROLE).test(t) && !OFF_TRACK.test(t) && !PT_NOT_TERM.test(t) && (handshake || PART_TIME.test(t));
/** A feed row worth adding its board for: in-track title, US, not a never-list employer. */
const feedBoardFits = (p) => titleFits(p.title) && isUsLocation(p.location) && !NEVER.test(p.company) && !NEVER.test(p.url);
/** A title in his track with the default filters (tests and quick checks; discover's titleOk also takes --role). */
const titleFits = (t) => INTERN.test(t) && ROLE.test(t) && !OFF_TRACK.test(t) && !NOT_TERM.test(t);
const PLACES = [
  // OR / CA as state codes only in capitals: under /i "or" and "ca" matched any location text (2026-10-12).
  ['OR/CA', { test: (x) => /\b(OR|CA)\b/.test(x) || /oregon|portland|hillsboro|beaverton|california|san francisco|bay area|san jose|santa clara|sunnyvale|mountain view|palo alto|menlo park|oakland|los angeles|san diego|irvine|folsom/i.test(x) }],
  ['DC metro', /washington|\bDC\b|arlington|reston|herndon|mclean|chantilly|falls church|tysons|fairfax|alexandria|vienna, va|columbia, md|bethesda|laurel, md|sterling, va|leesburg|manassas|centreville|springfield, va|germantown, md|gaithersburg|rockville|silver spring|annapolis junction|district of columbia|dulles|ashburn/i],
  ['Raleigh-Durham', /raleigh|durham|research triangle|\bRTP\b|morrisville|\bcary\b|\bapex\b|garner|wake forest|chapel hill|wake county|holly springs/i],
  ['Richmond', /richmond/i],
  ['Boston', /boston|cambridge, ma|waltham|burlington[ ,-]+(ma|massachusetts)|lexington, ma|bedford, ma|somerville|quincy|woburn|marlborough|andover|tewksbury|framingham|natick|needham|chelmsford|billerica/i],
  ['NYC', /new york|\bNYC\b|brooklyn|queens|bronx|long island city|jersey city|hoboken/i],
  ['Austin', /austin|round rock|\bTX\b.*austin/i],
  ['Fallback', /seattle|bellevue|redmond|san diego/i],
];

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
async function getJson(url, init) {
  const res = await withTimeout(fetch(url, { ...(init || {}), headers: { 'user-agent': 'Mozilla/5.0 jobbot-discover', ...((init && init.headers) || {}) } }), 20000);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function greenhouse(slug) {
  const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
  return (d.jobs || []).map((j) => ({ ats: 'greenhouse', company: d.meta && d.meta.name ? d.meta.name : slug, board: slug, title: j.title, location: (j.location && j.location.name) || '', url: j.absolute_url, updated: j.updated_at, posted: j.first_published || j.updated_at }));
}
async function lever(slug) {
  const d = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  return (Array.isArray(d) ? d : []).map((j) => ({ ats: 'lever', company: slug, board: slug, title: j.text, location: ((j.categories && (j.categories.allLocations || [j.categories.location])) || []).join('; '), url: j.hostedUrl, updated: j.createdAt ? new Date(j.createdAt).toISOString() : '', posted: j.createdAt ? new Date(j.createdAt).toISOString() : '' }));
}
async function ashby(slug) {
  const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  return (d.jobs || []).map((j) => ({ ats: 'ashby', company: slug, board: slug, title: j.title, location: [j.location].concat((j.secondaryLocations || []).map((x) => x.location || x)).filter(Boolean).join('; '), url: j.jobUrl, updated: j.publishedAt || '', posted: j.publishedAt || '' }));
}
async function workday(w) {
  const base = `https://${w.tenant}.${w.wd}.myworkdayjobs.com`;
  // The API caps a page at 20: big tenants (Capital One, NVIDIA) list 100+ intern hits, so page through.
  const page = (offset) => getJson(`${base}/wday/cxs/${w.tenant}/${w.site}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: 'intern' }) });
  const first = await page(0);
  const more = await Promise.all([20, 40, 60, 80].filter((o) => o < (first.total || 0)).map((o) => page(o).catch(() => ({}))));
  const d = { jobPostings: [first].concat(more).flatMap((x) => x.jobPostings || []) };
  return (d.jobPostings || []).map((j) => ({ ats: 'workday', company: w.tenant, board: w.tenant, title: j.title, location: j.locationsText || '', url: `${base}/${w.site}${j.externalPath}`, updated: j.postedOn || '', posted: workdayPosted(j.postedOn), detail: `${base}/wday/cxs/${w.tenant}/${w.site}${j.externalPath}` }));
}

/**
 * Oracle HCM career site (2026-10-12 experiment: 209 feed rows, Fernhaven / Emerson / Honeywell, no board adapter). Public
 * JSON: recruitingCEJobRequisitions, newest first, keyword "intern". o = { host, site, company }.
 */
async function oracle(o) {
  const q = `onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=${o.site},limit=100,keyword=intern,sortBy=POSTING_DATES_DESC`;
  const d = await getJson(`https://${o.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?${q}`);
  const reqs = ((d.items || [])[0] || {}).requisitionList || [];
  return reqs.map((r) => ({ ats: 'oracle', company: o.company || o.host.split('.')[0], board: `${o.host}/${o.site}`, title: r.Title, location: [r.PrimaryLocation].concat((r.secondaryLocations || []).map((x) => x.Name)).filter(Boolean).join('; '), url: `https://${o.host}/hcmUI/CandidateExperience/en/sites/${o.site}/job/${r.Id}`, updated: r.PostedDate || '', posted: r.PostedDate ? new Date(r.PostedDate).toISOString() : '' }));
}

/**
 * Phenom career site (careers.<company>.com/us/en/...): Butterball, Truist, State Street, MITRE (2026-10-12: Butterball's
 * Garner IT intern was only findable on LinkedIn). POST /widgets refineSearch, newest first. o = { host, company }.
 * The apply link is often another ATS (UKG for Butterball): that is the url; the Phenom job page otherwise.
 */
async function phenom(o) {
  const body = { lang: 'en_us', deviceType: 'desktop', country: 'us', pageName: 'search-results', ddoKey: 'refineSearch', sortBy: 'Most recent', from: 0, jobs: true, counts: true, size: 100, clearAll: false, jdsource: 'facets', isSliderEnable: false, pageId: 'page11', siteType: 'external', keywords: 'intern', global: true, selected_fields: {}, locationData: {} };
  const d = await getJson(`https://${o.host}/widgets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const jobs = (((d.refineSearch || {}).data || {}).jobs) || [];
  return jobs.map((j) => {
    const page = `https://${o.host}/us/en/job/${j.jobSeqNo || j.jobId}`;
    const apply = j.applyUrl && !String(j.applyUrl).includes(o.host) ? j.applyUrl : page;
    const locs = (j.multi_location || []).length ? j.multi_location : [j.cityStateCountry || j.location || ''];
    return { ats: 'phenom', company: o.company || o.host, board: o.host, title: j.title, location: locs.join('; '), url: apply, page, updated: j.postedDate || '', posted: j.postedDate ? new Date(j.postedDate).toISOString() : '' };
  });
}

/** Workday says "Posted Today / Yesterday / 3 Days Ago / 30+ Days Ago": turn it into an ISO date. */
function workdayPosted(text, now) {
  const t = String(text || '').toLowerCase();
  const day = 86400000;
  const base = now || Date.now();
  if (/today/.test(t)) return new Date(base).toISOString();
  if (/yesterday/.test(t)) return new Date(base - day).toISOString();
  const m = t.match(/(\d+)\+?\s*days? ago/);
  return m ? new Date(base - Number(m[1]) * day).toISOString() : '';
}

/** Days since a posting went up (Infinity when unknown). */
function ageDays(p, now) {
  const t = Date.parse(p.posted || '');
  return Number.isFinite(t) ? ((now || Date.now()) - t) / 86400000 : Infinity;
}

// Metro areas for --city: a name expands to its suburbs (2026-10-08 asks: Portland incl. Beaverton/Hillsboro, DC metro).
const METROS = {
  portland: 'portland|beaverton|hillsboro|tigard|lake oswego|wilsonville|clackamas|gresham|milwaukie|vancouver, wa',
  austin: 'austin|round rock|cedar park|pflugerville|georgetown, tx|leander|taylor, tx|hutto|san marcos',
  seattle: 'seattle|bellevue|redmond|kirkland|bothell|everett',
  'bay area': 'san francisco|\\bsf\\b|bay area|san jose|santa clara|sunnyvale|mountain view|palo alto|menlo park|oakland|fremont|cupertino|milpitas|redwood city|san mateo|foster city|south san francisco',
  // 2026-10-12 experiment: IRONFIELD (Laurel MD), Annapolis Junction, Leesburg, Manassas, Sterling rows were dropped.
  dc: 'washington,? ?d\\.?c|district of columbia|\\bdc\\b|arlington,? (va|virginia)|arlington county|alexandria,? (va|virginia)|reston|mclean|herndon|tysons|falls church|vienna,? (va|virginia)|fairfax|chantilly|centreville|ashburn|sterling, ?va|leesburg|manassas|springfield, ?va|woodbridge, ?va|dulles|lorton|annandale|northern virginia|bethesda|rockville|silver spring|gaithersburg|germantown, ?(md|maryland)|college park|greenbelt|beltsville|laurel, ?(md|maryland)|columbia, ?(md|maryland)|annapolis junction|hanover, ?(md|maryland)|lanham|bowie|us-(va|md|dc)-',
  // Raleigh-Durham / RTP and Boston had no metro: a bare --city raleigh missed Cary, --city boston missed Waltham (2026-10-12).
  raleigh: 'raleigh|durham|research triangle|\\brtp\\b|triangle park|morrisville|\\bcary\\b|\\bapex\\b|garner|wake forest|chapel hill|holly springs|fuquay|knightdale|wendell|carrboro|hillsborough, nc|wake county|durham county|zebulon|clayton, nc',
  boston: 'boston|cambridge, ?(ma|massachusetts)|waltham|burlington[ ,-]+(ma|massachusetts)|lexington, ?(ma|massachusetts)|bedford, ?(ma|massachusetts)|somerville|quincy|woburn|marlborough|andover|framingham|natick|needham|newton, ?(ma|massachusetts)|watertown|wellesley|lowell|westborough|billerica|chelmsford|tewksbury|norwood|braintree|boxborough|westford|hopkinton|us-ma-',
  remote: 'remote|work from home|work at home|teleworker|telecommut',
  // Not the state: "Rochester, New York" / "Rochester New York" (Mindex, Thomson Reuters 2026-10-09).
  // "USA - New York - Malta" is Marlby upstate (2026-10-12).
  nyc: '(?<!(?:,|rochester|buffalo|albany|syracuse|ithaca|binghamton|utica|schenectady|poughkeepsie|long island) *)new york(?! *- *(malta|rochester|buffalo))|\\bnyc\\b|brooklyn|manhattan(?!,? *(kansas|ks)\\b| beach)|queens|bronx|staten island|long island city|jersey city|hoboken',
  richmond: 'richmond, va|glen allen|henrico',
  chicago: 'chicago|evanston|oak brook|schaumburg|downers grove|naperville',
  // 2026-10-08: Willowcrest (Long Beach) and Amberbrook (Beverly Hills) were dropped by a literal "los angeles".
  'los angeles': 'los angeles|\\bla\\b(?! jolla)|long beach|manhattan beach|santa monica|el segundo|culver city|pasadena|burbank|torrance|beverly hills|hawthorne|playa vista|glendale, ca',
  'salt lake city': 'salt lake|lehi|draper|south jordan|sandy, ut',
};

METROS['new york'] = METROS.nyc;
for (const k of ['rtp', 'research triangle', 'research triangle park', 'triangle', 'durham', 'cary']) METROS[k] = METROS.raleigh;
METROS.cambridge = METROS.boston;

/** "portland,austin,remote" -> one case-insensitive RegExp over locations; null when not given. */
function cityFilter(list) {
  if (!list || list === true) return null;
  const parts = String(list).split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return null;
  return new RegExp(parts.map((c) => METROS[c] || c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
}

/**
 * --city match. The title counts only when the location names no place: MEMX lists "United States" with the
 * city in "(Hybrid, NYC)", while titles like "DC/DC Converter" or "Salesforce (SF)" must not (2026-10-08).
 */
function cityMatch(cities, p) {
  if (cities.test(p.location || '')) return true;
  const vague = /^\s*(united states( of america)?|usa?|u\.s\.a?\.?|remote[^,;]*|)\s*$/i.test(p.location || '');
  return vague && cities.test(p.title || '');
}

/**
 * A feed hit's real age from its ATS posting (d.ageDays): replaces the feed's, and returns a skip reason when
 * it is past maxAge. Board hits that already carry the ATS date are left alone.
 */
function realAge(p, d, maxAge) {
  // Board hits with no list date (mfs / vrtx Workday tenants hide postedOn) take the posting's date too.
  if ((!p.source && p.ageDays != null) || !d || !Number.isFinite(d.ageDays)) return undefined;
  const feed = p.ageDays;
  p.ageDays = Math.round(d.ageDays * 10) / 10;
  if (p.ageDays > maxAge + 0.5) return `stale: posted ${Math.round(p.ageDays)} d ago on the ATS${feed == null ? '' : ` (feed said ${feed} d)`}`;
  return undefined;
}

/** Workday lists "3 Locations": fetch the posting for its real locations (only for title matches). */
async function workdayLocations(p) {
  try {
    const d = await getJson(p.detail);
    const i = d.jobPostingInfo || {};
    return [i.location].concat(i.additionalLocations || []).filter(Boolean).join('; ');
  } catch (e) {
    return p.location;
  }
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}

/** Companies in the tracker. A different role at one of them is still fair game (flagged, not dropped). */
function alreadyApplied() {
  // company key -> roles applied there (applied.jsonl). Tracker-only companies (hand applies) have no roles on file.
  const roles = new Map();
  const key = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const add = (n, role) => {
    const k = key(n);
    if (!k) return;
    if (!roles.has(k)) roles.set(k, []);
    if (role) roles.get(k).push(role);
  };
  try {
    fs.readFileSync(path.join(D.DATA_DIR, 'tracker-companies.txt'), 'utf8').split('\n').forEach((n) => add(n));
  } catch (e) {
    /* none */
  }
  // Tracker rows' roles (hand applies included), written by /apply and /inbox: {company: [role, ...]}.
  try {
    const t = JSON.parse(fs.readFileSync(path.join(D.DATA_DIR, 'tracker-roles.json'), 'utf8'));
    for (const [c, rs] of Object.entries(t)) (rs || []).forEach((r) => add(c, r));
  } catch (e) {
    /* none yet */
  }
  D.applied().forEach((a) => add(a.company, a.role));
  return roles;
}

// Words that say nothing about what the job is (engineer, developer ... name no field): two titles that differ only in
// these are the same role.
const ROLE_NOISE = /\b(intern(ship)?s?|co-?op|summer|fall|spring|winter|20\d\d|early|careers?|program|undergrad(uate)?|students?|university|us|usa|bs|ms|the|and|of|for|in|at|to|a|an|i|ii|new|grad|remote|hybrid|onsite|engineer(ing|s)?|developer|development|analyst|specialist|associate|technical|technology|role|position)\b/g;
const roleWords = (t) => new Set(String(t || '').toLowerCase().replace(/\(.*?\)|[^a-z0-9+#]+/g, ' ').replace(ROLE_NOISE, ' ').split(/\s+/).filter(Boolean));

/**
 * Same kind of role (the owner 2026-10-12: a company he applied to once was hiding every other role there, 69 hits in one
 * run, e.g. IAM / Data Center / Network Engineering interns at companies where he had applied for SWE).
 * Similar = one title's field words contain the other's, or they share two thirds of the shorter title's.
 */
function similarRole(a, b) {
  const x = roleWords(a);
  const y = roleWords(b);
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / Math.min(x.size, y.size) >= 2 / 3;
}

/** Add the Greenhouse / Lever / Ashby / Workday boards behind Simplify hits to config/boards.json (same format). */
function saveNewBoards(urls, names) {
  const file = path.join(ROOT, 'config', 'boards.json');
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { boards, added } = require('./simplify').addBoards(cur, urls, names);
    if (added.length) fs.writeFileSync(file, JSON.stringify(boards, null, 2));
    return added;
  } catch (e) {
    return [];
  }
}

/** Why a hit is skipped, as a short bucket for the funnel ("requires X" all count as one reason). */
function skipReason(skip) {
  // "requires Go, Rust" = a required skill the owner does not claim (lib/posting.js requiresUnclaimed).
  return String(skip).startsWith('requires ') ? 'requires a skill not claimed' : String(skip).slice(0, 60);
}

/** One funnel line for a discover run: hits, skips by reason, and how many hits are left to apply to. */
function funnelRecord(postings, at) {
  const skipped = {};
  let applyable = 0;
  for (const p of postings) {
    if (p.skip) skipped[skipReason(p.skip)] = (skipped[skipReason(p.skip)] || 0) + 1;
    else applyable++;
  }
  return { at: at || new Date().toISOString(), hits: postings.length, skipped, applyable };
}

/** Append this discover's funnel to data/discover-funnel.jsonl (never fails the discover). */
function recordFunnel(postings) {
  try {
    fs.mkdirSync(path.dirname(P.DISCOVER_FUNNEL), { recursive: true });
    fs.appendFileSync(P.DISCOVER_FUNNEL, JSON.stringify(funnelRecord(postings)) + '\n');
  } catch (e) {
    /* the funnel is a measurement: a write error must not break discover */
  }
}

async function discover(opts) {
  const o = opts || {};
  const boards = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'boards.json'), 'utf8'));
  const role = o.role ? new RegExp(o.role, 'i') : ROLE;
  const tasks = o.boards === false ? [] : [].concat(
    (boards.greenhouse || []).map((s) => () => greenhouse(s)),
    (boards.lever || []).map((s) => () => lever(s)),
    (boards.ashby || []).map((s) => () => ashby(s)),
    (boards.workday || []).map((w) => () => workday(w)),
    (boards.oracle || []).map((w) => () => oracle(w)),
    (boards.phenom || []).map((w) => () => phenom(w))
  );
  const errors = [];
  const lists = await pool(tasks, 10, (t) => t().catch((e) => (errors.push(e.message), [])));
  const maxAge = Number.isFinite(Number(o.maxAge)) && o.maxAge !== true && Number(o.maxAge) > 0 ? Number(o.maxAge) : o.partTime ? 30 : 7;
  const payFloor = o.partTime ? PT_PAY_FLOOR : 35;
  // Simplify feed (default on): fresh rows from the SimplifyJobs list. A failure never breaks discover.
  const { postingKey } = require('./urls');
  const simplify = { enabled: o.simplify !== false, rows: 0, kept: 0, deduped: 0, boardsAdded: [] };
  let feed = [];
  // Every in-track US feed row's board, not only today's fresh hits (2026-10-12 experiment: 344 feed boards were never
  // searched because their rows were older than the window or outside --city). Rows up to 60 d old.
  const feedBoardUrls = [];
  const boardNames = {};
  if (simplify.enabled) {
    const S = require('./simplify');
    const have = new Set(lists.flat().map((p) => postingKey(p.url)));
    simplify.feeds = {};
    for (const fd of S.FEEDS) {
      try {
        const rd = await S.readme({ urls: fd.urls, cacheFile: path.join(D.DATA_DIR, fd.cache) });
        if (rd.stale) simplify.warning = `${fd.name} fetch failed (${rd.error}); used the stale cache`;
        const rows = S.parse(rd.text);
        for (const p of S.toPostings(rows, 60, undefined, fd.name)) if (feedBoardFits(p)) feedBoardUrls.push(p.url), (boardNames[p.url] = p.company);
        simplify.rows += rows.length;
        simplify.feeds[fd.name] = rows.length;
        feed = feed.concat(S.toPostings(rows, maxAge, undefined, fd.name).filter((p) => (have.has(postingKey(p.url)) ? (simplify.deduped++, false) : (have.add(postingKey(p.url)), true))));
      } catch (e) {
        simplify.feeds[fd.name] = `error: ${e.message}`;
        process.stderr.write(`discover: ${fd.name} feed skipped (${e.message})\n`);
      }
    }
  }
  // Handshake (EXU's board, read through the logged-in jobbot Firefox; lib/handshake.js). Opt-in here (`jobctl
  // discover` turns it on unless --no-handshake), so library callers and tests never reach the live browser. No browser
  // or a logged-out session only warns. Its search is already internships only, so the title needs no "intern".
  const titleOk = o.partTime
    ? (p) => {
        if (partTimeFits(p.title, role, p.source === 'handshake' || p.partTimeOnHandshake)) return true;
        // An intern title that does not say part-time: the posting text decides (Brookfield GPSU/NE: "part-time, remote
        // paid internship" in the body only, 2026-10-12). Checked in the detail pass below.
        if (INTERN.test(p.title) && partTimeFits(p.title, role, true)) return (p.partTimeByText = true);
        return false;
      }
    : (p) => (INTERN.test(p.title) || p.source === 'handshake') && role.test(p.title) && !OFF_TRACK.test(p.title) && !NOT_TERM.test(p.title);
  const handshake = { enabled: o.handshake === true || !!o.handshakeFetcher, found: 0, kept: 0, deduped: 0 };
  let hsFeed = [];
  if (handshake.enabled) {
    try {
      const r = await require('./handshake').hits({ maxAge, query: o.query, keep: titleOk, fetcher: o.handshakeFetcher, partTime: o.partTime, payFloor });
      Object.assign(handshake, { searched: r.searched, found: r.found, errors: r.errors.length ? r.errors : undefined });
      // A posting the boards / feeds already list keeps their hit (first wins), which learns its Handshake link.
      const byKey = new Map(lists.flat().concat(feed).map((p) => [dedupeKey(p.url), p]));
      hsFeed = r.hits.filter((p) => {
        const twin = byKey.get(dedupeKey(p.url));
        if (!twin) return true;
        twin.handshakeUrl = p.handshakeUrl;
        if (o.partTime) twin.partTimeOnHandshake = true; // Handshake typed it Part-Time; the board title may not say so
        handshake.deduped++;
        return false;
      });
    } catch (e) {
      handshake.error = e.message;
      if (e.code === 'HANDSHAKE_LOGGED_OUT') handshake.loggedOut = true;
      process.stderr.write(`discover: Handshake skipped (${e.message})\n`);
    }
  }
  let posts = lists.flat().concat(feed, hsFeed).filter(titleOk);
  await pool(posts.filter((p) => p.ats === 'workday' && /\d+ locations/i.test(p.location)), 6, async (p) => {
    p.location = await workdayLocations(p);
  });
  // Owner rule (2026-10-07): nothing older than a week (it already has a pile of applicants).
  // Unknown date (no postedOn / createdAt) stays in, flagged ageDays: null, sorted last: check it by hand.
  posts = posts.filter((p) => !Number.isFinite(ageDays(p)) || ageDays(p) <= maxAge);
  // Part-time defaults to remote: he is on campus in Springfield during the semester.
  const cities = cityFilter(o.city || (o.partTime && !o.anywhere ? 'remote' : null));
  const skip = alreadyApplied();
  const appliedUrls = new Set(D.applied().map((a) => postingKey(a.url)));
  const out = [];
  const newBoardUrls = [];
  for (const p of posts) {
    const key = String(p.company).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (NEVER.test(p.company) || NEVER.test(p.board) || appliedUrls.has(postingKey(p.url))) continue;
    if (!isUsLocation(p.location)) continue;
    if (p.source) newBoardUrls.push(p.url), (boardNames[p.url] = p.company);
    if (!o.all && IN_MOTION.test(key)) continue;
    const trackedKey = [...skip.keys()].find((s) => s && (s === key || s.startsWith(key) || key.startsWith(s)));
    if (trackedKey) {
      p.inTracker = true;
      p.appliedRoles = skip.get(trackedKey);
      p.similarApplied = p.appliedRoles.some((r) => similarRole(r, p.title));
    }
    const where = PLACES.find(([, re]) => re.test(p.location));
    // --city: only these places (comma list; aliases below), instead of the Job Preferences cities.
    if (cities) {
      if (!cityMatch(cities, p)) continue;
    } else if (!where && !o.anywhere && !/remote/i.test(p.location)) continue;
    p.ageDays = Number.isFinite(ageDays(p)) ? Math.round(ageDays(p) * 10) / 10 : null;
    out.push({ ...p, area: where ? where[0] : /remote/i.test(p.location) ? 'Remote' : 'elsewhere', detail: undefined });
  }
  out.splice(0, out.length, ...dedupeHits(out));
  if (simplify.enabled && !o.noBoards && newBoardUrls.length + feedBoardUrls.length) simplify.boardsAdded = saveNewBoards(newBoardUrls.concat(feedBoardUrls), boardNames);
  simplify.kept = out.filter((p) => p.source && p.source !== 'handshake').length;
  handshake.kept = out.filter((p) => p.source === 'handshake').length;
  const rank = (p) => PLACES.findIndex(([n]) => n === p.area);
  // Freshest first (24 h beats 3 days beats a week), then preferred area.
  const bucket = (p) => (p.ageDays == null ? 3 : p.ageDays <= 1 ? 0 : p.ageDays <= 3 ? 1 : 2);
  out.sort((a, b) => bucket(a) - bucket(b) || (rank(a) < 0) - (rank(b) < 0) || rank(a) - rank(b) || (a.ageDays ?? 99) - (b.ageDays ?? 99));
  // Pay and gate flags for each hit (owner ranks by pay first): read the postings' APIs, 6 at a time.
  // Feed rows (Simplify / Understudy / RoleInbox) always get the detail pass: their ages are often a repost
  // or "updated" date (2026-10-08: Glean, Figure, Astera listed as 1-6 d were 40-400 d old on the ATS).
  // Skips that need no posting API run on every hit (2026-10-08: with 68 hits only feed rows got the detail
  // pass, so Workday tenants without an account, UMBERMOOR / Silverwick / YARROWMERE the owner dropped, and companies
  // already applied to came back unmarked).
  markSkips(out, ownerDropped());
  try {
    markRunSkips(out, require('./runs').all());
  } catch (e) {
    /* runs unreadable: tracker skips still apply */
  }
  // Every hit not already skipped gets the detail pass (2026-10-08: with 90 hits only feed rows got it, so
  // Pure Storage / Rivet / Northmoor (C++), Gas South and MEMX (under $35) all came back unflagged and were
  // screened by hand). Feed rows always get it, skipped or not, for their real ATS age.
  // (Handshake-native hits have no ATS API: their pay and flags came from Handshake itself.)
  const detailed = o.noDetail ? [] : out.filter((p) => p.ats !== 'handshake' && (p.source || !p.skip));
  if (detailed.length) {
    const P = require('./posting');
    await pool(detailed, 6, async (p) => {
      try {
        const d = await P.posting(p.url);
        const stale = realAge(p, d, maxAge);
        if (p.partTimeByText && !PT_TEXT.test(String(d.text || ''))) p.skip = 'not part-time';
        if (o.partTime && GRAD_ONLY_TEXT.test(String(d.text || '')) && !/undergrad|bachelor/i.test(String(d.text || ''))) p.skip = p.skip || 'grad students only';
        p.payPerHour = d.payPerHour ? `${d.payPerHour.low}-${d.payPerHour.high}` : p.payPerHour || null; // Handshake lists pay the ATS may not
        p.flags = d.flags;
        const f = d.flags;
        p.skip = stale || p.skip || (f.clearance ? 'clearance' : f.requiresUnclaimed ? `requires ${f.requiresUnclaimed.join(', ')}` : f.schoolTerm && !o.partTime ? `${f.schoolTerm} (school semester)` : d.payPerHour && d.payPerHour.high < payFloor ? `pay under $${payFloor}/hr` : undefined);
      } catch (e) {
        p.detailError = e.message.slice(0, 80);
        if (p.partTimeByText) p.skip = 'not part-time'; // text unreadable: cannot tell, leave it out
        if (/\b404\b/.test(e.message)) p.skip = p.skip || 'posting gone (404)'; // KnowBe4, Natera 2026-10-08
      }
    });
  }
  // Part-time mode: intern postings whose text never says part-time are full-time internships, not noise to list.
  if (o.partTime) out.splice(0, out.length, ...out.filter((p) => !(p.partTimeByText && p.skip)));
  recordFunnel(out);
  return { searched: tasks.length, unreachable: errors.length, count: out.length, simplify, handshake, postings: out };
}


/**
 * One key per real posting for de-duping a listing (2026-10-09): amazon.jobs and www.amazon.jobs, a Workday
 * req posted on two career sites of one tenant (R56702 / R56702-2), an iCIMS job listed as ?mobile=true and as
 * a /job slug. Falls back to the normalized URL key.
 */
function dedupeKey(url) {
  try {
    const u = new URL(String(url));
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    let m;
    if (/\.myworkdayjobs\.com$/.test(host) && (m = u.pathname.match(/_(R?\d+)(?:-\d+)?\/?$/i))) return `workday:${host.split('.')[0]}:${m[1].toUpperCase()}`;
    if (/\.icims\.com$/.test(host) && (m = u.pathname.match(/\/jobs\/(\d+)/))) return `icims:${host}:${m[1]}`;
    if (host === 'amazon.jobs' && (m = u.pathname.match(/\/jobs\/(\d+)/))) return `amazon:${m[1]}`;
    return require('./urls').postingKey(url).replace(/^www\./, '');
  } catch (e) {
    return String(url);
  }
}

/** Drop repeats of one posting from a listing (first wins). */
function dedupeHits(hits) {
  const seen = new Set();
  return hits.filter((p) => {
    const k = dedupeKey(p.url);
    // Same company + title + location under two req ids (mfs 231983 / 231985, 2026-10-09 and 10-11): one line.
    const same = `same:${norm(p.company)}|${norm(p.title)}|${norm(p.location)}`;
    if (seen.has(k) || seen.has(same)) return false;
    seen.add(k);
    seen.add(same);
    return true;
  });
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Skip hits that already have a run (2026-10-09: Driftgate R6249 submitted, QUARRYHALL JR-202622064 stuck in
 * needs_input, both listed because no tracker row existed yet). Matches posting key, then company + role.
 * Dry and dropped runs do not count. Sets p.skip; returns hits.
 */
function markRunSkips(hits, runs) {
  const live = (runs || []).filter((r) => r && !r.dry && r.status !== 'dropped' && !r.abandoned && r.status !== 'new');
  const byKey = new Map();
  const byRole = new Map();
  for (const r of live) {
    if (r.url) byKey.set(dedupeKey(r.url), r);
    if (r.lastUrl) byKey.set(dedupeKey(r.lastUrl), r);
    if (r.company && r.role) byRole.set(norm(r.company) + '|' + norm(r.role), r);
  }
  for (const p of hits) {
    if (p.skip) continue;
    const r = byKey.get(dedupeKey(p.url)) || byRole.get(norm(p.company) + '|' + norm(p.title));
    if (r) p.skip = r.status === 'submitted' ? `already applied (run ${r.id})` : `in progress (run ${r.id}, ${r.status})`;
  }
  return hits;
}

/** Companies whose runs the owner dropped ("owner: ..."), lowercased. */
function ownerDropped() {
  const R = require('./runs');
  const out = new Set();
  for (const id of R.list().slice(-200)) {
    try {
      const r = R.load(id);
      if (r.status === 'dropped' && /^owner/.test(r.message || '')) out.add(String(r.company || '').toLowerCase());
    } catch (e) {
      /* skip */
    }
  }
  return out;
}

/**
 * Skips that need no posting API (owner rules 2026-10-07/08): a Workday tenant without an account (its Create
 * Account needs a human click), a company the owner dropped, a company already in the tracker. Pure but for
 * D.hasAccount; `dropped` is a Set of lowercased company names.
 */
function markSkips(hits, dropped, hasAccount = D.hasAccount) {
  for (const p of hits) {
    let wdSite = null;
    try {
      wdSite = p.ats === 'workday' ? new URL(p.url).hostname : null;
    } catch (e) {
      p.skip = p.skip || 'bad posting URL';
      continue;
    }
    const isDropped = dropped.has(String(p.company || '').toLowerCase());
    // Owner (2026-10-09, overrides 2026-10-07): a Workday tenant with no account is NOT a skip. jobbot fills the
    // Create Account form and the owner presses it once; the hit is only flagged so the run can be batched.
    if (wdSite && !hasAccount(wdSite)) p.needsAccount = true;
    p.skip =
      p.skip ||
      (isDropped ? 'owner dropped this company for now' : undefined) ||
      // A different role at a company he applied to stays in (flagged in the brief); only a similar role is skipped.
      (p.inTracker && (p.similarApplied || !p.appliedRoles) ? 'already applied for a similar role here' : undefined);
  }
  return hits;
}

/**
 * Only postings not reported before (data/seen-postings.json), saved to data/discover-latest.json
 * for the next /apply session to show the owner for approval.
 */
async function discoverNew(opts) {
  const res = await discover(opts);
  const seenFile = path.join(D.DATA_DIR, 'seen-postings.json');
  let seen = {};
  try {
    seen = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
  } catch (e) {
    /* first run */
  }
  const fresh = res.postings.filter((p) => !seen[p.url]);
  const now = new Date().toISOString();
  for (const p of fresh) seen[p.url] = now;
  D.writeJson(seenFile, seen);
  const latest = { at: now, count: fresh.length, postings: fresh };
  D.writeJson(path.join(D.DATA_DIR, 'discover-latest.json'), latest);
  return { ...res, count: fresh.length, postings: fresh, newOnly: true };
}

module.exports = { similarRole, PT_TEXT, GRAD_ONLY_TEXT, partTimeFits, PART_TIME, oracle, phenom, titleFits, markSkips, markRunSkips, dedupeKey, dedupeHits, greenhouse, lever, ashby, getJson, discover, discoverNew, funnelRecord, ROLE, PLACES, NEVER, IN_MOTION, NON_US, isUsLocation, workdayPosted, ageDays, realAge, cityFilter, cityMatch };
