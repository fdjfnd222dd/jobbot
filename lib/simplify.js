'use strict';
/*
 * Simplify feed for `jobctl discover`: the SimplifyJobs internship list on GitHub is a daily-curated
 * table of fresh postings from thousands of employers, far beyond the ~170 boards in config/boards.json.
 * We read its raw README (HTML tables), keep the rows that look like the owner's kind of posting, and
 * hand them to discover() in the same shape the ATS board APIs produce, so they get the same filters
 * and the same pay / gate-flag detail pass. Links are cleaned of Simplify tracking and, when the row's
 * ATS board is not in config/boards.json yet, the slug is added so the next run searches the whole board.
 * Pure functions here (parse, normalise, slug-add) are tested offline with a saved README excerpt.
 */
const fs = require('node:fs');
const path = require('node:path');
const D = require('./data');
const { applyUrl, atsOf } = require('./urls');

// Newest season first; the first repo that answers wins. Branch is `dev` (main does not exist).
const REPOS = ['Summer2027-Internships', 'Summer2026-Internships'];
const rawUrl = (repo) => `https://raw.githubusercontent.com/SimplifyJobs/${repo}/dev/README.md`;
const CACHE_MS = 3600000; // 1 h

// Every feed discover reads, all in the same HTML-table shape (company, role, location, apply link, age).
// Simplify misses many Greenhouse boards; Understudy (Keugene11) and RoleInbox (CO0Oper) scrape thousands
// of Greenhouse / Ashby boards nightly, which is where 2026-10-08's Austin / Portland postings turned up.
const FEEDS = [
  { name: 'simplify', urls: REPOS.map(rawUrl), cache: 'simplify-cache.md' },
  { name: 'understudy', urls: ['https://raw.githubusercontent.com/Keugene11/Summer-2027-Tech-Internships/main/README.md'], cache: 'feed-understudy.md' },
  { name: 'roleinbox', urls: ['https://raw.githubusercontent.com/CO0Oper/Internships-jobs/main/README.md'], cache: 'feed-roleinbox.md' },
];

const decode = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
const text = (html) => decode(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** "0d" / "3d" / "2w" / "1mo" / "5h" -> days (a month is 30, i.e. always stale); "2026-10-07" -> days since. */
function parseAge(s, now) {
  const iso = String(s || '').trim().match(/^(\d{4}-\d{2}-\d{2})$/);
  if (iso) {
    const t = Date.parse(iso[1] + 'T00:00:00Z');
    return Number.isFinite(t) ? Math.max(0, Math.floor(((now || Date.now()) - t) / 86400000)) : null;
  }
  const m = String(s || '').trim().match(/^(\d+)\s*(mo|d|w|h|m|y)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  return u === 'h' ? n / 24 : u === 'd' ? n : u === 'w' ? n * 7 : u === 'mo' ? n * 30 : u === 'y' ? n * 365 : 0;
}

/** Drop tracking, keep the posting. Simplify adds utm_*, ref=Simplify; Ashby gets embed=true. */
function cleanLink(href) {
  let u;
  try {
    u = new URL(decode(href));
  } catch (e) {
    return null;
  }
  for (const k of [...u.searchParams.keys()]) {
    if (/^utm_/i.test(k) || /^(ref|embed|src|source)$/i.test(k)) u.searchParams.delete(k);
  }
  return applyUrl(u.toString());
}

const isSimplifyHost = (url) => {
  try {
    return /(^|\.)simplify\.jobs$/.test(new URL(url).hostname);
  } catch (e) {
    return false;
  }
};

/** The feed writes "SF" / "LA"; expand so the shared PLACES filter recognises them. */
function locationText(cell) {
  const parts = [];
  const details = cell.match(/<details>[\s\S]*?<\/summary>([\s\S]*?)<\/details>/i);
  const body = details ? details[1] : cell;
  for (const p of body.split(/<br\s*\/?>/i)) {
    const t = text(p);
    if (!t) continue;
    parts.push(t === 'SF' ? 'San Francisco, CA' : t === 'LA' ? 'Los Angeles, CA' : t);
  }
  return parts.join('; ');
}

/**
 * README (HTML tables) -> rows {company, title, location, url, simplifyUrl, ageDays, closed}.
 * "↳" in the company cell means the previous row's company. Closed (🔒) rows are dropped here.
 * Markdown pipe tables are handled too, in case the repo changes format back.
 */
function parse(src) {
  const rows = [];
  let lastCompany = '';
  const push = (cells) => {
    if (cells.length < 5) return;
    const [coCell, roleCell, locCell, appCell, ageCell] = cells;
    let company = text(coCell).replace(/[🔥🎓🛂🇺🇸🔒]/gu, '').trim();
    if (company === '↳' || !company) company = lastCompany;
    else lastCompany = company;
    const closed = /🔒/.test(coCell + roleCell + appCell);
    const links = [...appCell.matchAll(/href="([^"]+)"/g)].map((m) => decode(m[1])).concat([...appCell.matchAll(/\]\((https?:[^)\s]+)\)/g)].map((m) => m[1]));
    const direct = links.find((l) => !isSimplifyHost(l));
    const simplifyUrl = links.find((l) => isSimplifyHost(l)) || null;
    const raw = direct || simplifyUrl;
    const title = text(roleCell).replace(/[🎓🛂🇺🇸🔒]/gu, '').trim();
    if (!raw || !title || !company) return;
    rows.push({ company, title, location: locationText(locCell), url: cleanLink(raw), direct: !!direct, simplifyUrl, ageDays: parseAge(text(ageCell)), closed });
  };
  for (const m of String(src).matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
    if (/<th[\s>]/i.test(m[1])) continue;
    push([...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]));
  }
  for (const line of String(src).split('\n')) {
    if (!/^\|.*\|\s*$/.test(line) || /^\|\s*-/.test(line) || /\|\s*Company\s*\|/i.test(line)) continue;
    push(line.replace(/^\||\|\s*$/g, '').split(/(?<!\\)\|/).map((c) => c.trim()));
  }
  return rows.filter((r) => !r.closed);
}

/** Rows -> discover() postings: fresh (<= maxAge), with a usable (non-redirect) link. Role/US filters stay in discover. */
function toPostings(rows, maxAge, now, source) {
  const day = 86400000;
  const t = now || Date.now();
  return rows
    .filter((r) => r.ageDays != null && r.ageDays <= maxAge && r.url)
    .map((r) => ({ ats: atsOf(r.url), company: r.company, board: r.company, title: r.title, location: r.location, url: r.url, posted: new Date(t - r.ageDays * day).toISOString(), updated: '', source: source || 'simplify' }));
}

/** The board a link belongs to: {ats:'greenhouse'|'lever'|'ashby', slug} or {ats:'workday', tenant, wd, site}; null otherwise. */
function boardOf(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return null;
  }
  const ats = atsOf(url);
  const seg = u.pathname.split('/').filter(Boolean);
  if (ats === 'greenhouse') {
    const slug = u.searchParams.get('for') || (/^(embed|v1)$/.test(seg[0] || '') ? null : seg[0]);
    return slug && /^[a-z0-9_-]+$/i.test(slug) ? { ats, slug } : null;
  }
  if ((ats === 'lever' || ats === 'ashby') && seg[0] && /^[a-z0-9_.-]+$/i.test(seg[0])) return { ats, slug: seg[0] };
  if (ats === 'workday') {
    const m = u.hostname.match(/^([^.]+)\.(wd\d+)\.myworkdayjobs\.com$/i);
    if (!m) return null;
    const site = seg.find((s) => !/^[a-z]{2}-[A-Z]{2}$/.test(s));
    return site && site !== 'job' ? { ats, tenant: m[1], wd: m[2], site } : null;
  }
  // Oracle HCM (2026-10-12): discover reads its requisition API per host + site.
  const om = u.hostname.match(/oraclecloud\.com$/i) && u.pathname.match(/\/CandidateExperience\/[a-z-]+\/sites\/([^/]+)\//i);
  if (om) return { ats: 'oracle', host: u.hostname.toLowerCase(), site: om[1] };
  return null;
}

/**
 * Pure: boards object + links -> {boards (new object), added: ['greenhouse:slug', ...]}.
 * Slugs compare case-insensitively; existing entries and the file's key order are untouched, new
 * ones are appended to the end of their list (the file's existing style).
 */
function addBoards(boards, urls, names) {
  const out = { ...boards };
  for (const k of ['greenhouse', 'lever', 'ashby', 'workday', 'oracle']) out[k] = (boards[k] || []).slice();
  const added = [];
  for (const url of urls) {
    const b = boardOf(url);
    if (!b) continue;
    if (b.ats === 'oracle') {
      if (out.oracle.some((w) => w.host === b.host && w.site.toLowerCase() === b.site.toLowerCase())) continue;
      out.oracle.push({ host: b.host, site: b.site, company: names && names[url] });
      added.push(`oracle:${b.host}/${b.site}`);
    } else if (b.ats === 'workday') {
      if (out.workday.some((w) => w.tenant.toLowerCase() === b.tenant.toLowerCase() && w.site.toLowerCase() === b.site.toLowerCase())) continue;
      out.workday.push({ tenant: b.tenant, wd: b.wd, site: b.site });
      added.push(`workday:${b.tenant}/${b.site}`);
    } else {
      if (out[b.ats].some((s) => String(s).toLowerCase() === b.slug.toLowerCase())) continue;
      out[b.ats].push(b.slug);
      added.push(`${b.ats}:${b.slug}`);
    }
  }
  return { boards: out, added };
}

/** README text, cached 1 h in data/simplify-cache.md (a stale cache is used when the network fails).
 *  opts.urls / opts.cacheFile read another feed (FEEDS). */
async function readme(opts) {
  const o = opts || {};
  const urls = o.urls || REPOS.map(rawUrl);
  const file = o.cacheFile || path.join(D.DATA_DIR, 'simplify-cache.md');
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < CACHE_MS) return { text: fs.readFileSync(file, 'utf8'), cached: true };
  } catch (e) {
    /* no cache */
  }
  const f = o.fetch || fetch;
  let lastErr;
  for (const repo of urls) {
    try {
      const res = await Promise.race([f(repo, { headers: { 'user-agent': 'jobbot-discover' } }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))]);
      if (!res.ok) throw new Error(`${res.status} ${repo}`);
      const body = await res.text();
      if (!/<tr>|\|\s*Company/i.test(body)) throw new Error(`no table in ${repo}`);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body);
      } catch (e) {
        /* cache is best-effort */
      }
      return { text: body, cached: false, repo };
    } catch (e) {
      lastErr = e;
    }
  }
  try {
    return { text: fs.readFileSync(file, 'utf8'), cached: true, stale: true, error: lastErr.message };
  } catch (e) {
    throw lastErr;
  }
}

module.exports = { parse, parseAge, cleanLink, toPostings, boardOf, addBoards, readme, REPOS, FEEDS };
