'use strict';
/*
 * Hiccup log (data/hiccups.jsonl): everything that slowed a session down, including what the friction
 * log (driver stops, lib/apply.js logFriction) never sees. Owner ask, 2026-10-08: every jobbot session
 * documents its hiccups on its own, and when the applying is done Claude brainstorms fixes and applies them.
 *
 * Sources:
 *   - automatic: every hand fix on a run (jobctl click / set / answer / answer-batch / upload / options /
 *     goto / drop) is logged as kind "manual", so hand work that keeps recurring shows up as a cluster;
 *   - by hand: `jobctl hiccup "<what happened>" [--kind K] [--fix "idea"]` for things only Claude notices
 *     (a LinkedIn repost that was weeks old, a board missing from boards.json, a wrong county);
 *   - driver stops: data/friction.jsonl, read here, not copied.
 *
 * Sessions (data/session.json): `jobctl session start` (a SessionStart hook runs it) marks the start and
 * prints the clusters earlier sessions left open; `jobctl session report` groups this session's hiccups
 * and stops into clusters for the end-of-session fix pass (also saved to data/sessions/<id>.md);
 * `jobctl hiccup --resolve <key> "<what fixed it>"` closes a cluster.
 */
const fs = require('node:fs');
const path = require('node:path');
const P = require('./paths');
const { isStop } = require('./friction');

const FILE = () => path.join(P.DATA, 'hiccups.jsonl');
const SESSION = () => path.join(P.DATA, 'session.json');
const RESOLVED = () => path.join(P.DATA, 'hiccups-resolved.json');
const KINDS = ['manual', 'bug', 'slow', 'blocked', 'data', 'search', 'other'];
const NO_LABEL = '(no field label)'; // a hand fix whose ref matched no need in the run
const WAITING = ['needs_input', 'blocked', 'needs_review'];
const WAIT_CAP_MIN = 60; // one stop never counts more than this as owner wait (an overnight stop is not a wait)

function readJson(f, dflt) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    return dflt;
  }
}

function readLines(f) {
  try {
    return fs
      .readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

function session() {
  return readJson(SESSION(), null);
}

function atsOf(run) {
  if (run && run.ats) return run.ats;
  try {
    return require('./urls').atsOf(run.url);
  } catch (e) {
    return 'unknown';
  }
}

/** Refs, numbers, quoted values and URLs vary per page; the cluster key keeps what repeats. */
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b\d+:\d+\b/g, '<ref>')
    .replace(/"[^"]*"/g, '<v>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

function keyOf(h) {
  // --topic groups free-text hiccups that describe the same problem in different words.
  const what = h.label || h.detail || (h.kind === 'manual' ? NO_LABEL : '');
  return [h.kind, h.ats || '-', h.cmd || '-', h.topic ? '#' + normalize(h.topic) : normalize(what)].join('|');
}

/**
 * The run's need for a hand-fix ref, or null. Refs are "<frame>:<ref>" (lib/apply.js). Exact match first; a bare
 * number matches the need in any frame, but "0:12" never matches "3:12" (another frame's field: that was the
 * wrong label on hand fixes before this).
 */
function needFor(run, ref) {
  if (!ref) return null;
  const needs = (run && run.needs) || [];
  const exact = needs.find((n) => n.ref === ref);
  if (exact) return exact;
  return /^\d+$/.test(String(ref)) ? needs.find((n) => String(n.ref).endsWith(':' + ref)) || null : null;
}

/** Append one hiccup. Never throws: logging must not break a run or a command. */
function log(h) {
  try {
    const s = session();
    const rec = { at: new Date().toISOString(), session: s ? s.id : null, kind: KINDS.includes(h.kind) ? h.kind : 'other', ...h };
    if (!KINDS.includes(rec.kind)) rec.kind = 'other';
    rec.key = keyOf(rec);
    fs.mkdirSync(P.DATA, { recursive: true });
    fs.appendFileSync(FILE(), JSON.stringify(rec) + '\n');
    return rec;
  } catch (e) {
    return null;
  }
}

/** A hand fix on a run (called from bin/jobctl). `label` is the field / button it touched, when known. */
function manual(cmd, run, extra) {
  const r = run || {};
  const ref = (extra && extra.ref) || null;
  const need = needFor(r, ref);
  return log({
    kind: 'manual',
    cmd,
    run: r.id || null,
    company: r.company || null,
    ats: r.id ? atsOf(r) : (extra && extra.ats) || 'unknown',
    status: r.status || null,
    ref: ref || undefined,
    label: (extra && extra.label) || (need && need.label) || require('./focus').labelOf(ref) || null,
    detail: (extra && extra.detail) || null,
  });
}

function start(now) {
  const prev = session();
  const at = now || new Date();
  const s = { id: at.toISOString().replace(/[:.]/g, '-').slice(0, 19), startedAt: at.toISOString(), previous: prev ? prev.id : null };
  fs.mkdirSync(P.DATA, { recursive: true });
  fs.writeFileSync(SESSION(), JSON.stringify(s, null, 2));
  return { session: s, open: clusters({ days: 14 }).filter((c) => !c.resolved).slice(0, 8) };
}

/** Driver stops from friction.jsonl that were not submits, in the same shape as hiccups. */
function frictionStops(since) {
  return readLines(path.join(P.DATA, 'friction.jsonl'))
    .filter((r) => Date.parse(r.at) >= since && isStop(r))
    .map((r) => {
      const h = { at: r.at, kind: 'blocked', cmd: 'stop:' + r.status, ats: r.ats, company: r.company, run: r.run, detail: (r.needTypes || []).length ? [...new Set(r.needTypes)].sort().join(',') : r.message };
      h.key = keyOf(h);
      return h;
    });
}

/**
 * Group hiccups (and, unless noFriction, driver stops) since `sinceIso` (default: the current session's
 * start; `days` overrides) by key. Most frequent first; resolved clusters are flagged, not dropped.
 */
function clusters(opts) {
  const o = opts || {};
  const s = session();
  const since = o.days ? Date.now() - o.days * 86400000 : Date.parse(o.since || (s && s.startedAt) || 0) || 0;
  const rows = readLines(FILE())
    .filter((h) => Date.parse(h.at) >= since)
    .map((h) => ({ ...h, key: h.key || keyOf(h) }))
    .concat(o.noFriction ? [] : frictionStops(since));
  const resolved = readJson(RESOLVED(), {});
  const map = new Map();
  for (const h of rows) {
    const c = map.get(h.key) || { key: h.key, kind: h.kind, ats: h.ats || '-', cmd: h.cmd || null, topic: h.topic || null, what: h.label || h.detail || (h.kind === 'manual' ? NO_LABEL : h.cmd), details: [], count: 0, companies: [], fixIdeas: [], first: h.at, last: h.at };
    c.count += 1;
    if (h.company && !c.companies.includes(h.company)) c.companies.push(h.company);
    if (h.fix && !c.fixIdeas.includes(h.fix)) c.fixIdeas.push(h.fix);
    if (h.detail && c.details.length < 5 && !c.details.includes(h.detail)) c.details.push(h.detail);
    if (h.at < c.first) c.first = h.at;
    if (h.at > c.last) c.last = h.at;
    map.set(h.key, c);
  }
  return [...map.values()]
    .map((c) => {
      const r = resolved[c.key];
      // A cluster that came back after its fix is open again.
      return r && c.last <= r.at ? { ...c, resolved: r } : c;
    })
    .sort((a, b) => !!a.resolved - !!b.resolved || b.count - a.count || (a.last < b.last ? 1 : -1));
}

function resolve(key, fix) {
  const all = readJson(RESOLVED(), {});
  all[key] = { at: new Date().toISOString(), fix: fix || '' };
  fs.writeFileSync(RESOLVED(), JSON.stringify(all, null, 2));
  return { key, ...all[key] };
}

function median(xs) {
  const a = xs.filter(Number.isFinite).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * The numbers the improvement loop tracks for one session: submits; minutes per submit (run created -> submitted,
 * median); stops and hand fixes per submit; owner wait (minutes a stopped run sat until its next event, at most
 * WAIT_CAP_MIN each); and the top open cluster. Read from friction.jsonl and hiccups.jsonl since the session start.
 */
function scorecard(now) {
  const s = session();
  const since = Date.parse((s && s.startedAt) || 0) || 0;
  const end = (now || new Date()).getTime();
  const rows = readLines(path.join(P.DATA, 'friction.jsonl')).filter((r) => !r.dry && Date.parse(r.at) >= since);
  const manual = readLines(FILE()).filter((h) => h.kind === 'manual' && Date.parse(h.at) >= since);
  const lastByRun = new Map();
  for (const r of rows) lastByRun.set(r.run, r);
  const submitted = [...lastByRun.values()].filter((r) => r.status === 'submitted');
  const stops = rows.filter(isStop).length;
  // Events per run (stops and hand fixes), to find when a stopped run got its next push from the owner.
  const events = new Map();
  for (const e of [...rows.map((r) => ({ run: r.run, t: Date.parse(r.at) })), ...manual.filter((h) => h.run).map((h) => ({ run: h.run, t: Date.parse(h.at) }))]) {
    if (!events.has(e.run)) events.set(e.run, []);
    events.get(e.run).push(e.t);
  }
  let waitMs = 0;
  for (const r of rows.filter((x) => WAITING.includes(x.status))) {
    const t = Date.parse(r.at);
    const later = (events.get(r.run) || []).filter((x) => x > t);
    const until = later.length ? Math.min(...later) : end; // still waiting: counts up to now
    waitMs += Math.min(until - t, WAIT_CAP_MIN * 60000);
  }
  const top = report().clusters.find((c) => !c.resolved);
  const per = (n) => (submitted.length ? +(n / submitted.length).toFixed(1) : null);
  return {
    session: s ? s.id : 'adhoc',
    start: s ? s.startedAt : null,
    end: new Date(end).toISOString(),
    submitted: submitted.length,
    // null (not 0) when no submitted run recorded its minutes: a missing number must not read as "instant".
    minutesPerSubmit: (() => { const m = submitted.map((r) => r.minutes).filter((x) => typeof x === 'number'); return m.length ? Math.round(median(m)) : null; })(),
    stopsPerSubmit: per(stops),
    handFixesPerSubmit: per(manual.length),
    stops,
    handFixes: manual.length,
    ownerWaitMinutes: Math.round(waitMs / 60000),
    topOpenCluster: top ? { key: top.key, count: top.count, what: String(top.topic || top.what || '').slice(0, 80) } : null,
  };
}

/** Upsert one session's line in data/sessions/scorecard.jsonl (a second report in the same session replaces it). */
function saveScorecard(sc) {
  fs.mkdirSync(path.dirname(P.SCORECARD), { recursive: true });
  const lines = readLines(P.SCORECARD).filter((x) => x.session !== sc.session).concat([sc]);
  fs.writeFileSync(P.SCORECARD, lines.map((x) => JSON.stringify(x)).join('\n') + '\n');
  return P.SCORECARD;
}

/** The last n scorecard lines, oldest first (the session brief shows them as a trend). */
function scorecards(n) {
  return readLines(P.SCORECARD).slice(-(n || 3));
}

function submittedSince(since) {
  return readLines(path.join(P.DATA, 'friction.jsonl')).filter((r) => Date.parse(r.at) >= since && !r.dry && r.status === 'submitted').length;
}

function report(opts) {
  const o = opts || {};
  const s = session();
  const since = o.days ? Date.now() - o.days * 86400000 : Date.parse((s && s.startedAt) || 0) || 0;
  const cl = clusters({ ...o, since: new Date(since).toISOString() });
  const open = cl.filter((c) => !c.resolved);
  return {
    session: s ? s.id : null,
    since: new Date(since).toISOString(),
    submitted: submittedSince(since),
    hiccups: cl.reduce((n, c) => n + c.count, 0),
    open: open.length,
    clusters: cl,
    next: open.length
      ? 'Fix pass: for the top clusters write the root cause and 2-3 candidate fixes (impact, effort, risk), pick the best, implement with a regression test, run the suite, then `jobctl hiccup --resolve <key> "<fix>"`.'
      : 'No open hiccups.',
  };
}

function markdown(rep) {
  const lines = [`# jobbot session ${rep.session || '(none)'}`, '', `Since ${rep.since}. Submitted: ${rep.submitted}. Hiccups: ${rep.hiccups} in ${rep.clusters.length} clusters (${rep.open} open).`, ''];
  for (const c of rep.clusters) {
    lines.push(`- [${c.resolved ? 'fixed' : 'open'}] x${c.count} ${c.kind} ${c.ats}${c.cmd ? ' ' + c.cmd : ''}: ${c.topic || c.what || ''}${c.companies.length ? ` (${c.companies.join(', ')})` : ''}`);
    if (c.fixIdeas.length) lines.push(`  - ideas: ${c.fixIdeas.join(' / ')}`);
    if (c.resolved) lines.push(`  - fix: ${c.resolved.fix}`);
    lines.push(`  - key: \`${c.key}\``);
  }
  lines.push('', rep.next, '');
  return lines.join('\n');
}

function save(rep) {
  const dir = path.join(P.DATA, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${rep.session || 'adhoc'}.md`);
  fs.writeFileSync(f, markdown(rep));
  return f;
}

module.exports = { log, manual, start, session, clusters, resolve, report, markdown, save, normalize, keyOf, needFor, median, scorecard, saveScorecard, scorecards, KINDS, NO_LABEL };
