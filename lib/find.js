'use strict';
/*
 * `jobctl find "<company>" "<title>" [--city X]`: the owner screenshots a LinkedIn listing; this resolves it
 * to the real ATS posting. Search order (stops as soon as one hit scores as a strong match):
 *   a) boards already in config/boards.json whose name / slug matches the company,
 *   b) slug guesses from the company name on Greenhouse, Ashby, Lever,
 *   c) Workday tenants (<slug>.wd1/wd3/wd5/wd12.myworkdayjobs.com, common site names) via the cxs JSON API.
 * The fetchers are injectable so the order and the matching are tested offline (tests/find.test.js).
 * Nothing is applied to and no browser is opened. A board found by a guess is added to config/boards.json.
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./paths');
const U = require('./urls');

const STRONG = 0.8; // a hit this good ends the search
const MIN_SHOWN = 0.35; // below this a title is not a candidate at all
const FETCH_MS = 10000;
const CONCURRENCY = 6;
const WD_HOSTS = ['wd1', 'wd5', 'wd3', 'wd12'];

// Words that say nothing about the company's name when we guess a slug.
const SUFFIXES = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'company', 'co', 'technologies', 'technology', 'labs', 'lab', 'group', 'holdings', 'plc', 'lp', 'the']);

const compact = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

/** Slug guesses for a company name, best first: joined, dashed, first word (suffixes dropped), plus the unstripped join. */
function slugGuesses(company) {
  const words = String(company || '').toLowerCase().replace(/&/g, ' and ').replace(/['’.]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  let core = words.filter((w) => !SUFFIXES.has(w));
  if (!core.length) core = words;
  const out = [];
  const add = (x) => x && x.length >= 2 && !out.includes(x) && out.push(x);
  add(core.join(''));
  add(core.join('-'));
  add(core[0]);
  add(words.join(''));
  add(words.join('-'));
  return out;
}

/** Boards in config/boards.json that look like this company: [{ats, slug} | {ats:'workday', tenant, wd, site}]. */
function boardMatches(boards, company) {
  const names = slugGuesses(company).map(compact);
  const full = compact(company);
  const like = (slug) => {
    const c = compact(slug);
    if (!c) return false;
    if (names.includes(c) || c === full) return true;
    return c.length >= 4 && names.some((n) => n.length >= 4 && (n.startsWith(c) || c.startsWith(n)));
  };
  const out = [];
  for (const ats of ['greenhouse', 'ashby', 'lever']) for (const slug of (boards && boards[ats]) || []) if (like(slug)) out.push({ ats, slug });
  for (const w of (boards && boards.workday) || []) if (like(w.tenant)) out.push({ ats: 'workday', tenant: w.tenant, wd: w.wd, site: w.site });
  return out;
}

/** Workday site names to try for a tenant slug, most common first. */
function workdaySites(slug) {
  const cap = slug.charAt(0).toUpperCase() + slug.slice(1);
  return [...new Set(['External', cap, `${cap}_Careers`, 'Careers', 'ExternalCareers', 'External_Careers', `${cap}External`])];
}

// ---- title matching ----
const NOISE = new Set(['summer', 'fall', 'spring', 'winter', 'class', 'of', 'the', 'a', 'an', 'and', 'for', 'to', 'in', 'at', 'with', 'program', 'programme', 'early', 'career', 'student', 'undergraduate', 'graduate', 'us', 'usa']);
const INTERN = /\b(intern(ship)?s?|co-?op)\b/i;

function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Title -> comparable tokens: lowercase, no seasons / years / "intern(ship)" (see isIntern), light stemming. */
function tokens(title) {
  return String(title || '').toLowerCase().replace(/&/g, ' and ').replace(/\b(19|20)\d\d\b/g, ' ').replace(/\bintern(ship)?s?\b|\bco-?op\b/g, ' ').replace(/[^a-z0-9+#]+/g, ' ').split(' ').filter((w) => w && !NOISE.has(w)).map(stem);
}
const tokMatch = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

/**
 * 0..1 similarity of a posting title to the wanted one. Share of the query's words found in the title
 * (70%) and of the title's words found in the query (30%); a query that says intern needs an intern title.
 */
function titleScore(query, title) {
  if (INTERN.test(query) && !INTERN.test(title)) return 0;
  const q = tokens(query);
  const t = tokens(title);
  if (!q.length) return INTERN.test(title) ? 0.5 : 0;
  if (!t.length) return 0;
  const qHit = q.filter((x) => t.some((y) => tokMatch(x, y))).length;
  const tHit = t.filter((y) => q.some((x) => tokMatch(x, y))).length;
  return Math.round((0.7 * (qHit / q.length) + 0.3 * (tHit / t.length)) * 1000) / 1000;
}

const CITY_ALIAS = { nyc: 'new york', ny: 'new york', sf: 'san francisco', la: 'los angeles', dc: 'washington', rtp: 'research triangle' };

/** 'match' | 'mismatch' | 'unknown' (empty, remote or "3 Locations" listings cannot be judged). */
function cityState(city, location) {
  if (!city) return 'unknown';
  const loc = String(location || '').toLowerCase();
  if (!loc.trim() || /^\s*\d+\s+locations?\s*$/.test(loc)) return 'unknown';
  const want = String(city).toLowerCase().trim();
  const names = [want, CITY_ALIAS[want]].filter(Boolean);
  if (names.some((n) => new RegExp(`(^|[^a-z])${n.replace(/[^a-z0-9 ]/g, '')}([^a-z]|$)`).test(loc))) return 'match';
  if (/\bremote\b/.test(loc)) return 'unknown';
  return 'mismatch';
}

/** Rank postings: title score, +0.1 for the wanted city, -0.2 for a different one. */
function rank(postings, title, city) {
  return postings
    .map((p) => {
      const base = titleScore(title, p.title);
      const c = cityState(city, p.location);
      // Same role in a term the query did not ask for (spring / fall / winter) ranks just below.
      const off = /\b(spring|fall|winter)\b/i.test(p.title) && !/\b(spring|fall|winter)\b/i.test(title) ? 0.02 : 0;
      const score = base === 0 ? 0 : Math.max(0, Math.round((Math.min(1, base + (c === 'match' ? 0.1 : c === 'mismatch' ? -0.2 : 0)) - off) * 1000) / 1000);
      return { ...p, titleScore: base, city: city ? c : undefined, score };
    })
    .filter((p) => p.score >= MIN_SHOWN)
    .sort((a, b) => b.score - a.score);
}

// ---- fetching ----
const shortErr = (e) => { const m = String(e.message || e); return (m.match(/^\d{3}/) || [m.slice(0, 40)])[0]; };
const race = (p, ms) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error('timeout')), ms)))]).finally(() => clearTimeout(t));
};

/**
 * Workday cxs search for one tenant/site. The API ranks loosely (an "intern" search on a big tenant returns
 * unrelated jobs first), so search the full title and the title without "intern", 3 pages (60 hits) each.
 */
async function workdaySearch(w, text) {
  const { getJson, workdayPosted } = require('./discover');
  const base = `https://${w.tenant}.${w.wd}.myworkdayjobs.com`;
  const page = (searchText, offset) => getJson(`${base}/wday/cxs/${w.tenant}/${w.site}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText }) });
  const first = await page(text, 0); // a wrong tenant / site fails here, before any further requests
  if (!first || !Array.isArray(first.jobPostings)) throw new Error('not a Workday site');
  const bare = tokens(text).join(' ');
  const more = [[text, 20], [text, 40]].concat(bare && bare !== text.toLowerCase() ? [[bare, 0], [bare, 20]] : []);
  const rest = await Promise.all(more.map(([t, o]) => page(t, o).catch(() => ({}))));
  const seen = new Set();
  return [first].concat(rest).flatMap((d) => d.jobPostings || []).filter((j) => !seen.has(j.externalPath) && seen.add(j.externalPath))
    .map((j) => ({ ats: 'workday', company: w.tenant, board: w.tenant, title: j.title, location: j.locationsText || '', url: `${base}/${w.site}${j.externalPath}`, posted: workdayPosted(j.postedOn) }));
}

function defaultFetchers() {
  const X = require('./discover');
  return { greenhouse: X.greenhouse, ashby: X.ashby, lever: X.lever, workday: workdaySearch, posting: (u) => require('./posting').posting(u) };
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/**
 * Resolve a listing. opts: city, boards (object; default config/boards.json), fetchers (see defaultFetchers),
 * saveBoards(urls) -> added[] (default writes config/boards.json), noPosting.
 */
async function find(company, title, opts) {
  const o = opts || {};
  const f = { ...defaultFetchers(), ...(o.fetchers || {}) };
  const boards = o.boards || JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'boards.json'), 'utf8'));
  const tried = [];
  let hits = [];
  let known = true; // best hit came from a board already in boards.json
  const seen = new Set();
  const best = () => hits[0];
  const strong = () => best() && best().score >= STRONG;
  const take = (list, fromKnown) => {
    const before = best();
    for (const p of rank(list, title, o.city)) if (!seen.has(p.url)) (seen.add(p.url), hits.push(p));
    hits.sort((a, b) => b.score - a.score);
    if (best() && best() !== before) known = fromKnown;
  };
  const run = async (label, fn) => {
    const t = { source: label, ok: false };
    tried.push(t);
    try {
      const list = await race(fn(), FETCH_MS);
      t.ok = true;
      t.postings = list.length;
      return list;
    } catch (e) {
      t.error = shortErr(e);
      return [];
    }
  };
  const byAts = { greenhouse: f.greenhouse, ashby: f.ashby, lever: f.lever };

  // (a) boards we already have for this company
  const mine = boardMatches(boards, company);
  const have = new Set(mine.map((b) => `${b.ats}:${(b.slug || b.tenant).toLowerCase()}`));
  await pool(mine, CONCURRENCY, async (b) => {
    if (b.ats === 'workday') take(await run(`config:workday:${b.tenant}.${b.wd}/${b.site}`, () => f.workday(b, title)), true);
    else take(await run(`config:${b.ats}:${b.slug}`, () => byAts[b.ats](b.slug)), true);
  });

  // (b) slug guesses on Greenhouse, Ashby, Lever (one ATS at a time so a strong hit stops the rest)
  const slugs = slugGuesses(company);
  for (const ats of ['greenhouse', 'ashby', 'lever']) {
    if (strong()) break;
    const todo = slugs.filter((s) => !have.has(`${ats}:${s}`));
    await pool(todo, CONCURRENCY, async (s) => {
      if (strong()) return;
      take(await run(`${ats}:${s}`, () => byAts[ats](s)), false);
    });
  }

  // (c) Workday: slug x wdN x site names. One host at a time walks its sites; a dead host (DNS) skips them all.
  if (!strong()) {
    const combos = [];
    for (const s of slugs.slice(0, 3)) for (const wd of WD_HOSTS) if (!mine.some((b) => b.ats === 'workday' && b.tenant === s && b.wd === wd)) combos.push({ tenant: s, wd });
    await pool(combos, CONCURRENCY, async (h) => {
      for (const site of workdaySites(h.tenant)) {
        if (strong()) return;
        const label = `workday:${h.tenant}.${h.wd}/${site}`;
        const t = { source: label, ok: false };
        tried.push(t);
        try {
          const list = await race(f.workday({ ...h, site }, title), FETCH_MS);
          t.ok = true;
          t.postings = list.length;
          take(list, false);
          return; // the tenant exists and this was its site: no need for the other site names
        } catch (e) {
          t.error = shortErr(e);
          if (/fetch failed|ENOTFOUND|timeout/i.test(String(e.message))) return; // host does not exist / is dead
        }
      }
    });
  }

  const res = { query: { company, title, city: o.city || null }, tried: tried.map((t) => (t.ok ? `${t.source} (${t.postings} postings)` : `${t.source} (${t.error})`)) };
  if (!best() || best().score < 0.5) {
    return { found: false, ...res, candidates: hits.slice(0, 5).map(brief), message: `not found: no posting matching "${title}" at "${company}" on any board tried` };
  }
  const b = best();
  res.found = true;
  res.best = { ...brief(b), url: U.applyUrl(b.url), postingUrl: b.url };
  res.confidence = b.score >= STRONG ? 'strong' : 'weak (check the title)';
  res.candidates = hits.slice(1, 5).map(brief);
  if (!known) {
    try {
      res.boardsAdded = (o.saveBoards || saveBoards)([b.url]);
    } catch (e) {
      res.boardsAdded = [];
    }
  }
  if (!o.noPosting) {
    try {
      const p = await f.posting(b.url);
      p.text = String(p.text || '').slice(0, 1500);
      res.posting = p;
    } catch (e) {
      res.postingError = e.message;
    }
  }
  return res;
}

const brief = (p) => ({ score: p.score, title: p.title, company: p.company, location: p.location, ats: p.ats, url: U.applyUrl(p.url), posted: p.posted || null, city: p.city });

/** Add the board behind a found posting to config/boards.json (pure addBoards + write). */
function saveBoards(urls) {
  const file = path.join(ROOT, 'config', 'boards.json');
  const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { boards, added } = require('./simplify').addBoards(cur, urls);
  if (added.length) fs.writeFileSync(file, JSON.stringify(boards, null, 2));
  return added;
}

module.exports = { find, slugGuesses, boardMatches, workdaySites, tokens, titleScore, cityState, rank, saveBoards, STRONG };
