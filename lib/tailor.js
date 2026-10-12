'use strict';
/*
 * `jobctl tailor <url>`: a head start for the resume-tailor pass. Reads the posting (lib/posting.js),
 * then ranks the approved alternate bullets in tailor/references/facts.md by how many of the posting's
 * terms they share, lists the confirmed skills the posting names (lead the skills rows with these), and the
 * DO NOT CLAIM / never-confirmed items it mentions (gaps: never put them on the resume). It only proposes;
 * the resume skill still decides and writes. Everything it suggests comes from facts.md, so it can't invent.
 *
 * Two more modes (2026-10-09, to cut the ~6 turns a resume used to take):
 *   jobctl tailor <url> --build <slug> [--from <prior-slug>] [--company C] [--text-file F] [--force]
 *       deterministic first draft: starts from the prior tailored resume (or master.json) that best matches the
 *       posting, puts the skills the posting names first (reorder only, never adds), applies the grad-date rule,
 *       writes data/resumes/<slug>.json, renders it, lints it. Bullet wording is left to the model.
 *   jobctl tailor --check <resume.json> [--company C]
 *       the never-untrue lint (tailor/lint.js): exit 2 on a DO NOT CLAIM item, em dash, other company's name,
 *       invented number...; lists every reworded bullet with its closest source line.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, RESUMES } = require('./paths');
const L = require('../tailor/lint');

const FACTS = path.join(ROOT, 'tailor', 'references', 'facts.md');
const RENDER = path.join(ROOT, 'tailor', 'render.sh');

const STOP = new Set('open through field time life case four five six weeks daily like via the and for are you our one fits not but all any can may per via its was has had who how why yet own new use out get set top key two such each well very most must should would could just only over under then them these those with that this from your will have they their about into across more than what when where which while also using used work team teams other help able strong based role roles intern interns internship summer students student experience including within year years build built'.split(' '));

function words(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9+#/. -]/g, ' ')
    .split(/\s+/)
    .flatMap((w) => (w.includes('/') && w.length <= 8 ? [w] : w.split('/'))) // keep CI/CD, TCP/IP whole
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((w) => (w.length >= 3 || w.includes('/')) && !STOP.has(w));
}

/**
 * Parse facts.md. Alternates are the quoted bullets under sections 2 (experience) and 3 (projects); a quote may
 * wrap onto an indented continuation line. Section 1 (identity) holds the grad-date rule and the clearance line;
 * section 4 the skill lists (confirmed, light use, DO NOT CLAIM, never confirmed).
 */
function readFacts(file) {
  const t = fs.readFileSync(file || FACTS, 'utf8');
  const parts = t.split(/^## (\d+)\.[^\n]*\n/m); // [pre, '1', body1, '2', body2, ...]
  const sec = {};
  for (let i = 1; i < parts.length; i += 2) sec[parts[i]] = parts[i + 1];

  // Logical lines: an indented line continues the line above it. Section 3 lines are tagged with their project.
  const logical = [];
  for (const [n, body] of [[2, sec[2] || ''], [3, sec[3] || '']]) {
    for (const raw of body.split('\n')) {
      if (/^\s+\S/.test(raw) && logical.length) logical[logical.length - 1].line += ' ' + raw.trim();
      else logical.push({ n, line: raw });
    }
  }
  const alternates = [];
  let section = '';
  let heading = ''; // the whole heading line: the lint finds the job an alternate belongs to from it
  for (const { n, line } of logical) {
    const h = line.match(/^###\s+(.*)/) || (n === 3 && line.match(/^-\s+([^:(,]+)/));
    if (h) {
      section = h[1].split(',')[0].trim();
      heading = h[1].trim();
    }
    // Only real bullets: lines that are an alternate ("- \"...\"") or an "Alternates:" line.
    if (!/^\s*-\s|Alternates?:/.test(line)) continue;
    // Quotes pair up in order, so a stray quote earlier on the line cannot shift the pairing.
    for (const m of line.matchAll(/"([^"]*)"(?:\s*\(([^)]*)\))?/g)) if (m[1].length >= 25) alternates.push({ section, heading, text: m[1], note: m[2] || '' });
  }

  const s4 = sec[4] || '';
  const stripParens = (s) => s.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  const items = (block) => L.splitTop((block || '').replace(/\n/g, ' ')).map((x) => x.replace(/\.$/, '').trim()).filter(Boolean);
  const confirmedRaw = items((s4.match(/Confirmed: ([\s\S]*?)\n(?:Light use|\n)/) || [])[1]);
  const lightRaw = items((s4.match(/Light use \([^)]*\): ([^\n]*)/) || [])[1]);
  const dncRaw = items((s4.match(/DO NOT CLAIM \([^\n]*\n([\s\S]*?)\n(?:Never confirmed|\n)/) || [])[1]);
  const neverRaw = items((s4.match(/Never confirmed \([^\n]*\): ([\s\S]*?)(?:\. If a posting|\n\n)/) || [])[1]);
  const short = (xs) => xs.map(stripParens).filter((s) => s && s.length < 30);
  const s1 = sec[1] || '';
  return {
    alternates,
    confirmed: short(confirmedRaw),
    lightUse: short(lightRaw),
    doNotClaim: short(dncRaw),
    neverConfirmed: short(neverRaw),
    doNotClaimRaw: dncRaw,
    neverConfirmedRaw: neverRaw,
    skillsRowOnly: confirmedRaw.filter((x) => /skills row only/i.test(x)).map(stripParens),
    gradDefault: (s1.match(/default "([^"]+)"/) || [])[1],
    gradAlt: (s1.match(/OK using\s+"([^"]+)"/) || [])[1],
    clearanceLine: (s1.match(/Clearance line[^\n]*:\s*"([^"]+)"/) || [])[1],
    coursework: sec[5] || '',
    text: t,
  };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Short or all-caps terms (Go, SQL, C#, RAG) match case-sensitively: "go" and "rag" are ordinary words.
const termRe = (term, g) => new RegExp(`(^|[^A-Za-z])${esc(term)}(?![A-Za-z+#])`, (/^[A-Z+#]+$/.test(term) || term.length <= 3 ? '' : 'i') + (g ? 'g' : ''));
const mentions = (text, term) => termRe(term).test(text);

/** Rank facts.md alternates against a posting text; pure, for tests. */
function suggest(text, facts, company) {
  const own = String(company || '').toLowerCase();
  const counts = new Map();
  for (const w of words(text)) counts.set(w, (counts.get(w) || 0) + 1);
  const df = new Map();
  for (const a of facts.alternates) for (const w of new Set(words(a.text))) df.set(w, (df.get(w) || 0) + 1);
  const ranked = facts.alternates
    .map((a) => {
      const shared = [...new Set(words(a.text))].filter((w) => counts.has(w)); // the note is guidance, not content
      return { ...a, score: shared.reduce((s, w) => s + Math.min(3, counts.get(w)) / df.get(w), 0), shared };
    })
    .filter((a) => a.score > 0)
    .sort((x, y) => y.score - x.score);
  return {
    alternates: ranked.slice(0, 10).map((a) => ({ section: a.section, text: a.text, note: a.note || undefined, shared: a.shared.slice(0, 8) })),
    leadSkills: facts.confirmed.filter((s) => mentions(text, s)),
    gaps: [...facts.doNotClaim, ...facts.neverConfirmed].filter((s) => s.toLowerCase() !== own && mentions(text, s)),
  };
}

/** The posting: from its ATS API, or (for portals with no API) from a text file saved by `jobctl jd`. */
async function loadPosting(url, opts = {}) {
  if (opts.posting) return opts.posting;
  if (opts.textFile) {
    if (!opts.company) throw new Error('--text-file needs --company <Name> (no ATS API to read the company from)');
    return { company: opts.company, title: opts.title || '', text: fs.readFileSync(opts.textFile, 'utf8'), flags: {} };
  }
  return require('./posting').posting(url);
}

async function tailor(url, opts = {}) {
  const p = await loadPosting(url, opts);
  return { company: p.company, title: p.title, ageDays: p.ageDays, payPerHour: p.payPerHour, flags: p.flags, ...suggest(`${p.title} ${p.text}`, readFacts(opts.factsFile), p.company) };
}

// ---------------------------------------------------------------------------------------------------------
// Starting point: which prior tailored resume (or master.json) to copy
// ---------------------------------------------------------------------------------------------------------

/** A resume file has this shape (cover-letter JSONs and anything else in data/resumes do not). */
function isResume(j) {
  return !!j && typeof j === 'object' && typeof j.name === 'string' && !!j.education && Array.isArray(j.experience) && j.experience.every((e) => e && Array.isArray(e.bullets)) && Array.isArray(j.skills) && Array.isArray(j.certifications);
}

/**
 * master + every prior tailored resume in dir. render.sh leaves a PatExample_Resume_<Co>.json copy next to
 * each PDF; when it is identical to a <slug>.json, only the slug one is kept.
 */
function loadResumes(dir) {
  let master = null;
  const seen = new Map();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (e) {
      continue;
    }
    if (!isResume(j)) continue;
    const name = f.replace(/\.json$/, '');
    if (name === 'master') {
      master = j;
      continue;
    }
    const key = JSON.stringify(j);
    const prev = seen.get(key);
    if (!prev || (/^PatExample_Resume_/.test(prev.name) && !/^PatExample_Resume_/.test(name))) {
      const file = path.join(dir, f);
      seen.set(key, { name, file, mtime: fs.statSync(file).mtimeMs, resume: j });
    }
  }
  if (!master) throw new Error(`no master.json in ${dir}`);
  return { master, priors: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

const docText = (r) =>
  [
    ...r.experience.flatMap((j) => [j.title, ...j.bullets]),
    ...r.projects.flatMap((p) => [p.name, ...p.bullets]),
    ...r.skills.map((s) => s.items),
    ...(r.education.extra || []).map((x) => x.text),
  ].join(' ');

/**
 * Pick the starting resume: the prior (or master) whose content shares the most posting terms, weighting each
 * term by how rare it is across all the candidates (the same idea as `suggest`). A prior must beat master by 3%.
 */
function chooseStart(text, master, priors) {
  const docs = [{ name: 'master', resume: master }, ...priors];
  const sets = docs.map((d) => new Set(words(docText(d.resume))));
  const df = new Map();
  for (const s of sets) for (const w of s) df.set(w, (df.get(w) || 0) + 1);
  const counts = new Map();
  for (const w of words(text)) counts.set(w, (counts.get(w) || 0) + 1);
  const scored = docs.map((d, i) => ({ d, score: [...sets[i]].reduce((sum, w) => sum + (counts.has(w) ? Math.min(3, counts.get(w)) / df.get(w) : 0), 0) }));
  const base = scored[0];
  // Equal scores (resumes sharing the same tailored lines) go to the most recently written one: it follows the newest rules.
  const best = scored.slice(1).sort((a, b) => (Math.abs(b.score - a.score) < 1e-9 ? (b.d.mtime || 0) - (a.d.mtime || 0) : b.score - a.score))[0];
  const round = (x) => Math.round(x * 10) / 10;
  if (best && best.score > 0 && best.score >= base.score * 1.03) return { name: best.d.name, resume: best.d.resume, reason: `${best.d.name} scored ${round(best.score)} vs master ${round(base.score)}` };
  return { name: 'master', resume: master, reason: best ? `no prior beat master (${round(base.score)}; best prior ${best.d.name} ${round(best.score)})` : 'no prior resumes' };
}

// ---------------------------------------------------------------------------------------------------------
// Skills rows: reorder only
// ---------------------------------------------------------------------------------------------------------

// Other spellings of a skill a posting might use. Used only to decide what leads; nothing is ever added.
const SKILL_ALIASES = {
  'rest apis': ['REST API', 'RESTful', 'REST'],
  postgresql: ['Postgres'],
  'node.js': ['Node', 'NodeJS'],
  'ci/cd': ['CICD', 'continuous integration', 'continuous delivery'],
  'ids/ips': ['IDS', 'IPS', 'intrusion detection'],
  'pki/tls': ['PKI', 'TLS'],
  'linux (rhel)': ['Linux', 'RHEL', 'Red Hat'],
  'quillstone ahv': ['AHV', 'Quillstone'],
  aws: ['Amazon Web Services'],
  'tcp/ip': ['TCP'],
  git: ['GitHub', 'GitLab'],
  vmware: ['vSphere', 'ESXi'],
  'network segmentation': ['segmentation', 'VLAN'],
  iam: ['identity and access management'],
  'incident response': ['incident management'],
};

/** Order a skills array so the items the posting names lead. Rows and items only move; the set never changes. */
function reorderSkills(skills, text) {
  const hit = (item) => {
    let count = 0;
    let first = Infinity;
    const base = item.replace(/\([^)]*\)/g, '').trim();
    for (const t of new Set([base, item, ...(SKILL_ALIASES[item.toLowerCase()] || []), ...(SKILL_ALIASES[base.toLowerCase()] || [])])) {
      const ms = [...String(text).matchAll(termRe(t, true))]; // the best single spelling, so "PKI/TLS" is not also counted as PKI and TLS
      count = Math.max(count, ms.length);
      for (const m of ms) first = Math.min(first, m.index);
    }
    return { count, first };
  };
  const rows = skills.map((row, idx) => {
    const items = L.splitTop(row.items).map((item, i) => ({ item, i, ...hit(item) }));
    const named = items.filter((x) => x.count).sort((a, b) => b.count - a.count || a.first - b.first || a.i - b.i);
    const rest = items.filter((x) => !x.count);
    return { idx, row: { ...row, items: [...named, ...rest].map((x) => x.item).join(', ') }, named: named.map((x) => x.item) };
  });
  rows.sort((a, b) => b.named.length - a.named.length || a.idx - b.idx);
  const out = rows.map((r) => r.row);
  const flat = (xs) => xs.flatMap((r) => L.splitTop(r.items)).sort().join('|');
  if (flat(out) !== flat(skills)) throw new Error('reorderSkills changed the set of skills (bug)');
  return { skills: out, led: rows.flatMap((r) => r.named) };
}

// ---------------------------------------------------------------------------------------------------------
// Grad date rule (facts.md): default "Dec 2027"; "May 2028" only when the posting REQUIRES 2028 graduates
// ---------------------------------------------------------------------------------------------------------

function gradRule(text, dflt = 'Dec 2027', alt = 'May 2028') {
  const sentences = String(text).split(/(?<=[.!?])\s+/).filter((s) => /graduat|class of|expected completion|degree completion/i.test(s) && /\b20\d\d\b/.test(s));
  if (!sentences.length) return { date: dflt, reason: 'posting names no graduation window' };
  for (const s of sentences) {
    const years = [...s.matchAll(/\b(20\d\d)\b/g)].map((m) => Number(m[1]));
    const earlier = years.some((y) => y <= 2027);
    const capped = /no later than|\bby\b|before|prior to|through|until|at the latest|or earlier/i.test(s);
    if (!earlier && !capped && years.includes(2028)) return { date: alt, reason: 'posting requires 2028 graduates (facts.md: "May 2028" is OK)', evidence: s.trim().slice(0, 220) };
  }
  return { date: dflt, reason: 'posting graduation window includes the default date', evidence: sentences[0].trim().slice(0, 220) };
}

// ---------------------------------------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------------------------------------

/**
 * 'amberstone' / 'Ironcrest' / 'Zephyrhaven, Inc.' / 'xAI' -> 'Amberstone' / 'Ironcrest' / 'Zephyrhaven' / 'xAI'.
 * An underscore tag is kept for a second role at one company ('UMBERMOOR_Automation'); anything else odd is dropped, so
 * the result is safe in a file name and names exactly one company.
 */
function companyName(raw) {
  const cap = (p) => (/^[a-z]+$/.test(p) ? p[0].toUpperCase() + p.slice(1) : p);
  const parts = String(raw || '').replace(/,?\s+(inc|llc|ltd|corp|corporation|co|company)\.?$/i, '').split(/[^A-Za-z0-9_]+/);
  return parts.map((p) => p.split('_').filter(Boolean).map(cap).join('_')).filter(Boolean).join('');
}

/** What render.sh + check_layout.py printed, as data. */
function parseRender(out) {
  const block = (head) => {
    const m = out.match(new RegExp(`${head}:\\n((?:  -> .*\\n?)+)`));
    return m ? m[1].split('\n').map((l) => l.replace(/^  -> /, '').trim()).filter(Boolean) : [];
  };
  const pages = (out.match(/^Pages:\s+(\S+)/m) || [])[1];
  return { pages: pages && /^\d+$/.test(pages) ? Number(pages) : null, lonelyLines: block('LONELY LINES'), repeatedVerbs: block('REPEATED VERBS') };
}

function renderResume(json, outBase) {
  const r = spawnSync('bash', [RENDER, json, outBase], { encoding: 'utf8', timeout: 240000 });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const res = { code: r.status == null ? 1 : r.status, ...parseRender(out) };
  if (res.code !== 0 && res.code !== 2) res.error = out.trim().split('\n').slice(-4).join(' | ').slice(0, 400);
  return res;
}

// ---------------------------------------------------------------------------------------------------------
// One output name per posting (2026-10-09: DUNVALE x2 and UMBERMOOR x4 collided on PatExample_Resume_<Company> and the
// tailor agent burned turns on the refusal and on renaming by hand). A second posting at a company gets a role tag
// from its title (PatExample_Resume_DUNVALE_DevOpsAI); the tag never names another company.
// ---------------------------------------------------------------------------------------------------------

const ROLE_STOP = new Set('intern internship interns summer fall spring winter co op coop student students undergraduate undergrad graduate grad program early career careers senior junior the of and for in a an to with engineer engineering engineers i ii iii us usa remote hybrid onsite bachelor bachelors master masters s'.split(' '));

/** "DevOps & AI Engineering Intern (Undergraduate)" -> "DevOpsAI": at most two telling words of the title. */
function roleTag(title) {
  const segments = String(title || '').replace(/\([^)]*\)/g, ' ').split(/\s[-–—|:]\s|,|\//);
  for (const seg of segments) {
    const words = seg.split(/[^A-Za-z0-9]+/).filter((w) => w && !ROLE_STOP.has(w.toLowerCase()) && !/^\d+$/.test(w));
    const tag = words.slice(0, 2).map((w) => w[0].toUpperCase() + w.slice(1)).join('').slice(0, 24);
    if (tag) return tag;
  }
  return 'Role';
}

// Build records: data/resumes/.tailor/<slug>.json (posting url, company, output base, start resume, its lines) and
// <slug>.posting.txt (the posting text, for a model that wants to read it). loadResumes never reads this folder.
const recordDir = (dir) => path.join(dir, '.tailor');
const recordPath = (dir, slug) => path.join(recordDir(dir), `${slug}.json`);

function readRecord(dir, slug) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(dir, slug), 'utf8'));
  } catch (e) {
    return null;
  }
}

function records(dir) {
  let names = [];
  try {
    names = fs.readdirSync(recordDir(dir)).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return [];
  }
  return names.map((f) => readRecord(dir, f.replace(/\.json$/, ''))).filter(Boolean);
}

/** An output name is taken when another slug's record owns it, or its files exist and are not this slug's resume. */
function nameTaken(dir, outBase, slug) {
  const owners = records(dir).filter((m) => m.outBase === outBase);
  if (owners.some((m) => m.slug !== slug)) return true;
  if (owners.length) return false; // this slug's own earlier build (a --force rebuild)
  const files = ['.json', '.pdf', '.docx'].map((x) => outBase + x).filter((f) => fs.existsSync(f));
  if (!files.length) return false;
  // Files from before build records: this slug's only when the sidecar JSON is this slug's resume.
  const mine = path.join(dir, `${slug}.json`);
  const side = `${outBase}.json`;
  return !(fs.existsSync(mine) && fs.existsSync(side) && fs.readFileSync(mine, 'utf8') === fs.readFileSync(side, 'utf8'));
}

/** The output base for this posting: the company name, or company_RoleTag (then a number) when that is taken. */
function pickOutBase(dir, slug, company, title) {
  const base = (c) => path.join(dir, `PatExample_Resume_${c}`);
  if (!nameTaken(dir, base(company), slug)) return { company, outBase: base(company) };
  const co = company.split('_')[0];
  const tag = roleTag(title);
  for (let n = 1; n < 100; n++) {
    const c = `${co}_${tag}${n > 1 ? n : ''}`;
    if (!nameTaken(dir, base(c), slug)) return { company: c, outBase: base(c), renamed: `PatExample_Resume_${company} belongs to another posting` };
  }
  throw new Error(`no free output name for ${company}: pass --company ${co}_<Tag>`);
}

/**
 * The slug to write. A slug built before for another posting (or before build records) is never overwritten: the
 * next free <slug>-2 is used. The same posting again needs --force (start over) or --finish (keep the edits).
 */
function pickSlug(dir, slug, key, force) {
  const json = (s) => path.join(dir, `${s}.json`);
  if (!fs.existsSync(json(slug))) return { slug };
  const rec = readRecord(dir, slug);
  const same = !!(rec && key && rec.key === key);
  if (same && force) return { slug };
  if (same) throw new Error(`refusing to overwrite ${slug}.json: it was built for this posting already. Keep its edits: \`jobctl tailor --finish ${slug}\`; start over: add --force`);
  if (!rec && force) return { slug }; // an old slug the caller asked to replace
  for (let n = 2; n < 100; n++) if (!fs.existsSync(json(`${slug}-${n}`))) return { slug: `${slug}-${n}`, renamedSlug: `${slug}.json belongs to another posting` };
  throw new Error(`no free slug for ${slug}`);
}

// ---------------------------------------------------------------------------------------------------------
// --check / --finish: the lint, minus lines that were reviewed already
// ---------------------------------------------------------------------------------------------------------

function lintContext(opts = {}) {
  const dir = opts.dir || RESUMES;
  const { master, priors } = opts.loaded || loadResumes(dir);
  return { facts: opts.facts || readFacts(opts.factsFile), master, priors, knownCompanies: L.companiesFromFiles(fs.readdirSync(dir)), dir };
}

/** Lint a resume object. opts: { company, file, dir, factsFile, loaded, facts }. */
function checkResume(resume, opts = {}) {
  return L.lint(resume, { ...lintContext(opts), company: opts.company, file: opts.file });
}

const norm = L.norm;

/**
 * The lint, with reworded lines split in two: `warnings` (new wording: review it) and `carried` (a line copied from
 * the resume this one started from, or from another tailored resume that passes the lint: it was reviewed when that
 * one was made). The resume's own files (its slug JSON and render.sh's sidecar copy) never count as "another".
 * opts: { dir, facts, factsFile, loaded, company, file, own: [paths], startLines: [normalized lines] }
 */
function review(resume, opts = {}) {
  const ctx = lintContext(opts);
  const own = new Set((opts.own || []).map((f) => path.resolve(f)));
  const self = JSON.stringify(resume);
  const others = ctx.priors.filter((p) => !own.has(path.resolve(p.file)) && JSON.stringify(p.resume) !== self);
  const passing = others.filter((p) => L.lint(p.resume, { ...ctx, priors: [] }).ok); // pass/fail only: no seen-in lookups
  const res = L.lint(resume, { ...ctx, priors: passing, company: opts.company, file: opts.file });
  const start = new Set(opts.startLines || []);
  const carried = res.warnings.filter((w) => w.type === 'reworded-line' && (w.seenIn || start.has(norm(w.text))));
  return {
    ...res,
    warnings: res.warnings.filter((w) => !carried.includes(w)).map((w) => ({ ...w, seenIn: undefined })),
    carried: carried.map((w) => ({ where: w.where, seenIn: w.seenIn || 'the start resume', text: w.text })),
  };
}

/** The files that are this resume itself: <slug>.json and its sidecar copy (from the build record when there is one). */
function ownFiles(file, dir) {
  const stem = path.basename(file).replace(/\.json$/, '');
  const out = [file];
  const rec = readRecord(dir, stem);
  if (rec && rec.outBase) out.push(`${rec.outBase}.json`);
  for (const m of records(dir)) if (path.resolve(`${m.outBase}.json`) === path.resolve(file)) out.push(path.join(dir, `${m.slug}.json`));
  return { own: out, rec: rec || records(dir).find((m) => path.resolve(`${m.outBase}.json`) === path.resolve(file)) || null };
}

/** `jobctl tailor --check <file>`: the company defaults to the build record, else the file name. */
function checkFile(file, opts = {}) {
  const resume = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isResume(resume)) throw new Error(`${file} is not a resume JSON (needs name, education, experience, skills, certifications)`);
  const dir = opts.dir || RESUMES;
  const ctx = lintContext({ ...opts, dir });
  const { own, rec } = ownFiles(file, dir);
  const stem = path.basename(file).replace(/\.json$/, '');
  let company = opts.company || (rec && rec.company);
  if (!company) company = (stem.match(/^PatExample_Resume_([A-Za-z0-9_]+)/) || [])[1] || ctx.knownCompanies.find((c) => L.squash(c) === L.squash(stem));
  const res = review(resume, { ...opts, dir, loaded: { master: ctx.master, priors: ctx.priors }, facts: ctx.facts, company, file: rec ? `${rec.outBase}.json` : file, own, startLines: rec && rec.startLines });
  return { file, company: company || null, ...res };
}

// ---------------------------------------------------------------------------------------------------------
// Bullets by id, edits, and the report the tailor agent returns
// ---------------------------------------------------------------------------------------------------------

/** A short name for a job or project: "Quillstone", "Gamma Project", "Quantum Risk Modeling", "Widget Engine". */
function shortName(r, kind, i) {
  if (kind === 'p') return String(r.projects[i].name).split(/[,(]/)[0].trim();
  const j = r.experience[i];
  const twice = r.experience.filter((x) => x.company === j.company).length > 1;
  return twice ? String(j.title).split(',').pop().trim() : String(j.company).split(/[(,]/)[0].trim();
}

/** Every bullet with an id the edits use: e<job>.<n> / p<project>.<n> (0-based, in document order). */
function bulletList(r) {
  const out = [];
  (r.experience || []).forEach((j, i) => (j.bullets || []).forEach((b, k) => out.push({ id: `e${i}.${k}`, where: `${shortName(r, 'e', i)} #${k + 1}`, text: b })));
  (r.projects || []).forEach((p, i) => (p.bullets || []).forEach((b, k) => out.push({ id: `p${i}.${k}`, where: `${shortName(r, 'p', i)} #${k + 1}`, text: b })));
  return out;
}

/**
 * Apply bullet edits to a resume (a copy): [{id:'e1.0', text}] replaces, [{id, drop:true}] removes, [{after:'e1.1',
 * text}] inserts after. Ids are the ones bulletList printed; only bullets ever change.
 */
function applyEdits(resume, edits) {
  const r = JSON.parse(JSON.stringify(resume));
  if (!Array.isArray(edits)) throw new Error('edits must be a JSON array like [{"id":"e1.0","text":"..."}]');
  const at = (id) => {
    const m = /^([ep])(\d+)\.(\d+)$/.exec(String(id || ''));
    if (!m) throw new Error(`"${id}" is not a bullet id like e1.0 or p2.1 (ids are in the bullets list)`);
    const g = (m[1] === 'e' ? r.experience : r.projects)[+m[2]];
    if (!g || +m[3] >= g.bullets.length) throw new Error(`no bullet ${id}`);
    return { g, k: +m[3] };
  };
  const text = (e) => {
    if (typeof e.text !== 'string' || !e.text.trim()) throw new Error(`edit ${e.id || e.after}: give "text" (the new bullet), or "drop": true`);
    return e.text.trim().replace(/\s+/g, ' ');
  };
  const later = []; // inserts and drops, applied from the highest index down so earlier ids keep their bullets
  for (const e of edits) {
    if (e.after) later.push({ ...at(e.after), insert: text(e) });
    else if (e.drop) later.push({ ...at(e.id), drop: true });
    else {
      const { g, k } = at(e.id);
      g.bullets[k] = text(e);
    }
  }
  later.sort((a, b) => b.k - a.k || (a.drop ? 1 : -1)).forEach((x) => (x.drop ? x.g.bullets.splice(x.k, 1) : x.g.bullets.splice(x.k + 1, 0, x.insert)));
  return r;
}

/** What still needs doing before the resume can go out: lint errors, page count, lonely lines, repeated verbs. */
function todoList(rendered, check) {
  const out = check.errors.map((e) => `fix ${e.type}${e.where ? ` (${e.where})` : ''}${e.text ? ` "${String(e.text).slice(0, 60)}"` : ''}: ${e.fix || e.detail || ''}`.trim());
  if (rendered.code === 2 || (rendered.pages && rendered.pages !== 1)) out.push(`not one page (${rendered.pages || '?'} pages): tighten words or cut the weakest bullet; never touch fontSize or margins`);
  else if (rendered.code !== 0) out.push(`render failed: ${rendered.error || 'render.sh exit ' + rendered.code}`);
  for (const l of rendered.lonelyLines || []) out.push(`LONELY LINE "${l}": shorten that bullet by a few words`);
  for (const v of rendered.repeatedVerbs || []) out.push(`REPEATED VERBS ${v}: change one start verb (built/developed/created/engineered/implemented are free swaps)`);
  return out;
}

const q = (s, n = 70) => `"${String(s).length > n ? String(s).slice(0, n - 1) + '…' : s}"`;

/** One line per reworded bullet: where (short name when given), its start, what was added / dropped against the closest source. */
function warningLine(w, short) {
  if (w.type === 'grad-date') return `grad ${w.text} (only valid when the posting requires 2028 grads)`;
  if (w.type !== 'reworded-line') return `${w.type}: ${w.text || ''} ${w.detail || ''}`.trim();
  const diff = [...(w.added || []).map((x) => `+${q(x, 50)}`), ...(w.dropped || []).map((x) => `-${q(x, 50)}`)].join(' ');
  return `${(short && short.get(norm(w.text))) || w.where}: ${q(w.text, 60)} ${diff} (closest ${w.source.replace(/, contains an approved fragment/, '')} ${w.score})`;
}

/**
 * The block the tailor agent returns, built from the files (so it is exact): pdf, docx, what changed against the
 * start resume (each changed bullet and where its words come from), skills led, grad date, gaps, and the warnings.
 */
function reportBlock(rec, resume, check, facts, master) {
  const src = L.sourceLines({ master, facts });
  const exact = new Map();
  for (const s of src) if (!s.fragment && !exact.has(norm(s.text))) exact.set(norm(s.text), s.from === 'master' ? 'master line' : `${s.from.replace(/^facts\.md \((.*)\)$/, '$1')} alternate`);
  const start = new Set(rec.startLines || []);
  const now = bulletList(resume);
  const comp = new Map((check.composed || []).map((c) => [norm(c.text), c]));
  const seen = new Map((check.carried || []).map((c) => [norm(c.text), c.seenIn]));
  const edits = now
    .filter((b) => !start.has(norm(b.text)))
    .map((b) => {
      const c = comp.get(norm(b.text));
      const how = exact.get(norm(b.text)) || (c ? (c.fragments.length ? 'source line + approved fragment' : `verb swap ${c.verb[0]} for ${c.verb[1]}`) : seen.has(norm(b.text)) ? `reworded, reviewed before in ${seen.get(norm(b.text))}` : 'reworded (see warnings)');
      return `${b.where} = ${how}`;
    });
  const parts = [`started from ${rec.startedFrom}`, edits.length ? `bullets: ${edits.join(', ')}` : 'no bullet edits'];
  // Bullets of the start resume that are gone now (replaced or cut).
  const gone = (rec.startBullets || []).filter((l) => !now.some((b) => norm(b.text) === l)).length;
  if (gone) parts.push(`${gone} start bullet${gone > 1 ? 's' : ''} replaced or cut`);
  if (rec.skillsLed && rec.skillsLed.length) parts.push(`skills led: ${rec.skillsLed.slice(0, 5).join(', ')}`);
  parts.push(`grad ${resume.education.date}`);
  parts.push(rec.gaps && rec.gaps.length ? `gaps: ${rec.gaps.join(', ')}` : 'no gaps');
  const short = new Map(now.map((b) => [norm(b.text), b.where]));
  const warns = check.warnings.map((w) => warningLine(w, short));
  return [`pdf: ${rec.outBase}.pdf`, `docx: ${rec.outBase}.docx`, `changed: ${parts.join('; ')}`, `warnings: ${warns.length ? warns.join('; ') : 'none'}`].join('\n');
}

/** The posting's most-used terms that the owner's sources also use: the vocabulary a bullet can echo and stay true. */
function keywords(text, facts, master, company, n = 15) {
  const corpus = new Set(words(`${JSON.stringify(master)} ${L.claimableFacts(facts.text || '')}`));
  const own = new Set(words(company || ''));
  const counts = new Map();
  const first = new Map();
  words(text).forEach((w, i) => {
    if (!corpus.has(w) || own.has(w) || /^\d+$/.test(w)) return;
    counts.set(w, (counts.get(w) || 0) + 1);
    if (!first.has(w)) first.set(w, i);
  });
  return [...counts].sort((a, b) => b[1] - a[1] || first.get(a[0]) - first.get(b[0])).slice(0, n).map(([w]) => w);
}

// ---------------------------------------------------------------------------------------------------------
// --build
// ---------------------------------------------------------------------------------------------------------

/**
 * Deterministic first draft of a tailored resume. Returns { summary, exit }.
 * opts: { slug, from, company, force, textFile, title, posting, dir, factsFile, render }
 *   render: false skips render.sh (tests), or a function (json, outBase) -> {code, pages, lonelyLines, repeatedVerbs}
 */
async function build(url, opts = {}) {
  const dir = opts.dir || RESUMES;
  const asked = String(opts.slug || '').replace(/\.json$/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asked) || asked === 'master') throw new Error('--build needs a slug like "acme" (letters, digits, - _ .; not "master")');
  const posting = await loadPosting(url, opts);
  const company0 = companyName(opts.company || posting.company);
  if (!company0) throw new Error('could not work out the company name: pass --company <Name>');
  // Which posting this is: its URL, or (a pasted text file) the company and title.
  const key = url || `text:${company0}|${posting.title || opts.title || ''}`;
  const { slug, renamedSlug } = pickSlug(dir, asked, key, !!opts.force);
  const { company, outBase, renamed } = pickOutBase(dir, slug, company0, posting.title || opts.title || '');
  const jsonPath = path.join(dir, `${slug}.json`);

  const facts = readFacts(opts.factsFile);
  const loaded = loadResumes(dir);
  const text = `${posting.title || ''} ${posting.text || ''}`;
  let start;
  if (opts.from) {
    const want = String(opts.from).replace(/\.json$/, '');
    const hit = want === 'master' ? { name: 'master', resume: loaded.master } : loaded.priors.find((p) => p.name === want || p.name === `PatExample_Resume_${want}`);
    if (!hit) throw new Error(`--from ${opts.from}: no such resume in ${dir} (try: ${loaded.priors.slice(0, 6).map((p) => p.name).join(', ')} ...)`);
    start = { name: hit.name, resume: hit.resume, reason: '--from' };
  } else {
    // A prior that fails the lint (an invented claim that slipped through once) must not seed a new draft.
    const ctx = lintContext({ ...opts, dir, facts, loaded });
    const failing = loaded.priors.filter((p) => !L.lint(p.resume, { ...ctx, priors: [] }).ok).map((p) => p.name);
    start = chooseStart(text, loaded.master, loaded.priors.filter((p) => !failing.includes(p.name)));
    if (failing.length) start.reason += `; skipped ${failing.length} prior(s) that fail the lint: ${failing.slice(0, 5).join(', ')}`;
  }

  const draft = JSON.parse(JSON.stringify(start.resume));
  const sk = reorderSkills(draft.skills, text);
  draft.skills = sk.skills;
  const grad = gradRule(text, facts.gradDefault || loaded.master.education.date, facts.gradAlt);
  draft.education.date = grad.date;
  fs.writeFileSync(jsonPath, JSON.stringify(draft, null, 2) + '\n');

  const sugg = suggest(text, facts, posting.company);
  fs.mkdirSync(recordDir(dir), { recursive: true });
  const postingFile = path.join(recordDir(dir), `${slug}.posting.txt`);
  fs.writeFileSync(postingFile, `${posting.title || ''}\n\n${posting.text || ''}\n`);
  const rec = {
    slug,
    url: url || null,
    key,
    company,
    title: posting.title || null,
    outBase,
    startedFrom: start.name,
    startReason: start.reason,
    startLines: L.strings(start.resume).map((s) => norm(s.text)),
    startBullets: bulletList(start.resume).map((b) => norm(b.text)),
    skillsLed: sk.led,
    gaps: sugg.gaps,
    gradDate: grad.date,
    postingFile,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(recordPath(dir, slug), JSON.stringify(rec, null, 2) + '\n');

  const rendered = opts.render === false ? { code: 0, pages: null, lonelyLines: [], repeatedVerbs: [] } : (typeof opts.render === 'function' ? opts.render : renderResume)(jsonPath, outBase);
  const check = review(draft, { dir, facts, loaded, company, file: `${outBase}.json`, own: [jsonPath, `${outBase}.json`], startLines: rec.startLines });
  const bullets = bulletList(draft);
  const inDraft = (a) => {
    const t = norm(a.text.replace(/^\.{3}|\.{3}$/g, ''));
    return bullets.some((b) => (/^\.{3}|\.{3}$/.test(a.text) ? norm(b.text).includes(t) : norm(b.text) === t));
  };
  const alternates = sugg.alternates.slice(0, 3).map((a) => ({ section: a.section, text: a.text, note: a.note, inDraft: inDraft(a) }));
  const todo = todoList(rendered, check);
  const status = !check.ok ? 'lint-failed' : rendered.code === 0 ? 'ok' : rendered.code === 2 ? 'not-one-page' : 'render-failed';
  // The draft already fits when the posting's best alternates are in it (a prior made for a similar posting): return it.
  const ready = status === 'ok' && !todo.length && !check.warnings.length && alternates.length >= 2 && alternates.every((a) => a.inDraft);
  const summary = {
    status,
    next: ready ? 'return the report as is' : `edit 1 to 3 bullets: jobctl tailor --finish ${slug} --edits -`,
    company,
    role: posting.title || undefined,
    slug,
    renamed: [renamedSlug, renamed].filter(Boolean).join('; ') || undefined,
    json: jsonPath,
    pdf: `${outBase}.pdf`,
    docx: `${outBase}.docx`,
    outBase, // for `bash tailor/render.sh <json> <outBase>` when re-rendering after edits
    postingFile,
    startedFrom: start.name,
    startReason: start.reason,
    gradDate: { value: grad.date, reason: grad.reason, evidence: grad.evidence },
    skillsLed: sk.led,
    gaps: sugg.gaps,
    keywords: keywords(text, facts, loaded.master, posting.company),
    alternates,
    bullets,
    pages: rendered.pages,
    lonelyLines: rendered.lonelyLines,
    repeatedVerbs: rendered.repeatedVerbs,
    render: rendered.code,
    renderError: rendered.error,
    todo,
    check: { ok: check.ok, errors: check.errors, warnings: check.warnings, carried: check.carried.length, notes: check.notes },
    report: reportBlock(rec, draft, check, facts, loaded.master),
  };
  return { summary, exit: !check.ok ? 2 : rendered.code };
}

// ---------------------------------------------------------------------------------------------------------
// --finish: apply the bullet edits, render, lint, and print the report (one call per round)
// ---------------------------------------------------------------------------------------------------------

/**
 * `jobctl tailor --finish <slug> [--edits <file|->]`. Returns { summary, exit }: exit 0 = one page, lint clean, no
 * lonely lines or repeated verbs (return `report` as is); 2 = `todo` lists what to fix; 1 = render failed.
 * opts: { dir, factsFile, render, edits }
 */
async function finish(target, opts = {}) {
  const dir = opts.dir || RESUMES;
  const slug = path.basename(String(target || '')).replace(/\.json$/, '');
  const rec = readRecord(dir, slug);
  if (!rec) throw new Error(`no build record for "${slug}": run \`jobctl tailor <url> --build ${slug}\` first`);
  const jsonPath = path.join(dir, `${slug}.json`);
  let resume = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (opts.edits && opts.edits.length) {
    resume = applyEdits(resume, opts.edits);
    fs.writeFileSync(jsonPath, JSON.stringify(resume, null, 2) + '\n');
  }
  if (!isResume(resume)) throw new Error(`${jsonPath} is not a resume JSON any more (needs name, education, experience, skills, certifications)`);
  const rendered = opts.render === false ? { code: 0, pages: null, lonelyLines: [], repeatedVerbs: [] } : (typeof opts.render === 'function' ? opts.render : renderResume)(jsonPath, rec.outBase);
  const facts = readFacts(opts.factsFile);
  const loaded = loadResumes(dir);
  const check = review(resume, { dir, facts, loaded, company: rec.company, file: `${rec.outBase}.json`, own: [jsonPath, `${rec.outBase}.json`], startLines: rec.startLines });
  const todo = todoList(rendered, check);
  const status = !check.ok ? 'lint-failed' : rendered.code === 0 ? (todo.length ? 'needs-fixes' : 'ok') : rendered.code === 2 ? 'not-one-page' : 'render-failed';
  const summary = {
    status,
    next: status === 'ok' ? 'return the report as is' : `fix the todo items: jobctl tailor --finish ${slug} --edits -`,
    slug,
    json: jsonPath,
    pdf: `${rec.outBase}.pdf`,
    docx: `${rec.outBase}.docx`,
    pages: rendered.pages,
    todo,
    bullets: bulletList(resume),
    check: { ok: check.ok, errors: check.errors, warnings: check.warnings, carried: check.carried.length, notes: check.notes },
    report: reportBlock(rec, resume, check, facts, loaded.master),
  };
  const exit = rendered.code !== 0 && rendered.code !== 2 ? 1 : status === 'ok' ? 0 : 2;
  return { summary, exit };
}

/** --build / --finish as text for the agent: status, todo, what to edit, and the report block to return. */
function summaryText(s) {
  const L2 = [`status: ${s.status}${s.pages ? ` (${s.pages} page${s.pages > 1 ? 's' : ''})` : ''} | next: ${s.next}`];
  L2.push(`json: ${s.json}`);
  if (s.renamed) L2.push(`name: ${path.basename(s.outBase || s.pdf, '.pdf')} (${s.renamed})`);
  if (s.startedFrom) L2.push(`started from: ${s.startedFrom} (${s.startReason})`);
  if (s.postingFile) L2.push(`posting: ${s.role || '?'} | full text: ${s.postingFile}`);
  if (s.keywords) L2.push(`posting keywords the owner's facts also use: ${s.keywords.join(', ') || 'none'}`);
  if (s.skillsLed) L2.push(`skills led: ${s.skillsLed.join(', ') || 'none'} | gaps (never claim): ${s.gaps.join(', ') || 'none'} | grad: ${s.gradDate.value} (${s.gradDate.reason})`);
  if (s.alternates) {
    L2.push('best facts.md alternates for this posting (* = already in the draft; use the text as written):');
    for (const a of s.alternates) L2.push(`  ${a.inDraft ? '*' : '-'} [${a.section}] ${a.text}${a.note ? ` (${a.note})` : ''}`);
  }
  L2.push('bullets (edit by id):');
  for (const b of s.bullets) L2.push(`  ${b.id} ${b.where}: ${b.text}`);
  L2.push(`todo: ${s.todo.length ? '' : 'none'}`);
  for (const t of s.todo) L2.push(`  - ${t}`);
  if (s.check.notes && s.check.notes.length) L2.push(`notes: ${s.check.notes.join('; ')}`);
  L2.push('--- report (return exactly this) ---');
  L2.push(s.report);
  return L2.join('\n');
}

// ---------------------------------------------------------------------------------------------------------
// jobctl tailor ...
// ---------------------------------------------------------------------------------------------------------

const USAGE = 'usage: jobctl tailor <url>   |   jobctl tailor <url> --build <slug> [--from <prior-slug>] [--company <Name>] [--text-file <f> --company <Name>] [--force] [--json]   |   jobctl tailor --finish <slug> [--edits <file|->] [--json]   |   jobctl tailor --check <resume.json> [--company <Name>]';

/** bin/jobctl's `tailor` handler: returns { out, code } for jobctl's out(). `extra` ({dir, factsFile, render, stdin}) is for tests. */
async function cli({ args, flags }, extra = {}) {
  const str = (v) => (typeof v === 'string' ? v : undefined);
  const show = (r) => ({ out: flags.json ? r.summary : summaryText(r.summary), code: r.exit });
  if (flags.check) {
    if (typeof flags.check !== 'string') throw new Error(USAGE);
    const r = checkFile(flags.check, { ...extra, company: str(flags.company) });
    return { out: r, code: r.ok ? 0 : 2 };
  }
  if (flags.finish) {
    if (typeof flags.finish !== 'string') throw new Error(USAGE);
    let edits;
    if (flags.edits) {
      const raw = flags.edits === '-' || flags.edits === true ? (extra.stdin != null ? extra.stdin : fs.readFileSync(0, 'utf8')) : fs.readFileSync(flags.edits, 'utf8');
      edits = raw.trim() ? JSON.parse(raw) : [];
    }
    return show(await finish(flags.finish, { ...extra, edits }));
  }
  if (!args[0] && !flags['text-file']) throw new Error(USAGE);
  const opts = { ...extra, company: str(flags.company), textFile: str(flags['text-file']), title: str(flags.title) };
  if (flags.build) {
    if (typeof flags.build !== 'string') throw new Error(USAGE);
    return show(await build(args[0], { ...opts, slug: flags.build, from: str(flags.from), force: !!flags.force }));
  }
  return { out: await tailor(args[0], opts), code: 0 };
}

module.exports = { tailor, suggest, readFacts, words, cli, build, finish, review, checkFile, checkResume, chooseStart, loadResumes, reorderSkills, gradRule, companyName, roleTag, pickOutBase, pickSlug, applyEdits, bulletList, keywords, reportBlock, summaryText, parseRender, isResume, readRecord };
