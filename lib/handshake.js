'use strict';
/*
 * Handshake (EXU's student job board, exu.joinhandshake.com) as a jobbot source.
 *
 * Handshake has no public API: its data answers only to the logged-in session in the jobbot Firefox. So every
 * request here runs inside a Handshake tab through the extension (JB.fetchJson in extension/agent/page.js, the
 * page's own cookies). Two endpoints, found by watching the job-search and job pages (2026-10-09):
 *   GET  /stu/postings?query=Q&job.job_types[]=3&sort_column=created_at&sort_direction=desc&page=N&per_page=50
 *        (Accept: application/json) -> { results: [Posting {id, created_at, job_id, job: {...}}], total_pages }
 *   POST /hs/graphql  { query } -> job(id) { description, jobApplySetting { applyType, externalUrl ... }, ... }
 * Logged out, both redirect to the login page: reported as `loggedOut`, never logged in here (EXU SSO + Duo is
 * the owner's phone).
 *
 * How a posting is applied to (jobApplySetting.applyType):
 *   EXTERNAL                -> the employer's ATS (externalUrl, cleaned). Fed through the usual posting / apply
 *                              pipeline, deduped against hits discover already finds.
 *   HANDSHAKE               -> native: `jobctl apply https://<host>/jobs/<id>` drives Handshake's Apply modal.
 *   HANDSHAKE_AND_EXTERNAL  -> native on Handshake (the external link is kept as `externalUrl`).
 * An external link that names no posting (a careers home page) is left on the Handshake URL with a `find` hint.
 */

const DEFAULT_HOST = 'exu.joinhandshake.com';
// Search words for the owner's roles (security / IT / network / SWE / SRE / infra / cloud / OT-ICS). Handshake's
// search is full-text over the whole posting, so the titles are filtered again with discover's ROLE regex.
const QUERIES = ['cybersecurity', 'security', 'information technology', 'IT', 'network', 'software engineer', 'software', 'site reliability', 'infrastructure', 'cloud', 'devops', 'systems', 'SCADA OT ICS'];
const INTERNSHIP_TYPE = 3; // job.job_types facet: 3 = Internship
// Part-time mode (2026-10-12: the owner wants a paid remote part-time IT job for the spring semester): any job type
// (internship, job, on-campus), kept only when Handshake says employment type Part-Time. IT-desk words lead.
const PART_TIME_QUERIES = ['IT', 'help desk', 'technical support', 'IT support', 'cybersecurity', 'security', 'software', 'developer', 'network', 'computer', 'data', 'web', 'systems administrator'];
const GQL_BATCH = 15;

/** exu.joinhandshake.com/jobs/123, app.joinhandshake.com/stu/jobs/123, /job-search/123?... -> "123" (else null). */
function jobIdOf(url) {
  try {
    const u = new URL(String(url));
    if (!/(^|\.)joinhandshake\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/(?:stu\/)?(?:jobs|job-search|postings)\/(\d+)/);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

const isHandshake = (url) => {
  try {
    return /(^|\.)joinhandshake\.com$/i.test(new URL(String(url)).hostname);
  } catch (e) {
    return false;
  }
};

const jobUrl = (id, host) => `https://${host || DEFAULT_HOST}/jobs/${id}`;

function searchUrl(o) {
  const q = new URLSearchParams();
  if (o.query) q.set('query', o.query);
  if (!o.partTime) q.append('job.job_types[]', String(INTERNSHIP_TYPE));
  q.set('sort_column', 'created_at');
  q.set('sort_direction', 'desc');
  q.set('page', String(o.page || 1));
  q.set('per_page', String(o.perPage || 50));
  return `/stu/postings?${q}`;
}

/** Hourly pay from Handshake's salary fields (raw values are cents). null when not listed. */
function payPerHour(job) {
  const lo = Number(job && job.salary_min_raw);
  const hi = Number(job && job.salary_max_raw) || lo;
  if (!lo && !hi) return null;
  const sched = String((job.pay_schedule && job.pay_schedule.name) || '').toLowerCase();
  const per = /annual|year/.test(sched) ? 2080 : /month/.test(sched) ? 2080 / 12 : /week/.test(sched) ? 40 : /hour/.test(sched) ? 1 : null;
  if (!per) return null; // stipends, totals: not an hourly rate
  // Employers mislabel the schedule (Pinecrest 2026-10-09: "Annual Salary" 3277-5367 = $32.77-53.67/hr): a rate
  // under the federal minimum that reads as a sane hourly wage is one.
  const unit = (hi || lo) / 100 / per < 7.25 && (hi || lo) / 100 >= 7.25 && (hi || lo) / 100 <= 150 ? 1 : per;
  const h = (c) => Math.round((c / 100 / unit) * 100) / 100;
  return { low: h(lo || hi), high: h(hi || lo), from: 'handshake' };
}

/** One /stu/postings result -> a discover hit (before the apply method is known). */
function toHit(r, host) {
  const j = r.job || {};
  // "Seattle, Washington, United States" -> "Seattle, WA": discover's area regexes read "Washington" as DC.
  const { onePlace } = require('./location');
  const loc = [...new Set((j.location_names || []).map(onePlace).filter(Boolean))].join('; ') || (j.remote ? 'Remote' : '');
  return {
    ats: 'handshake',
    source: 'handshake',
    company: j.employer_name || '',
    board: 'handshake',
    title: j.title || r.job_name || '',
    location: j.remote && !/remote/i.test(loc) ? (loc ? loc + '; Remote' : 'Remote') : loc,
    url: jobUrl(r.job_id || j.id, host),
    handshakeUrl: jobUrl(r.job_id || j.id, host),
    jobId: String(r.job_id || j.id),
    posted: r.created_at || j.created_at || '',
    updated: r.created_at || '',
    hsPay: payPerHour(j),
    expires: r.expiration_date || undefined,
  };
}

const TRACKING = /^(utm_|source$|src$|ref$|gh_src$|iis$|iisn$|codes?$|mode$|jobpipeline$|lang$)/i;

/** The employer's link without tracking params and Workday's /apply tail (so it dedupes with board hits). */
function cleanExternal(url) {
  let u;
  try {
    u = new URL(String(url).trim());
  } catch (e) {
    return null;
  }
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  if (/myworkday(jobs|site)\.com$/i.test(u.hostname)) {
    u.pathname = u.pathname.replace(/\/apply\/?$/, '');
    for (const k of [...u.searchParams.keys()]) u.searchParams.delete(k); // locationCountry / Work_Shift filters
  }
  return u.toString().replace(/\?$/, '');
}

/** Does the link name one posting (an id in it), or is it a careers home page? */
function isSpecific(url) {
  try {
    const u = new URL(url);
    if (/myworkday(jobs|site)\.com$/i.test(u.hostname)) return /\/job\//.test(u.pathname);
    if (/(^|\.)appcast\.io$/i.test(u.hostname)) return true; // a per-posting redirect (bot-checked: the browser follows it)
    return /\d{3,}|[0-9a-f]{8}-[0-9a-f]{4}/i.test(u.pathname + u.search);
  } catch (e) {
    return false;
  }
}

const strip = (html) => String(html || '').replace(/<(br|\/p|\/li|\/h\d)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

/** How to apply, from the GraphQL job: { applyVia, applyUrl, externalUrl?, find? }. */
function resolveApply(job, hit) {
  const s = (job && job.jobApplySetting) || {};
  const type = String(s.applyType || '').toUpperCase();
  const ext = s.externalUrl || s.alternativeExternalUrl || null;
  if (type === 'HANDSHAKE' || type === 'HANDSHAKE_AND_EXTERNAL') return { applyVia: 'handshake', applyUrl: hit.handshakeUrl, externalUrl: ext ? cleanExternal(ext) : undefined };
  if (type === 'EXTERNAL' && String(s.externalApplyType || 'URL').toUpperCase() === 'URL' && ext) {
    const clean = cleanExternal(ext);
    if (clean && isSpecific(clean)) return { applyVia: 'external', applyUrl: clean };
    return { applyVia: 'external-unresolved', applyUrl: hit.handshakeUrl, externalUrl: clean || ext, find: `jobctl find "${hit.company}" "${hit.title}"` };
  }
  return { applyVia: 'other', applyUrl: hit.handshakeUrl, instructions: s.additionalInstructions ? strip(s.additionalInstructions).slice(0, 300) : undefined };
}

const JOB_FIELDS = 'id title description remote locations { name city stateAbbreviation } employer { name } jobApplySetting { applyType externalApplyType externalUrl alternativeExternalUrl additionalInstructions } requiredDocumentTypes { behaviorIdentifier name } screeningQuestions { id question }';

function jobsQuery(ids) {
  return `query {${ids.map((id, i) => ` j${i}: job(id: ${JSON.stringify(String(id))}) { ${JOB_FIELDS} }`).join('')} }`;
}

/** A Handshake response that is the login page (or a redirect to it) instead of data. */
function loggedOut(res) {
  return !!res && (res.status === 401 || res.status === 403 || /\/(login|access|sign_in|sessions\/new)\b/.test(new URL(String(res.url || 'x:/'), 'https://x').pathname));
}

class LoggedOut extends Error {
  constructor(host) {
    super(`Handshake is logged out: the owner must log in once at https://${host || DEFAULT_HOST}/login in the jobbot Firefox (EXU SSO + Duo), then rerun`);
    this.code = 'HANDSHAKE_LOGGED_OUT';
  }
}

/**
 * Search Handshake for fresh internships. `fetcher(path, init)` -> { status, url, json?, text? } runs in a
 * logged-in Handshake tab (browserFetcher below; tests pass fixtures). Pages each query until postings are older
 * than maxAge days. Returns { hits, searched, errors }.
 */
async function search(fetcher, opts) {
  const o = opts || {};
  const host = o.host || DEFAULT_HOST;
  const maxAge = o.maxAge || 7;
  const now = o.now || Date.now();
  const queries = o.query ? [].concat(o.query) : o.partTime ? PART_TIME_QUERIES : QUERIES;
  const maxPages = o.maxPages || 4;
  const byId = new Map();
  const errors = [];
  let searched = 0;
  for (const query of queries) {
    for (let page = 1; page <= maxPages; page++) {
      const res = await fetcher(searchUrl({ query, page, perPage: o.perPage || 50, partTime: o.partTime }));
      searched++;
      if (loggedOut(res)) throw new LoggedOut(host);
      if (!res || !res.json || !Array.isArray(res.json.results)) {
        errors.push(`${query} p${page}: ${res ? res.status : 'no response'}`);
        break;
      }
      let old = false;
      for (const r of res.json.results) {
        const t = Date.parse(r.created_at || '');
        if (Number.isFinite(t) && (now - t) / 86400000 > maxAge) {
          old = true;
          continue;
        }
        if (o.partTime && String((r.job && r.job.employment_type_name) || '') !== 'Part-Time') continue;
        const id = String(r.job_id || (r.job && r.job.id));
        if (!byId.has(id)) byId.set(id, toHit(r, host));
      }
      if (old || page >= (res.json.total_pages || 1)) break;
    }
  }
  return { hits: [...byId.values()], searched, errors };
}

/** GraphQL details for jobs (batched): Map id -> job. */
async function jobDetails(fetcher, ids, host) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += GQL_BATCH) {
    const chunk = ids.slice(i, i + GQL_BATCH);
    const res = await fetcher('/hs/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: jobsQuery(chunk) }) });
    if (loggedOut(res)) throw new LoggedOut(host);
    const data = (res && res.json && res.json.data) || {};
    chunk.forEach((id, k) => data['j' + k] && out.set(String(id), data['j' + k]));
  }
  return out;
}

/**
 * Fill in each hit from its GraphQL job: apply method and URL, required documents, screening questions,
 * gate flags (clearance / unclaimed required skills, lib/posting.js flags on the description) and Handshake's pay.
 * A hit applied to on the employer's ATS gets that URL as `url` (the Handshake one stays in handshakeUrl).
 */
function enrich(hit, job, payFloor) {
  const P = require('./posting');
  const a = resolveApply(job, hit);
  const text = strip(job && job.description);
  const docs = ((job && job.requiredDocumentTypes) || []).map((d) => String(d.behaviorIdentifier || d.name || '').toLowerCase()).filter(Boolean);
  Object.assign(hit, {
    applyVia: a.applyVia,
    url: a.applyUrl,
    ats: a.applyVia === 'external' ? require('./urls').atsOf(a.applyUrl) : 'handshake',
    externalUrl: a.externalUrl,
    find: a.find,
    instructions: a.instructions,
    documents: docs.length ? docs : undefined,
    screeningQuestions: job && job.screeningQuestions && job.screeningQuestions.length ? job.screeningQuestions.map((q) => q.question) : undefined,
    flags: P.flags({ text, location: hit.location }),
    payPerHour: hit.hsPay ? `${hit.hsPay.low}-${hit.hsPay.high}` : null,
  });
  if (hit.ats === 'unknown') hit.ats = 'external';
  const f = hit.flags;
  hit.skip = hit.skip || (f.clearance ? 'clearance' : f.requiresUnclaimed ? `requires ${f.requiresUnclaimed.join(', ')}` : hit.hsPay && hit.hsPay.high < (payFloor || 35) ? `pay under $${payFloor || 35}/hr` : a.applyVia === 'other' ? 'applies by email / other (see instructions)' : undefined);
  delete hit.hsPay;
  return hit;
}

// Link shorteners employers paste into Handshake (Kestrelvale: smrtr.io = SmartRecruiters). One redirect hop, read in
// Node with no cookies. Not appcast.io: it answers a bot check (403), so the browser follows that one itself.
const SHORT = /^(smrtr\.io|bit\.ly|tinyurl\.com|lnkd\.in|t\.co|ow\.ly|buff\.ly|rebrand\.ly|grnh\.se)$/i;

/** The target of a short link (one hop, 10 s); the link itself when it is not one or does not redirect. */
async function unshorten(url, fetchImpl) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return url;
  }
  if (!SHORT.test(u.hostname)) return url;
  try {
    const f = fetchImpl || fetch;
    const res = await Promise.race([f(url, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 jobbot' } }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))]);
    const loc = res.headers && res.headers.get('location');
    return loc ? new URL(loc, url).href : url;
  } catch (e) {
    return url;
  }
}

/** Unresolved hits whose external link is a short link: follow it, then resolve again. */
async function followShortLinks(list, fetchImpl) {
  for (const h of list) {
    if (h.applyVia !== 'external-unresolved' || !h.externalUrl || !SHORT.test(new URL(h.externalUrl).hostname)) continue;
    const target = cleanExternal(await unshorten(h.externalUrl, fetchImpl));
    if (target && target !== h.externalUrl && isSpecific(target)) {
      Object.assign(h, { applyVia: 'external', url: target, ats: require('./urls').atsOf(target), externalUrl: undefined, find: undefined });
      if (h.ats === 'unknown') h.ats = 'external';
    }
  }
  return list;
}

/** A fetcher that runs requests inside a Handshake tab of the jobbot Firefox (opens a background one if needed). */
async function browserFetcher(host) {
  // Never the live browser from a test run (node --test sets NODE_TEST_CONTEXT): tests pass a fixture fetcher.
  // 2026-10-09: scorecard.test's discover() reached the jobbot Firefox and held the shared test lock ~30 min.
  if (process.env.NODE_TEST_CONTEXT || process.env.JOBBOT_NO_BROWSER) throw new Error('Handshake: no live browser under test (pass a fetcher)');
  const C = require('./client');
  const h = host || DEFAULT_HOST;
  const tabs = await C.send('tabs', {}, 10000);
  let tab = tabs.find((t) => (t.url || '').startsWith(`https://${h}/`) && !/\/(login|access)/.test(t.url));
  let opened = null;
  if (!tab) {
    tab = opened = await C.send('open', { url: `https://${h}/job-search`, active: false });
    if (/\/(login|access|sign_in)/.test(tab.url || '') || !(tab.url || '').startsWith(`https://${h}/`)) {
      await C.send('close', { tabId: tab.tabId }).catch(() => {});
      throw new LoggedOut(h);
    }
  }
  const fetcher = async (p, init) => {
    const url = /^https?:/.test(p) ? p : `https://${h}${p}`;
    const res = await C.page(tab.tabId, 'fetchJson', { url, ...(init || {}) }, [0], 60000);
    const r = res[0] || {};
    if (r.error) throw new Error('handshake fetch failed: ' + String(r.error).slice(0, 200));
    return r.result;
  };
  fetcher.close = async () => {
    if (opened) await C.send('close', { tabId: opened.tabId }).catch(() => {});
  };
  return fetcher;
}

/** A fetcher bound to a tab already on Handshake (an apply run's tab). */
function tabFetcher(tabId, host) {
  const C = require('./client');
  const h = host || DEFAULT_HOST;
  return async (p, init) => {
    const url = /^https?:/.test(p) ? p : `https://${h}${p}`;
    const res = await C.page(tabId, 'fetchJson', { url, ...(init || {}) }, [0], 60000);
    const r = res[0] || {};
    if (r.error) throw new Error('handshake fetch failed: ' + String(r.error).slice(0, 200));
    return r.result;
  };
}

const gql = (fetcher, query) => fetcher('/hs/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });

/** The owner's Handshake application for a job ({id, createdAt, status}), or null when there is none. */
async function applicationFor(fetcher, jobId) {
  const res = await gql(fetcher, `query { currentUser { applications(input: { filter: { applicableId: ${JSON.stringify(String(jobId))}, applicableType: JOB } }) { nodes { id createdAt status } } } }`);
  if (loggedOut(res)) throw new LoggedOut();
  const nodes = res && res.json && res.json.data && res.json.data.currentUser && res.json.data.currentUser.applications ? res.json.data.currentUser.applications.nodes : null;
  if (!Array.isArray(nodes)) throw new Error('Handshake applications query failed');
  return nodes[0] || null;
}

/** Job ids the owner has applied to through Handshake (the list Handshake returns: its most recent ones). */
async function appliedJobIds(fetcher) {
  const res = await gql(fetcher, 'query { currentUser { applications(input: { filter: { applicableType: JOB } }) { nodes { applicable { ... on Job { id } } } } } }');
  const nodes = (res && res.json && res.json.data && res.json.data.currentUser && res.json.data.currentUser.applications && res.json.data.currentUser.applications.nodes) || [];
  return new Set(nodes.map((n) => n.applicable && n.applicable.id).filter(Boolean).map(String));
}

/**
 * Handshake hits for discover: search, keep titles that pass `keep(hit)` (discover's intern / role / term
 * filters), then GraphQL details for those only. Returns { hits, searched, kept, errors, loggedOut? }.
 */
async function hits(opts) {
  const o = opts || {};
  const fetcher = o.fetcher || (await browserFetcher(o.host));
  try {
    const s = await search(fetcher, o);
    const kept = s.hits.filter((h) => (o.keep ? o.keep(h) : true));
    const details = await jobDetails(fetcher, kept.map((h) => h.jobId), o.host);
    const out = kept.map((h) => (details.has(h.jobId) ? enrich(h, details.get(h.jobId), o.payFloor) : Object.assign(h, { applyVia: 'unknown', detailError: 'no GraphQL job' })));
    await followShortLinks(out, o.fetchImpl);
    // Applied through Handshake already (its own list): skipped like a tracker hit.
    const applied = await appliedJobIds(fetcher).catch(() => new Set());
    for (const h of out) if (applied.has(h.jobId)) h.skip = 'already applied on Handshake';
    return { hits: out, searched: s.searched, found: s.hits.length, kept: out.length, errors: s.errors };
  } finally {
    if (fetcher.close) await fetcher.close();
  }
}

/** "Albany, NY; Remote" from a GraphQL job's locations. */
function jobLocation(j) {
  const locs = ((j && j.locations) || []).map((l) => (l.city && l.stateAbbreviation ? `${l.city}, ${l.stateAbbreviation}` : l.name)).filter(Boolean);
  if (j && j.remote) locs.push('Remote');
  return [...new Set(locs)].join('; ');
}

/** One posting by URL (for `jobctl apply` / `jobctl posting` on a Handshake link): the enriched hit + text. */
async function job(url, opts) {
  const o = opts || {};
  const id = jobIdOf(url);
  if (!id) throw new Error('not a Handshake job link: ' + url);
  const host = new URL(url).hostname === 'app.joinhandshake.com' ? o.host || DEFAULT_HOST : new URL(url).hostname;
  const fetcher = o.fetcher || (await browserFetcher(host));
  try {
    const d = await jobDetails(fetcher, [id], host);
    const j = d.get(id);
    if (!j) throw new Error(`Handshake job ${id} not found (closed?)`);
    const hit = enrich({ ats: 'handshake', source: 'handshake', company: (j.employer && j.employer.name) || '', title: j.title, location: jobLocation(j), url: jobUrl(id, host), handshakeUrl: jobUrl(id, host), jobId: id }, j);
    await followShortLinks([hit], o.fetchImpl);
    hit.text = strip(j.description);
    return hit;
  } finally {
    if (fetcher.close) await fetcher.close();
  }
}

/**
 * `jobctl apply <handshake link>`: where the application really happens. External -> the employer's ATS link
 * (the usual driver); native -> the Handshake job page (lib/handshake-apply.js). A careers home page or an
 * email-only posting cannot be driven: { url: null, message } names what to do instead.
 */
async function forApply(url, opts) {
  const j = await job(url, opts);
  const base = { company: j.company, role: j.title, location: j.location ? require('./location').normLocation(j.location.split(';')[0]) : '', handshake: j };
  if (j.applyVia === 'external' || j.applyVia === 'handshake') return { ...base, url: j.url };
  if (j.applyVia === 'external-unresolved') return { ...base, url: null, message: `Handshake sends this one to a careers home page (${j.externalUrl}): find the posting with ${j.find}, then apply to that link` };
  return { ...base, url: null, message: `Handshake has no apply link for this one (${j.applyVia})${j.instructions ? ': ' + j.instructions : ''}` };
}

module.exports = { PART_TIME_QUERIES, forApply, jobLocation, tabFetcher, applicationFor, appliedJobIds, unshorten, followShortLinks, DEFAULT_HOST, QUERIES, jobIdOf, isHandshake, jobUrl, searchUrl, payPerHour, toHit, cleanExternal, isSpecific, resolveApply, jobsQuery, loggedOut, LoggedOut, search, jobDetails, enrich, browserFetcher, hits, job, strip };
