'use strict';
/*
 * Which ATS a link belongs to, and the most direct URL of its application
 * form (docs/ATS-FLOWS.md). Going straight to the form skips the job page's
 * Apply button, its new-tab links and cross-origin embeds.
 */

const ATS = [
  ['greenhouse', /(^|\.)greenhouse\.io$/],
  ['lever', /^jobs\.(eu\.)?lever\.co$/],
  ['ashby', /^jobs\.ashbyhq\.com$/],
  ['workday', /\.myworkdayjobs\.com$|\.myworkdaysite\.com$/],
  ['icims', /\.icims\.com$/],
  ['smartrecruiters', /smartrecruiters\.com$/],
  ['oracle', /\.oraclecloud\.com$/],
  ['taleo', /\.taleo\.net$/],
  ['jobvite', /jobvite\.com$/],
  ['bamboohr', /\.bamboohr\.com$/],
  ['workable', /^apply\.workable\.com$/],
  ['rippling', /^ats\.rippling\.com$/],
  ['eightfold', /eightfold\.ai$/],
  ['handshake', /(^|\.)joinhandshake\.com$/], // EXU's student board: native applies run in lib/handshake-apply.js
];

function atsOf(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (e) {
    return 'unknown';
  }
  const hit = ATS.find(([, re]) => re.test(host));
  return hit ? hit[0] : 'unknown';
}

/** LinkedIn / Google / mail tracking wrappers -> the real link. */
function unwrap(url) {
  let u = String(url).trim();
  for (let i = 0; i < 3; i++) {
    let parsed;
    try {
      parsed = new URL(u);
    } catch (e) {
      return u;
    }
    const inner = parsed.searchParams.get('url') || parsed.searchParams.get('u') || parsed.searchParams.get('q');
    const wrapper = /(^|\.)linkedin\.com$/.test(parsed.hostname) && /\/(safety\/go|redir)/.test(parsed.pathname)
      || /(^|\.)google\.com$/.test(parsed.hostname) && parsed.pathname === '/url'
      || /safelinks\.protection\.outlook\.com$/.test(parsed.hostname);
    if (wrapper && inner && /^https?:/i.test(inner)) u = inner;
    else return u;
  }
  return u;
}

/** The application form URL for a posting link (unchanged when there is no known shortcut). */
function applyUrl(url) {
  const raw = unwrap(url);
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return raw;
  }
  const ats = atsOf(raw);
  const path = u.pathname.replace(/\/+$/, '');
  const set = (p) => {
    u.pathname = p;
    return u.toString();
  };
  // Lever: /{company}/{uuid} -> /{company}/{uuid}/apply
  if (ats === 'lever' && /^\/[^/]+\/[0-9a-f-]{36}$/i.test(path)) return set(path + '/apply');
  // Ashby: /{company}/{uuid} -> /{company}/{uuid}/application
  if (ats === 'ashby' && /^\/[^/]+\/[0-9a-f-]{36}$/i.test(path)) return set(path + '/application');
  // Workable: /{company}/j/{shortcode} -> .../apply
  if (ats === 'workable' && /^\/[^/]+\/j\/[^/]+$/.test(path)) return set(path + '/apply/');
  // Rippling: /{board}/jobs/{uuid} -> .../apply
  if (ats === 'rippling' && /\/jobs\/[0-9a-f-]{36}$/i.test(path)) return set(path + '/apply');
  // Jobvite: /{company}/job/{id} -> .../apply
  if (ats === 'jobvite' && /^\/[^/]+\/job\/[^/]+$/.test(path)) return set(path + '/apply');
  // Taleo: jobdetail.ftl -> jobapply.ftl (same query)
  if (ats === 'taleo' && /jobdetail\.ftl$/.test(path)) return set(path.replace(/jobdetail\.ftl$/, 'jobapply.ftl'));
  // Greenhouse: /{board}/jobs/{id} -> the form-only embed page. Boards with a custom careers site
  // (Glenfield) redirect the job page there, where the form sits in a cross-origin iframe the agent
  // can't read; the embed page never redirects.
  const ghHost = /(^|\.)eu\.greenhouse\.io$/.test(u.hostname) ? 'job-boards.eu.greenhouse.io' : 'job-boards.greenhouse.io';
  const gh = (board, id) => `https://${ghHost}/embed/job_app?for=${encodeURIComponent(board)}&token=${id}`;
  const ghPath = path.match(/^\/([^/]+)\/jobs\/(\d+)$/);
  if (ats === 'greenhouse' && ghPath && ghPath[1] !== 'embed') return gh(ghPath[1], ghPath[2]);
  // A company careers page wrapping a Greenhouse board (?gh_jid=ID&for=BOARD rarely both present):
  const ghj = u.searchParams.get('gh_jid');
  const board = u.searchParams.get('for');
  if (ghj && board && /^\d+$/.test(ghj)) return gh(board, ghj);
  return u.toString();
}

/**
 * One key per posting, for duplicate checks: host + path, plus the query params that name the posting
 * (Greenhouse embed `for` + `token`, `gh_jid`, Taleo `job`). Without them every Greenhouse embed link
 * looked like the same posting (Copperfield was refused as "already applied" after Northfield, 2026-10-07).
 */
function postingKey(url) {
  try {
    // Greenhouse job IDs are global: careers-site ?gh_jid=, /jobs/ID and embed ?token= are one posting.
    const raw = new URL(unwrap(url));
    const ghId = raw.searchParams.get('gh_jid') || (atsOf(raw.href) === 'greenhouse' && (raw.searchParams.get('token') || (raw.pathname.match(/\/jobs\/(\d+)/) || [])[1]));
    if (ghId && /^\d+$/.test(ghId)) return `greenhouse:${ghId}`;
    const x = new URL(applyUrl(url));
    const ID_PARAMS = ['for', 'token', 'gh_jid', 'job', 'jobid', 'id', 'pid', 'reqid', 'requisitionid', 'postingid'];
    const params = new Map([...x.searchParams].map(([k, v]) => [k.toLowerCase(), v]));
    const keep = ID_PARAMS.filter((q) => params.get(q))
      .map((q) => `${q}=${params.get(q)}`)
      .join('&');
    // Workday and others put a locale in the path (/en-US/External/job/...): same posting.
    const pathname = x.pathname.replace(/\/[a-z]{2}-[A-Z]{2}(?=\/)/, '');
    const base = (x.hostname + pathname).replace(/\/(apply|application|thanks|confirmation)\/?$/, '').replace(/\/+$/, '').toLowerCase();
    return keep ? `${base}?${keep.toLowerCase()}` : base;
  } catch (e) {
    return String(url);
  }
}

module.exports = { atsOf, unwrap, applyUrl, postingKey };
