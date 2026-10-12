'use strict';
/*
 * Compact output for Claude. Every jobctl result is read by Claude, so a long JSON dump costs context on every
 * later turn. These functions turn the full objects into short ones (or short text). Pure: plain objects in,
 * plain objects or strings out; bin/jobctl prints them. `--full` on a command prints the full object instead.
 */
const { exitCode } = require('./followup');

const MEANING = {
  submitted: 'done: submitted',
  already_applied: 'done: already applied',
  closed: 'done: posting closed',
  dropped: 'dropped',
  needs_input: 'needs input: answer the needs, then continue',
  needs_review: 'needs review: check the page, then continue',
  blocked: 'blocked: a human step in the browser, then continue',
  ready_to_submit: 'ready to submit: not pressed',
};

const OPTION_KEEP = 12;

/** One clean line of text, cut to n characters ("…" when cut). Empty input gives undefined (dropped from output). */
function clip(s, n) {
  if (s == null || s === '') return undefined;
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** Remove keys whose value is undefined, so the JSON stays short. */
function compact(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** "10 needs input: answer the needs, then continue": the exit code and what it asks of the owner. */
const exitLine = (status) => `${exitCode(status)} ${MEANING[status] || 'unknown status'}`;

/** Option strings only, whole (answers must match an option exactly; objects use their text / label / value). */
function optionTexts(opts) {
  return (opts || []).map((o) => clip(typeof o === 'string' ? o : (o && (o.text || o.label || o.value)) || JSON.stringify(o), 400)).filter((x) => x !== undefined);
}

/** The first 12 options, plus optionCount when there are more (`jobctl options <ref>` lists them all). */
function briefOptions(o, opts) {
  if (!Array.isArray(opts) || !opts.length) return o;
  o.options = optionTexts(opts).slice(0, OPTION_KEEP);
  if (opts.length > OPTION_KEEP) o.optionCount = opts.length;
  return o;
}

// Every field the /apply skill's needs table acts on (type, declined topic, Workday site/email/note, review source,
// file slot, date placeholder) must survive here: a dropped field means a wrong answer or a needless question.
const NEED_TEXT = { ref: 80, label: 160, kind: 24, type: 40, hint: 200, error: 200, tried: 200, value: 200, declined: 120, topic: 120, site: 120, email: 120, note: 300, source: 80, for: 40, placeholder: 80, pageText: 400 };
const NEED_FLAGS = ['required', 'consent', 'aiPolicy', 'pressed', 'optional'];

/** One need: what the page asked, what the bot did with it, and the choices. Full text is dropped. */
function briefNeed(n) {
  const o = {};
  for (const [k, max] of Object.entries(NEED_TEXT)) {
    if (typeof n[k] === 'boolean') continue; // flags are handled below (declined: false must not print "false")
    const v = clip(n[k], max);
    if (v !== undefined) o[k] = v;
  }
  for (const k of NEED_FLAGS) if (n[k] === true) o[k] = true;
  if (n.declined === true) o.declined = true; // older runs stored a bare flag
  // A validation stop: the messages the page showed and the required fields that are still empty.
  if (Array.isArray(n.errors) && n.errors.length) o.errors = n.errors.slice(0, 3).map((e) => clip(e, 160));
  if (Array.isArray(n.emptyRequired) && n.emptyRequired.length) o.emptyRequired = n.emptyRequired.slice(0, 8).map((f) => clip(f.label || f.ref, 80));
  return briefOptions(o, n.options);
}

/**
 * The compact form of one run report (lib/apply.js report(), or a run object): run id, status and exit meaning,
 * company, role, url, message, errors, needs[], the last screenshot, and the tracker row when it was submitted.
 */
function briefRun(r) {
  if (!r || typeof r !== 'object') return r;
  const o = {
    run: r.run || r.id,
    status: r.status,
    exit: r.status ? exitLine(r.status) : undefined,
    company: clip(r.company, 120),
    role: clip(r.role, 160),
    url: r.url,
    message: clip(r.message, 400),
  };
  if (Array.isArray(r.errors) && r.errors.length) o.errors = r.errors.slice(0, 5).map((e) => clip(e, 200));
  if (Array.isArray(r.needs) && r.needs.length) o.needs = r.needs.map(briefNeed);
  if (r.shot) o.shot = r.shot;
  if (r.row) o.row = r.row;
  if (r.previous) o.previous = compact({ run: r.previous.run, at: r.previous.at, company: clip(r.previous.company, 120) });
  if (r.dry) o.dry = true;
  return compact(o);
}

/** One answer / answer-batch / code result: the counts, the failures (with their choices) and the warnings. */
function briefAnswer(a) {
  if (!a || typeof a !== 'object') return a;
  const o = {};
  for (const k of ['ok', 'answered', 'boxes', 'filled', 'savedAs']) if (a[k] !== undefined) o[k] = a[k];
  o.placeholder = clip(a.placeholder, 80); // a rejected date: the format the field expects
  o.reason = clip(a.reason, 300);
  o.error = clip(a.error, 200);
  o.warning = clip(a.warning, 300);
  o.note = clip(a.note, 200);
  if (Array.isArray(a.failed) && a.failed.length) o.failed = a.failed.map((f) => briefOptions(compact({ ref: f.ref, error: clip(f.error, 200) }), f.options));
  if (Array.isArray(a.warnings) && a.warnings.length) o.warnings = a.warnings.map((w) => compact({ ref: w.ref, warning: clip(w.warning, 300) }));
  return briefOptions(compact(o), a.options);
}

/** One line of a batch: url, status, run, company, role, message; the tracker row when it was submitted. */
function briefBatchItem(it) {
  return compact({
    url: it.url,
    status: it.status,
    run: it.run,
    company: clip(it.company, 120),
    role: clip(it.role, 160),
    message: clip(it.message, 300),
    needs: it.needs,
    row: it.row,
  });
}

/**
 * What a command that drives a run prints by default: a run report, a `--continue` result ({answered, run} or
 * {answered, continued:false, reason}), or a batch ({count, results}).
 */
function briefReport(rep) {
  if (!rep || typeof rep !== 'object') return rep;
  if (rep.answered && typeof rep.answered === 'object' && (rep.run !== undefined || rep.continued === false)) {
    if (rep.continued === false) return { answered: briefAnswer(rep.answered), continued: false, reason: clip(rep.reason, 300) };
    return { answered: briefAnswer(rep.answered), run: briefRun(rep.run) };
  }
  if (Array.isArray(rep.results)) return { count: rep.count, results: rep.results.map(briefBatchItem) };
  return briefRun(rep);
}

/** `jobctl snap --brief`: the page in text, one line per field and one line for the buttons. */
function snapText(s) {
  const lines = [`page: ${s.page || '?'}${s.nav ? `  next: "${clip(s.nav.text, 40)}"` : ''}  tab ${s.tabId}`];
  if (s.title) lines.push(`title: ${clip(s.title, 120)}`);
  if (s.url) lines.push(`url: ${s.url}`);
  for (const f of s.fields || []) {
    const opts = Array.isArray(f.options) ? `  [${f.options.length} options]` : '';
    lines.push(`${f.ref}  ${f.kind}${f.required ? ' *' : ''}  "${clip(f.label, 100) || ''}"  = ${clip(f.value, 60) || '(empty)'}${opts}`);
  }
  if ((s.fields || []).length === 0) lines.push('fields: none');
  const btns = (s.buttons || []).filter((b) => clip(b.text, 40)).map((b) => `${b.ref} "${clip(b.text, 40)}"`);
  if (btns.length) lines.push('buttons: ' + btns.join(' | '));
  const errs = (s.signals && s.signals.errors) || [];
  if (errs.length) lines.push('errors: ' + errs.slice(0, 2).map((e) => clip(e, 120)).join(' | '));
  return lines.join('\n');
}

/** The truthy flags of a posting as one line (arrays joined). */
function flagText(f) {
  if (!f) return '';
  return Object.entries(f)
    .filter(([, v]) => v && (!Array.isArray(v) || v.length))
    .map(([k, v]) => (Array.isArray(v) ? `${k}: ${v.slice(0, 3).join(', ')}` : v === true ? k : `${k}: ${clip(v, 40)}`))
    .join('; ');
}

/** `jobctl discover --brief`: one line per hit. Default discover output stays the JSON other code reads. */
const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch (e) {
    return 'external';
  }
};

/** Handshake hits: where the application happens ([HS native] / [HS -> ats] / [HS: find the posting]). */
function hsTag(p) {
  if (p.source !== 'handshake') return p.handshakeUrl ? ' [also on HS]' : '';
  if (p.applyVia === 'handshake') return ` [HS native${p.documents && p.documents.some((d) => d !== 'resume') ? ': ' + p.documents.join('+') : ''}]`;
  if (p.applyVia === 'external') return ` [HS -> ${p.ats && p.ats !== 'external' ? p.ats : hostOf(p.url)}]`;
  if (p.applyVia === 'external-unresolved') return ' [HS: careers page, jobctl find]';
  return ` [HS ${p.applyVia || '?'}]`;
}

function discoverText(res) {
  const head = `${res.count} hits (searched ${res.searched} boards, ${res.unreachable} unreachable)`;
  const warn = res.simplify && res.simplify.warning ? ' | ' + clip(res.simplify.warning, 120) : '';
  const hs = res.handshake;
  // Handshake: how many it found and kept, or why it was skipped (logged out: the owner logs in once in the jobbot window).
  const hsText = !hs || !hs.enabled ? '' : hs.error ? ` | Handshake skipped: ${clip(hs.error, 140)}` : ` | Handshake: ${hs.found} found, ${hs.kept} kept, ${hs.deduped} already listed`;
  const lines = [head + warn + hsText];
  res.postings.forEach((p, i) => {
    const age = p.ageDays == null ? 'age ?' : `${p.ageDays}d`;
    const pay = p.payPerHour ? `$${p.payPerHour}/hr` : 'pay ?';
    const tail = p.skip ? `SKIP ${clip(p.skip, 60)}` : flagText(p.flags) || 'ok';
    const was = p.inTracker && !p.skip ? ` [applied there: ${clip((p.appliedRoles || []).join('; ') || 'role not on file', 50)}]` : '';
    const acct = (p.needsAccount ? ' [needs account]' : '') + was + hsTag(p);
    // The url ends the line: /find queues picks by it (discover --new marks hits seen, so a re-run would not list them).
    lines.push(`${i + 1}. ${clip(p.company, 40) || '?'} | ${clip(p.title, 70) || '?'} | ${clip(p.location, 40) || '?'} | ${age} | ${pay} | ${tail}${acct} | ${p.url || p.apply || '?'}`);
  });
  return lines.join('\n');
}

// Rough topics for the Q&A bank, first match wins. Used only to count entries, never to answer anything.
const TOPICS = [
  ['work authorization / sponsorship', /sponsor|visa|work authori|authorized to work|eligib|citizen/i],
  ['EEO / self-identification', /gender|\brace\b|ethnic|veteran|disabilit|pronoun|sexual orientation|hispanic|self[- ]identif/i],
  ['school / GPA / degree', /gpa|school|universit|college|degree|graduat|\bmajor\b|coursework|transcript/i],
  ['dates / availability', /start date|availab|how soon|when can|earliest|\bterm\b|internship (dates|period)/i],
  ['pay / location / hours', /salary|\bpay\b|compensation|relocat|willing to|commut|\bhours\b|location/i],
  ['contact / links', /phone|e-?mail|linkedin|github|website|portfolio|address|\bcity\b|\bzip\b|postal|\bstate\b|country/i],
  ['previous employment / conflicts', /previous|former|employ(ed|ment)|worked (for|at|with)|relat(ed|ion|ionship)|relative|family|subsidiar|\bfirms?\b|conflict|within (the )?(last|past)/i],
  ['how you heard / referral', /hear about|referr|\bsource\b|how did you/i],
  ['clearance / background / legal', /clearance|background|criminal|felony|convict|drug|military|served|government|official|legal|older|\bage\b|minimum age|licen[sc]e|driver/i],
  ['agreements / compliance', /\bnda\b|non-?compet|agree|consent|acknowledg|attest|complian|regulat|ethic|privacy|terms|adheres|policy|restrict|personal data|confirm/i],
  ['skills / languages', /english|languages?|proficien|years of experience|experience (with|in)|skills?|programming|certification|\btools?\b/i],
  ['about you / why us', /\bwhy\b|tell us|describe|what interests|about yourself|motivat|strength|challenge|project|question/i],
];

/** Counts of the Q&A bank by rough topic. */
function answersSummary(entries) {
  const counts = new Map();
  let sensitive = 0;
  for (const e of entries || []) {
    if (e.sensitive) sensitive++;
    const q = String(e.question || '');
    const hit = TOPICS.find(([, re]) => re.test(q));
    const t = hit ? hit[0] : 'other';
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return { total: (entries || []).length, sensitive, topics: [...counts].sort((a, b) => b[1] - a[1]) };
}

function answersText(sum) {
  const lines = [`${sum.total} saved answers (${sum.sensitive} marked sensitive). By topic:`];
  for (const [t, n] of sum.topics) lines.push(`  ${String(n).padStart(3)}  ${t}`);
  lines.push('Search: jobctl answers <word>   everything: jobctl answers --all');
  return lines.join('\n');
}

/** One applied (submitted) posting from data/applied.jsonl. */
function logLine(a) {
  const where = a.location ? `  ${clip(a.location, 40)}` : '';
  return `${String(a.at || '').slice(0, 10)}  ${clip(a.company, 40) || '?'} - ${clip(a.role, 60) || '?'}${where}  [${a.run || '?'}]`;
}

/** One queue item: "#4 pending  Acme - Intern  https://…". */
function queueLine(i) {
  const what = `${clip(i.company, 30) || '?'} - ${clip(i.role, 50) || '?'}`;
  const tail = i.status === 'done' ? `  (${i.result || 'done'}${i.run ? ', run ' + i.run : ''})` : i.note ? `  note: ${clip(i.note, 60)}` : '';
  return `#${i.n} ${String(i.status).padEnd(7)}  ${what}  ${i.url}${tail}`;
}

/** One session's scorecard line (lib/hiccups.js scorecard()). */
function scorecardLine(s) {
  const f = (v, unit) => (v == null ? '-' : v + unit);
  const top = s.topOpenCluster ? `, top open: ${clip(s.topOpenCluster.what, 40)}` : '';
  return `${s.session}: ${s.submitted} submitted, ${f(s.minutesPerSubmit, ' min')}/submit, ${f(s.stopsPerSubmit, '')} stops/submit, ${f(s.handFixesPerSubmit, '')} hand fixes/submit, owner wait ${s.ownerWaitMinutes} min${top}`;
}

/**
 * `jobctl session start --brief` (SessionStart hook): at most 12 lines. Queue and tracker counts, the last
 * scorecard lines as a trend, and the top open hiccup clusters.
 */
function sessionBrief(o) {
  const lines = [`jobbot session ${o.session.id} started. Hand fixes log themselves; end with jobctl session report --save (scorecard).`];
  lines.push(`queue: ${o.queueOpen} pending (jobctl queue) | tracker: ${o.unlogged} submitted run(s) without a row (jobctl rows --unlogged)`);
  if (o.trend && o.trend.length) {
    lines.push(`scorecard, last ${o.trend.length}:`);
    for (const s of o.trend) lines.push('  ' + scorecardLine(s));
  } else lines.push('scorecard: none yet');
  if (o.open && o.open.length) {
    lines.push(`open hiccups (top ${o.open.length}):`);
    for (const c of o.open) lines.push(`  x${c.count} ${c.ats} ${c.cmd || c.kind}: ${clip(c.what, 70) || ''}`);
  } else lines.push('open hiccups: none');
  return lines.join('\n');
}

module.exports = {
  clip,
  exitLine,
  briefNeed,
  briefRun,
  briefAnswer,
  briefReport,
  briefBatchItem,
  snapText,
  discoverText,
  flagText,
  answersSummary,
  answersText,
  logLine,
  queueLine,
  scorecardLine,
  sessionBrief,
  TOPICS,
};
