'use strict';
/*
 * The never-untrue lint for a tailored resume (`jobctl tailor --check <resume.json>`).
 *
 * WHY: every resume is edited by a model, and one untrue line (a skill the owner never confirmed, an invented number,
 * another company's name) can sink an application or an interview. This module is the mechanical backstop:
 *   ERRORS (the check fails, exit 2):
 *     - a DO NOT CLAIM / never-confirmed item from tailor/references/facts.md appears anywhere in the text
 *     - Go outside the skills rows (facts.md: "skills row only, no confirmed Go project")
 *     - an em dash (owner rule), "Site Reliability" (the title is "Systems Reliability Engineer")
 *     - another company's name in the text, or a file name that names a different company than the target
 *     - a number that appears in neither master.json nor facts.md (an invented metric)
 *     - name / contact / school / degree / a job's title, dates or location differing from master.json
 *     - a grad date other than the two facts.md allows
 *   WARNINGS (exit 0, listed): every bullet that is not verbatim in master.json or a facts.md alternate, with its
 *   closest source line and a similarity score, so the reviewer reads only the reworded lines; skills found
 *   nowhere in master/facts; the "May 2028" grad date (only for postings that require 2028 grads).
 *
 * Pure functions: facts / master / priors are passed in (lib/tailor.js loads them), so tests use fixtures.
 */

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Split on commas that are not inside parentheses: "Groq (a, b), React" -> ["Groq (a, b)", "React"]. */
function splitTop(str) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(str)) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Memoized: the same resume lines come back across every prior resume a --check / --build lints.
const normCache = new Map();
const norm = (s) => {
  const k = String(s);
  let v = normCache.get(k);
  if (v === undefined) {
    v = k.toLowerCase().replace(/[^a-z0-9%+#.]+/g, ' ').replace(/\.+(\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
    if (normCache.size > 50000) normCache.clear();
    normCache.set(k, v);
  }
  return v;
};
const toks = (s) => norm(s).split(' ').filter(Boolean);

/** Word-level similarity 0..1 (1 - edit distance / longer length). */
function similarity(a, b) {
  const x = toks(a);
  const y = toks(b);
  if (!x.length || !y.length) return 0;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

/**
 * How close two lines are, 0..1: the mean of the edit similarity (catches small rewordings) and the word-set overlap
 * (catches reordered clauses, which edit distance scores as unrelated).
 */
function closeness(a, b) {
  const x = new Set(toks(a));
  const y = new Set(toks(b));
  if (!x.size || !y.size) return 0;
  const shared = [...x].filter((w) => y.has(w)).length;
  return (similarity(a, b) + (2 * shared) / (x.size + y.size)) / 2;
}

/** Every text field of the resume with a readable path, in document order. */
function strings(r) {
  const out = [];
  const add = (path, text) => typeof text === 'string' && text && out.push({ path, text });
  add('name', r.name);
  add('contact', r.contact);
  const ed = r.education || {};
  ['school', 'location', 'degree', 'date'].forEach((k) => add(`education.${k}`, ed[k]));
  (ed.extra || []).forEach((x, i) => add(`education.extra[${i}]`, (x.label ? x.label + ': ' : '') + x.text));
  (r.experience || []).forEach((j, i) => {
    ['company', 'location', 'title', 'dates'].forEach((k) => add(`experience[${i}].${k}`, j[k]));
    (j.bullets || []).forEach((b, k) => add(`experience[${i}].bullets[${k}]`, b));
  });
  (r.projects || []).forEach((p, i) => {
    add(`projects[${i}].name`, p.name);
    (p.bullets || []).forEach((b, k) => add(`projects[${i}].bullets[${k}]`, b));
  });
  (r.certifications || []).forEach((c, i) => add(`certifications[${i}]`, `${c.label || ''}${c.text || ''} ${c.date || ''}`.trim()));
  (r.skills || []).forEach((s, i) => {
    add(`skills[${i}].label`, s.label);
    add(`skills[${i}].items`, s.items);
  });
  (r.leadership || []).forEach((l, i) => add(`leadership[${i}]`, `${l.bold || ''}${l.rest || ''}`.trim()));
  return out;
}

/** Human label for a bullet path: 'Quillstone: Systems Reliability Engineer Intern (SRE) #2'. */
function label(r, path) {
  const m = path.match(/^(experience|projects)\[(\d+)\](?:\.bullets\[(\d+)\])?/);
  if (!m) return path;
  const g = r[m[1]][+m[2]];
  const head = m[1] === 'experience' ? `${g.company}: ${g.title}` : g.name;
  return m[3] != null ? `${head.slice(0, 60)} #${+m[3] + 1}` : head;
}

// Spellings of a claim that a plain word match would miss. Keys are lower-case raw facts.md items.
const ALIASES = {
  docker: ['Dockerfile', 'Docker Compose', 'docker-compose', 'Dockerized', 'Dockerised', 'Dockerizing'],
  rag: ['retrieval-augmented', 'retrieval augmented', 'retrieval-augmented generation'],
  kubernetes: ['k8s', 'kubectl'],
  'spark/pyspark': ['Apache Spark'],
  'entra id/azure ad': ['Entra', 'Azure Active Directory'],
  'vector databases': ['vector database', 'vector DB', 'vector store'],
  'agile/scrum sprints': ['Scrum', 'Agile'],
  jinja2: ['Jinja'],
  servicenow: ['Service Now'],
  'power apps': ['PowerApps'],
  'power automate': ['PowerAutomate'],
  'c++': ['cpp'],
  'hashicorp vault': ['HashiCorp'],
  'runbooks/kb articles': ['runbook', 'KB article'],
};

// Compiled once per term: the checks run over every prior resume on each --check / --build (was ~17 ms a resume).
const memo = (fn) => {
  const cache = new Map();
  return (k) => (cache.has(k) ? cache.get(k) : cache.set(k, fn(k)).get(k));
};

/** Match a term as a standalone token. Short or all-caps terms (Go, RAG, C#) match case-sensitively. */
const termRegex = memo((term) => {
  const caseSens = term.length <= 3 || /^[A-Z0-9+#]+$/.test(term);
  return new RegExp(`(?<![A-Za-z0-9])${esc(term)}(?![A-Za-z0-9])`, caseSens ? '' : 'i');
});

/**
 * Turn facts.md's DO NOT CLAIM / never-confirmed items into rules:
 *   {label, terms}                     the term (or any slash alternative / alias) anywhere in the text
 *   {label, terms, scope}              only in projects whose name matches scope ("Python backend work on Widget Engine")
 *   plus one rule for each confirmed skill marked "skills row only" (Go): flagged outside the skills rows.
 */
function claimRules(facts) {
  const rules = [];
  const raws = [...(facts.doNotClaimRaw || facts.doNotClaim || []), ...(facts.neverConfirmedRaw || facts.neverConfirmed || [])];
  for (const raw of raws) {
    const base = raw.replace(/\([^)]*\)/g, '').replace(/\.$/, '').trim();
    if (!base) continue;
    const scoped = base.match(/^(\w+) (?:backend )?work on (\w+)/i);
    if (scoped) {
      rules.push({ label: raw, terms: [scoped[1], 'backend', 'back-end', 'back end'], scope: new RegExp(esc(scoped[2]), 'i') });
      continue;
    }
    if (/^any specific (\w+) project/i.test(base)) continue; // covered by the skills-row-only rule for that skill
    const terms = base.split('/').map((t) => t.trim()).filter(Boolean);
    terms.push(...(ALIASES[base.toLowerCase()] || []));
    rules.push({ label: raw.replace(/\s*\(.*$/, ''), terms });
  }
  for (const s of facts.skillsRowOnly || []) rules.push({ label: `${s} outside the skills rows`, terms: [s, s + 'lang'], skillsOnly: true });
  return rules;
}

const isSkillsPath = (p) => /^skills\[/.test(p);

function checkClaims(r, facts, errors) {
  const seen = new Set();
  for (const rule of claimRules(facts)) {
    for (const { path, text } of strings(r)) {
      if (path === 'name' || path === 'contact') continue;
      if (rule.skillsOnly && isSkillsPath(path)) continue;
      if (rule.scope) {
        const m = path.match(/^projects\[(\d+)\]/);
        if (!m || !rule.scope.test(r.projects[+m[1]].name)) continue;
      }
      for (const t of rule.terms) {
        const hit = text.match(termRegex(t));
        if (!hit || seen.has(rule.label + path)) continue;
        seen.add(rule.label + path);
        errors.push({ type: rule.skillsOnly ? 'skills-row-only' : 'do-not-claim', item: rule.label, where: label(r, path), text: hit[0], fix: 'remove it (facts.md: never claim this)' });
      }
    }
  }
}

/** Company names the owner has sent resumes to, from data/resumes file names ("PatExample_Resume_Oakgate.pdf"). */
function companiesFromFiles(files) {
  const out = new Set();
  for (const f of files) {
    const m = f.match(/^PatExample_(?:Resume|CoverLetter)_([A-Za-z0-9]+)(?:_[A-Za-z0-9]+)*\.(?:pdf|docx|json)$/);
    if (m) out.add(m[1]);
  }
  return [...out];
}

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** "Oakgate" -> /Dallas\s*Fed/, "xAI" -> /x\s*AI/, "YARROWMERE" -> /YARROWMERE/ (case-sensitive: "Thornhaven" must not hit "range"). */
const companyRegex = memo((name) => {
  const parts = name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) || [name];
  return new RegExp(`(?<![A-Za-z0-9])${parts.map(esc).join('\\s*')}(?![A-Za-z0-9])`);
});

function checkCompany(r, ctx, errors, notes) {
  // 'UMBERMOOR_Automation' (a second role at one company) is still company UMBERMOOR.
  const target = squash(String(ctx.company || '').split('_')[0]);
  const file = ctx.file ? require('node:path').basename(ctx.file).replace(/\.(json|pdf|docx)$/, '') : '';
  const fromName = (file.match(/^PatExample_Resume_([A-Za-z0-9]+)/) || [])[1];
  if (ctx.company && fromName && squash(fromName) !== target) {
    errors.push({ type: 'wrong-company-file', where: file, detail: `file name carries "${fromName}" but the target company is "${ctx.company}"`, fix: 'the output name must carry only the target company' });
  }
  if (!target) {
    notes.push('company check skipped: pass --company <Name> (or name the file PatExample_Resume_<Company>.json)');
    return;
  }
  const own = new Set(strings(ctx.master).map((s) => s.text).join(' ').match(/[A-Za-z][A-Za-z0-9]+/g) || []);
  const known = (ctx.knownCompanies || []).filter((c) => squash(c) !== target && !own.has(c));
  for (const { path, text } of strings(r)) {
    if (path === 'name' || path === 'contact') continue;
    for (const c of known) {
      const hit = text.match(companyRegex(c));
      if (hit) errors.push({ type: 'other-company', where: label(r, path), text: hit[0], detail: `names "${c}", not the target "${ctx.company}"`, fix: 'remove it' });
    }
  }
}

function checkFacts(r, ctx, errors, warnings) {
  const m = ctx.master;
  const f = ctx.facts;
  for (const k of ['name', 'contact']) if (r[k] !== m[k]) errors.push({ type: 'header-changed', where: k, fix: 'restore it from master.json' });
  for (const k of ['school', 'location', 'degree']) if ((r.education || {})[k] !== m.education[k]) errors.push({ type: 'header-changed', where: `education.${k}`, fix: 'restore it from master.json' });
  const date = (r.education || {}).date;
  const dflt = f.gradDefault || m.education.date;
  if (date !== dflt && date !== f.gradAlt) errors.push({ type: 'grad-date', where: 'education.date', text: date, detail: `facts.md allows "${dflt}"${f.gradAlt ? ` or "${f.gradAlt}"` : ''}`, fix: 'use the default' });
  else if (date !== dflt) warnings.push({ type: 'grad-date', where: 'education.date', text: date, detail: `only valid when the posting REQUIRES Spring/Summer 2028 grads (default "${dflt}"); say so in the log line` });
  (r.experience || []).forEach((j, i) => {
    const same = m.experience.find((x) => x.company === j.company && x.dates === j.dates) || m.experience.find((x) => x.company === j.company && x.title === j.title);
    if (!same) return errors.push({ type: 'job-not-in-master', where: `experience[${i}] ${j.company}`, detail: 'no job with this company and dates in master.json', fix: 'restore it from master.json' });
    for (const k of ['company', 'title', 'dates', 'location']) {
      if (j[k] !== same[k]) errors.push({ type: 'job-fact-changed', where: `experience[${i}] ${j.company}.${k}`, text: j[k], detail: `master.json has "${same[k]}"`, fix: 'restore it from master.json' });
    }
  });
}

function checkNumbers(r, ctx, errors) {
  const clean = (n) => n.replace(/,+$/, ''); // "800-82," in prose is the number 82
  const corpus = new Set((`${JSON.stringify(ctx.master)} ${ctx.facts.text || ''}`.match(/\d[\d,]*(?:\.\d+)?/g) || []).map(clean));
  for (const { path, text } of strings(r)) {
    if (path === 'name' || path === 'contact') continue;
    for (const n of text.match(/\d[\d,]*(?:\.\d+)?/g) || []) {
      if (corpus.has(clean(n))) continue;
      errors.push({ type: 'unsourced-number', where: label(r, path), text: n, detail: 'this number is in neither master.json nor facts.md', fix: 'remove it or use the sourced figure' });
    }
  }
}

/** facts.md minus the sections that list things the owner does NOT have (## 4 skills lists, ## 6 open items, ## 7 risk notes). */
function claimableFacts(text) {
  const parts = String(text).split(/^(?=## \d+\.)/m);
  return parts.filter((p) => !/^## (4|6|7)\./.test(p)).join('\n');
}

function skillKnown(item, ctx) {
  const plain = item.replace(/\([^)]*\)/g, '').trim();
  const lists = [...(ctx.facts.confirmed || []), ...(ctx.facts.lightUse || []), ...ctx.master.skills.flatMap((s) => splitTop(s.items))];
  const want = [norm(item), norm(plain)].filter(Boolean);
  if (lists.some((x) => want.includes(norm(x)) || want.includes(norm(x.replace(/\([^)]*\)/g, ''))))) return true;
  // Skills rows also name things from the experience bullets (PCAP and CSV parsing, NIST SP 800-82): fine if the
  // phrase is in master.json or in facts.md's experience / projects / coursework sections. Never the skills section's
  // DO NOT CLAIM / never-confirmed lists, the open items or the interview-risk notes: those name the gaps.
  const corpus = ` ${norm(`${JSON.stringify(ctx.master)} ${claimableFacts(ctx.facts.text || '')}`)} `;
  if (want.some((w) => corpus.includes(` ${w} `))) return true;
  // A rephrased row ("LLM integration (Groq, LLaMA 3.3)") is fine when every word of it is in those sources; an
  // invented technology ("Kafka", "Prometheus") is not in them, so it still fails.
  const words = norm(item).split(' ').filter((w) => w && !SKILL_STOP.has(w));
  return words.length > 0 && words.every((w) => corpus.includes(` ${w} `));
}
const SKILL_STOP = new Set(['and', 'or', 'of', 'the', 'with', 'for', 'in', 'on', 'to', 'a', 'an', 'basic', 'basics']);

function checkSkills(r, ctx, errors) {
  (r.skills || []).forEach((row) => {
    for (const item of splitTop(row.items)) {
      // An error, not a warning: the resume-tailor agent only reports warnings for reworded bullets, so an added
      // skill must stop the build (review 2026-10-09: "Prometheus, Kafka, Redis, GCP" passed as ok).
      if (!skillKnown(item, ctx)) errors.push({ type: 'skill-not-in-sources', where: `skills: ${row.label}`, text: item, detail: 'not a confirmed skill in master.json or facts.md', fix: 'drop it (or confirm it with the owner and add it to facts.md first)' });
    }
  });
}

// ---------------------------------------------------------------------------------------------------------
// Where a line belongs. A true line under the wrong job is untrue ("Shipped a Glean integration" under Gamma Project), so
// every master line and facts.md alternate gets a home: a master job ('exp:<company>|<title>') or project
// ('proj:<name>'). Alternates find theirs from their facts.md heading, by the rarest words it shares with a job.
// ---------------------------------------------------------------------------------------------------------

const homeOfJob = (j) => `exp:${j.company}|${j.title}`;
// A project keeps its home when its name grows a link or tag ("Widget Engine, Open Source Contributor (github.com/...)").
const homeOfProject = (p) => `proj:${String(p.name).split(/[,(]/)[0].trim()}`;

/** The home of a resume path ('experience[2].bullets[0]' -> that job's home), or null for other fields. */
function homeOfPath(r, path) {
  const m = path.match(/^(experience|projects)\[(\d+)\]/);
  if (!m) return null;
  const g = (r[m[1]] || [])[+m[2]];
  if (!g) return null;
  return m[1] === 'experience' ? homeOfJob(g) : homeOfProject(g);
}

const HOME_STOP = new Set(['and', 'the', 'of', 'for', 'in', 'on', 'a', 'an', 'to', 'present', 'jun', 'aug', 'nov', 'jan', 'may', 'dec', 'nc', 'va']);

/** The master home a facts.md heading names (the unique best word match), or null when it is unclear. */
function homeOfHeading(heading, master) {
  const homes = [...master.experience.map((j) => ({ home: homeOfJob(j), text: `${j.company} ${j.title}` })), ...master.projects.map((p) => ({ home: homeOfProject(p), text: p.name }))];
  const bag = (s) => new Set(toks(s).filter((w) => !HOME_STOP.has(w) && !/^\d+$/.test(w)));
  const sets = homes.map((h) => bag(h.text));
  const df = new Map();
  for (const s of sets) for (const w of s) df.set(w, (df.get(w) || 0) + 1);
  const want = bag(heading);
  const scored = homes.map((h, i) => ({ home: h.home, score: [...want].reduce((n, w) => n + (sets[i].has(w) ? 1 / df.get(w) : 0), 0) })).sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score <= 0 || (scored[1] && Math.abs(scored[1].score - scored[0].score) < 1e-9)) return null;
  return scored[0].home;
}

/** Lines that are fair game without review: master's lines and facts.md's quoted alternates / the clearance line. */
const sourceCache = new WeakMap();
function sourceLines(ctx) {
  const hit = sourceCache.get(ctx.master);
  if (hit && hit.facts === ctx.facts) return hit.src;
  const src = buildSourceLines(ctx);
  sourceCache.set(ctx.master, { facts: ctx.facts, src });
  return src;
}

function buildSourceLines(ctx) {
  const m = ctx.master;
  const src = [];
  const add = (text, from, fragment, home) => text && src.push({ text, from, fragment: !!fragment, home: home || null });
  m.experience.forEach((j) => j.bullets.forEach((b) => add(b, 'master', false, homeOfJob(j))));
  m.projects.forEach((p) => p.bullets.forEach((b) => add(b, 'master', false, homeOfProject(p))));
  m.education.extra.forEach((x) => add(x.text, 'master'));
  m.certifications.forEach((c) => add(`${c.label || ''}${c.text || ''} ${c.date || ''}`.trim(), 'master'));
  m.leadership.forEach((l) => add(`${l.bold || ''}${l.rest || ''}`.trim(), 'master'));
  for (const a of ctx.facts.alternates || []) add(a.text.replace(/^\.{3}|\.{3}$/g, '').trim(), `facts.md (${a.section})`, /^\.{3}|\.{3}$/.test(a.text), homeOfHeading(a.heading || a.section, m));
  if (ctx.facts.clearanceLine) add(ctx.facts.clearanceLine, 'facts.md (clearance line)');
  return src;
}

/**
 * A source line, and the same line without a trailing "(...)": dropping "(highest volume in the intern cohort)" only
 * says less. Not when what is left holds a superlative the parenthetical may qualify ("highest volume (among interns)").
 */
function variants(text) {
  const cut = String(text).replace(/\s*\([^()]*\)\s*$/, '');
  if (!cut || cut === text || /\b(highest|top|first|best|most|only|largest|fastest|leading|record)\b|#1/i.test(cut)) return [text];
  return [text, cut];
}

// Start verbs that say the same thing. Swapping within a group fixes REPEATED VERBS without changing a claim, so it
// is not a reworded line. Kept narrow on purpose: "Led", "Designed", "Architected" claim more and are never swaps.
const VERB_GROUPS = [
  ['built', 'developed', 'created', 'engineered', 'implemented'],
  ['build', 'develop', 'create', 'engineer', 'implement'],
  ['troubleshot', 'debugged', 'diagnosed'],
  ['secured', 'hardened'],
  ['shipped', 'delivered', 'released'],
  ['model', 'analyze', 'study'],
  ['assess', 'evaluate'],
  ['map', 'align'],
  ['gathered', 'collected'],
  ['authored', 'wrote'],
  ['held', 'maintained', 'sustained'],
];
const VERB_OF = new Map();
VERB_GROUPS.forEach((g, i) => g.forEach((v) => VERB_OF.set(v, i)));
const sameVerb = (a, b) => a !== b && VERB_OF.has(a) && VERB_OF.get(a) === VERB_OF.get(b);

function indexOfSeq(hay, needle, from) {
  for (let i = from; i + needle.length <= hay.length; i++) if (needle.every((w, k) => hay[i + k] === w)) return i;
  return -1;
}

/**
 * A bullet made only of approved parts: one source line (master or a whole facts.md alternate, maybe without its
 * trailing parenthetical) with approved "...fragment..." alternates put in place of some of its words, and/or its
 * first verb swapped for a synonym (VERB_GROUPS). Nothing new is said, so it is not a reworded line. The base line
 * and every fragment must belong to the bullet's own job (home). Returns { base, from, fragments, verb } or null.
 */
function composed(text, src, home) {
  const t = toks(text);
  if (t.length < 3) return null;
  const fits = (s) => !home || !s.home || s.home === home;
  const covered = new Array(t.length).fill(false);
  const used = [];
  for (const s of src) {
    if (!s.fragment || !fits(s)) continue;
    const f = toks(s.text);
    if (f.length < 3) continue;
    let hit = false;
    for (let i = indexOfSeq(t, f, 0); i >= 0; i = indexOfSeq(t, f, i + 1)) {
      for (let k = 0; k < f.length; k++) covered[i + k] = true;
      hit = true;
    }
    if (hit) used.push(s.text);
  }
  const runs = [];
  for (let i = 0; i < t.length; ) {
    if (covered[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < t.length && !covered[j]) j++;
    runs.push({ start: i, end: j, words: t.slice(i, j) });
    i = j;
  }
  if (!runs.length) return null;
  for (const s of src) {
    if (s.fragment || !fits(s)) continue;
    for (const base of variants(s.text)) {
      const b = toks(base);
      const words = runs.map((x) => x.words.slice());
      let verb = null;
      if (runs[0].start === 0 && sameVerb(words[0][0], b[0])) {
        verb = [words[0][0], b[0]];
        words[0][0] = b[0];
      }
      if (!used.length && !verb) continue; // nothing approved was put in: exact, or a reword
      let pos = 0;
      let ok = true;
      for (let k = 0; k < runs.length && ok; k++) {
        // Base words may only go where a fragment stands in for them: a run that starts (ends) the bullet must start
        // (end) the base line, and runs keep the base line's order.
        const at = runs[k].start === 0 ? (indexOfSeq(b, words[k], 0) === 0 ? 0 : -1) : indexOfSeq(b, words[k], pos);
        if (at < 0 || (runs[k].end === t.length && at + words[k].length !== b.length)) ok = false;
        pos = at + words[k].length;
      }
      if (ok) return { base: s.text, from: s.from, fragments: used, verb };
    }
  }
  return null;
}

/** Word-level difference of a line from its closest source: { added: ['and TypeScript'], dropped: ['for building ...'] }. */
function wordDiff(a, b) {
  const wa = String(a).split(/\s+/).filter(Boolean);
  const wb = String(b).split(/\s+/).filter(Boolean);
  const na = wa.map((w) => norm(w));
  const nb = wb.map((w) => norm(w));
  const L = Array.from({ length: wa.length + 1 }, () => new Array(wb.length + 1).fill(0));
  for (let i = wa.length - 1; i >= 0; i--) for (let j = wb.length - 1; j >= 0; j--) L[i][j] = na[i] === nb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const added = [];
  const dropped = [];
  let cur = null;
  const push = (list, w) => {
    if (cur && cur.list === list) cur.words.push(w);
    else {
      cur = { list, words: [w] };
      list.push(cur);
    }
  };
  let i = 0;
  let j = 0;
  while (i < wa.length || j < wb.length) {
    if (i < wa.length && j < wb.length && na[i] === nb[j]) {
      cur = null;
      i++;
      j++;
    } else if (j < wb.length && (i === wa.length || L[i][j + 1] >= L[i + 1][j])) push(dropped, wb[j++]);
    else push(added, wa[i++]);
  }
  const phrase = (x) => x.words.join(' ').replace(/^[,;:.]+|[,;:.]+$/g, '');
  const keep = (xs) => xs.map(phrase).filter((p) => norm(p));
  return { added: keep(added), dropped: keep(dropped) };
}

function checkLines(r, ctx, warnings, errors) {
  const src = sourceLines(ctx);
  const exact = new Set(src.filter((s) => !s.fragment).flatMap((s) => variants(s.text)).map((s) => norm(s)));
  const homesOf = new Map(); // a source line's text -> the homes it may stand under
  for (const s of src) {
    if (s.fragment) continue;
    for (const v of variants(s.text)) {
      const k = norm(v);
      if (!homesOf.has(k)) homesOf.set(k, new Set());
      homesOf.get(k).add(s.home);
    }
  }
  // "Relevant Coursework: A, B, C" is allowed when every course is in facts.md section 5 (short names: Adv., Admin).
  const course = norm(ctx.facts.coursework || '');
  const fullName = (c) => ` ${norm(c).replace(/\badv\b/, 'advanced').replace(/\badmin\b/, 'administration')} `;
  const priors = (ctx.priors || []).map((p) => ({ name: p.name, lines: new Set(strings(p.resume).map((s) => norm(s.text))) }));
  const lineOf = (path, text) => (/^(experience|projects)\[\d+\]\.bullets|^education\.extra|^certifications|^leadership/.test(path) ? text : null);
  for (const { path, text } of strings(r)) {
    if (!lineOf(path, text)) continue;
    const home = homeOfPath(r, path);
    if (exact.has(norm(text))) {
      const homes = homesOf.get(norm(text));
      if (home && homes && !homes.has(null) && !homes.has(home)) {
        const where = [...homes][0].replace(/^(exp|proj):/, '').replace('|', ': ');
        errors.push({ type: 'moved-line', where: label(r, path), text, detail: `this source line belongs to ${where}`, fix: 'move it back under that job, or use a line from this job' });
      }
      continue;
    }
    const comp = composed(text, src, home);
    if (comp) {
      if (ctx.composedOut) ctx.composedOut.push({ where: label(r, path), text, base: comp.base, fragments: comp.fragments, verb: comp.verb || undefined });
      continue;
    }
    const cw = path.startsWith('education.extra') && text.match(/^Relevant Coursework:\s*(.+)$/i);
    if (cw) {
      const bad = splitTop(cw[1]).filter((c) => !` ${course} `.includes(fullName(c)));
      if (bad.length) warnings.push({ type: 'coursework-not-in-facts', where: path, text: bad.join(', '), detail: 'not in facts.md section 5 (coursework)' });
      continue;
    }
    // A bullet that wraps an approved fragment ("...resolving 100+ enterprise customer cases in four weeks...")
    let best = { score: -1 };
    for (const s of src) {
      const via = s.fragment && norm(text).includes(norm(s.text));
      const score = via ? Math.max(closeness(text, s.text), 0.5) : closeness(text, s.text);
      if (score > best.score) best = { score, closest: s.text, from: s.from, via };
    }
    const seen = priors.find((p) => p.lines.has(norm(text)));
    const diff = best.closest ? wordDiff(text, best.closest) : { added: [], dropped: [] };
    warnings.push({
      type: 'reworded-line',
      where: label(r, path),
      score: Math.round(best.score * 100) / 100,
      text,
      closest: best.closest,
      source: best.from + (best.via ? ', contains an approved fragment' : ''),
      added: diff.added,
      dropped: diff.dropped,
      seenIn: seen ? seen.name : undefined,
    });
  }
}

/**
 * Lint one resume object.
 * ctx: { facts, master, priors?: [{name, resume}], company?, file?, knownCompanies? }
 * -> { ok, errors, warnings, notes }
 */
function lint(r, ctx) {
  const errors = [];
  const warnings = [];
  const notes = [];
  checkClaims(r, ctx.facts, errors);
  for (const { path, text } of strings(r)) {
    if (/—/.test(text)) errors.push({ type: 'em-dash', where: label(r, path), fix: 'rewrite without an em dash (owner rule)' });
    if (/site reliability/i.test(text)) errors.push({ type: 'sre-title', where: label(r, path), fix: 'the title is "Systems Reliability Engineer", never Site' });
  }
  checkCompany(r, ctx, errors, notes);
  checkFacts(r, ctx, errors, warnings);
  checkNumbers(r, ctx, errors);
  checkSkills(r, ctx, errors);
  const composedLines = [];
  checkLines(r, { ...ctx, composedOut: composedLines }, warnings, errors);
  warnings.sort((a, b) => (a.score ?? 2) - (b.score ?? 2));
  return { ok: errors.length === 0, errors, warnings, notes, composed: composedLines };
}

module.exports = { lint, claimableFacts, similarity, closeness, splitTop, norm, strings, label, claimRules, companiesFromFiles, squash, termRegex, composed, wordDiff, sourceLines, homeOfHeading, homeOfPath, VERB_GROUPS };
