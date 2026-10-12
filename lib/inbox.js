'use strict';
/*
 * /inbox support: classify application emails, match them to tracker rows, plan row updates.
 * Pure and offline: the skill does the Gmail search and the ArtifactData reads/writes; this file only
 * decides. Nothing here talks to a network, sends mail, or writes the tracker.
 *
 * Status vocabulary (the tracker's `status` field; /apply writes "applied"):
 *   applied(1) < assessment(2) < interview(3) < offer(4)      rejected = terminal side state
 * An email never lowers a status. "Application received" and recruiter outreach add a note only.
 * A rejection ends a row (any status but offer). Anything arriving after "rejected" (an interview
 * invite, an OA) is noted but the status stays: it is probably a different role, the owner decides.
 * Unknown existing statuses (blocked, "Interviewing", ...) are normalised by keyword; if nothing
 * matches the rank is 0, so the first real signal can move it.
 */
const fs = require('node:fs');
const path = require('node:path');
const P = require('./paths');

const STATE_FILE = path.join(P.DATA, 'inbox-state.json');
const DEFAULT_DAYS = 14;

// Tracker statuses (app-tracker): applied, assessment, interviewing, offer, rejected, closed.
// 'interview' is kept as an alias so rows written before 2026-10-09 still rank.
const RANK = { applied: 1, assessment: 2, interviewing: 3, interview: 3, offer: 4 };
const KIND_STATUS = { rejection: 'rejected', oa: 'assessment', interview: 'interviewing' };
const KIND_LABEL = { rejection: 'Rejection', oa: 'Online assessment', interview: 'Interview', received: 'Application received', recruiter: 'Recruiter outreach', other: 'Other' };

/* ---------- classification ---------- */

const NOISE_FROM = /(jobalerts?-noreply|jobs-listings|jobs-noreply|jobalert|newsletter|digest|marketing|promo)[^@]*@|@(e\.|mail\.)?(joinhandshake\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com)|@linkedin\.com/i;
const NOISE_SUBJECT = /job alert|jobs? (for you|you may|recommended)|new jobs?\b|recommended jobs|jobs similar|top jobs|weekly digest|newsletter|\bis hiring\b|people also viewed|handshake.*(digest|weekly)/i;
const LINKEDIN_APPLIED = /your application (was sent|to\b)|application submitted/i;

const REJECT = /unfortunately|not moving forward|not be moving forward|will not be proceeding|other candidates|not (been )?selected|regret to inform|decided (not )?to (move|proceed|pursue)|position has been filled|no longer (being )?consider|not a (match|fit)|unable to (offer|move (you )?forward)|move forward with (other|another)/i;
const OA_VENDOR = /hackerrank|codesignal|codility|coderpad|hirevue|karat\b|testgorilla|criteria corp|shl\.com|pymetrics|vervoe|codingame/i;
const OA_PHRASE = /online assessment|coding (challenge|assessment|test)|technical assessment|take-?home|complete (the|your|an|our) (online )?(assessment|challenge)|invit\w+ you to (complete|take) (an?|the|our)\b[^.]{0,40}(assessment|challenge|test)|skills assessment/i;
const INTERVIEW_STRONG = /calendly|goodtime|schedule (a|your|an|the) (call|interview|time|chat|conversation|phone)|invite you to (an? )?(interview|chat)|like to (schedule|invite|interview)|select a (time|slot)|book a time|pick a time|your availability|interview (confirmation|invitation|scheduled|details)|phone screen|video interview|on-?site interview|confirmed for/i;
const INTERVIEW_WEAK = /\binterview/i;
const RECEIVED = /received your application|thank(s| you) for (applying|your (application|interest))|application (has been |was )?(received|submitted)|we(?:'ve| have) received|successfully (applied|submitted)|your application (to|for|with)\b|application confirmation|thanks for applying/i;
const RECRUITER = /came across your (profile|resume)|reaching out|recruiter|opportunity|would you be open|your background|connect (for|about) a (role|position)/i;

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

function emailDate(e) {
  const d = new Date(e && (e.date || e.internalDate) || NaN);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}
function iso(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
function addDays(d, n) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
}
/** Build a UTC date from a month/day with the year implied by the email date (next year if it'd be long past). */
function resolveYMD(month, day, year, ref) {
  let y = year ? Number(year) : ref.getUTCFullYear();
  if (y < 100) y += 2000;
  let d = new Date(Date.UTC(y, month, day));
  if (d.getUTCMonth() !== month) return null; // 31 February
  if (!year && d.getTime() < ref.getTime() - 30 * 86400000) d = new Date(Date.UTC(y + 1, month, day));
  return d;
}

/**
 * Find a deadline / event date in text, relative to the email date.
 * Returns {date:'YYYY-MM-DD', time?:'HH:MM', text} or null. `eventToo`: also accept a bare "on <date>" (interview times).
 */
function extractDeadline(text, refDate, eventToo) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const ref = refDate instanceof Date ? refDate : new Date(refDate || Date.now());
  const lead = eventToo
    ? '(?:by|before|until|due(?: on| by)?|expires?(?: on)?|deadline(?: is| of)?|no later than|on|for|scheduled for)'
    : '(?:by|before|until|due(?: on| by)?|expires?(?: on)?|deadline(?: is| of)?|no later than|complete(?:d)? by|within)';
  const wd = '(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?,?\\s+)?';
  const timeTail = '(?:[ ,]*(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?)?';
  const fin = (d, m, text) => {
    const out = { date: iso(d), text: text.trim() };
    if (m && m[1] && m[3]) {
      let h = Number(m[1]) % 12;
      if (/^p/i.test(m[3])) h += 12;
      out.time = `${String(h).padStart(2, '0')}:${m[2] || '00'}`;
    }
    return out;
  };
  let m;
  // within N days / hours
  if ((m = t.match(/within (?:the next )?(\d{1,2}) (business )?(day|hour|week)s?/i))) {
    const n = Number(m[1]);
    const days = /hour/i.test(m[3]) ? Math.max(1, Math.ceil(n / 24)) : /week/i.test(m[3]) ? n * 7 : n;
    return { date: iso(addDays(ref, days)), text: m[0] };
  }
  // "by October 14", "on Tuesday, Oct 14, 2026 at 2:00 PM"
  const re1 = new RegExp(`${lead}\\s+${wd}${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?${timeTail}`, 'i');
  if ((m = t.match(re1))) {
    const d = resolveYMD(MONTHS[m[1].slice(0, 3).toLowerCase()], Number(m[2]), m[3], ref);
    if (d) return fin(d, [null, ...m.slice(4)], m[0]);
  }
  // "by 14 October"
  const re2 = new RegExp(`${lead}\\s+${wd}(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}(?:,?\\s+(\\d{4}))?`, 'i');
  if ((m = t.match(re2))) {
    const d = resolveYMD(MONTHS[m[2].slice(0, 3).toLowerCase()], Number(m[1]), m[3], ref);
    if (d) return { date: iso(d), text: m[0].trim() };
  }
  // "expires on 10/14/2026", "by 10/14"
  const re3 = new RegExp(`${lead}\\s+${wd}(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?${timeTail}`, 'i');
  if ((m = t.match(re3))) {
    const d = resolveYMD(Number(m[1]) - 1, Number(m[2]), m[3], ref);
    if (d) return fin(d, [null, ...m.slice(4)], m[0]);
  }
  // ISO date after a lead word
  const re4 = new RegExp(`${lead}\\s+(\\d{4})-(\\d{2})-(\\d{2})`, 'i');
  if ((m = t.match(re4))) return { date: `${m[1]}-${m[2]}-${m[3]}`, text: m[0] };
  return null;
}

/** Sender parts: {name, addr, local, domain}. */
function parseFrom(from) {
  const s = String(from || '');
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const addr = (m ? m[2] : s).trim().toLowerCase();
  const name = (m ? m[1] : '').trim();
  const [local, domain = ''] = addr.split('@');
  return { name, addr, local, domain };
}

/**
 * classify({from, subject, snippet, body|bodyExcerpt, date}) -> {kind, confidence, deadline?, deadlineText?, deadlineTime?, reason}
 * kind: rejection | oa | interview | received | recruiter | other | noise (job alerts / digests; ignored by plan)
 */
function classify(email) {
  const e = email || {};
  const subject = String(e.subject || '');
  const body = String(e.body || e.bodyExcerpt || e.snippet || '');
  const all = `${subject}\n${e.snippet || ''}\n${body}`;
  const f = parseFrom(e.from);
  const ref = emailDate(e);
  const done = (kind, confidence, reason, withDeadline, eventToo) => {
    const r = { kind, confidence, reason };
    if (withDeadline) {
      const d = extractDeadline(all, ref, eventToo);
      if (d) {
        r.deadline = d.date;
        r.deadlineText = d.text;
        if (d.time) r.deadlineTime = d.time;
      }
    }
    return r;
  };

  if (/@linkedin\.com$/.test(f.addr) && LINKEDIN_APPLIED.test(subject) && !REJECT.test(all)) return done('received', 0.8, 'linkedin application confirmation');
  if (NOISE_FROM.test(f.addr) || NOISE_SUBJECT.test(subject)) {
    // A real recruiter message never comes from a digest address; but an ATS-flagged rejection might say "digest"; keep strict.
    return done('noise', 0.9, 'job alert / digest / newsletter');
  }
  if (REJECT.test(all)) return done('rejection', 0.9, 'rejection phrasing');
  const vendor = OA_VENDOR.test(all) || OA_VENDOR.test(f.domain);
  const oaPhrase = OA_PHRASE.test(all);
  const received = RECEIVED.test(all);
  const strongIv = INTERVIEW_STRONG.test(all);
  // A confirmation that merely mentions a possible later assessment/interview stays a confirmation.
  if (vendor || (oaPhrase && !received)) return done('oa', vendor && oaPhrase ? 0.95 : 0.85, vendor ? 'assessment vendor' : 'assessment phrasing', true);
  if (strongIv && !(received && !/calendly|goodtime|schedule (a|your|an|the)|invite you|like to|select a|book a|pick a|confirmed for/i.test(subject))) {
    return done('interview', 0.9, 'scheduling phrasing', true, true);
  }
  if (received) return done('received', 0.85, 'confirmation phrasing');
  if (oaPhrase) return done('oa', 0.6, 'assessment mentioned', true);
  if (INTERVIEW_WEAK.test(all)) return done('interview', 0.5, 'interview mentioned', true, true);
  if (RECRUITER.test(all)) return done('recruiter', 0.5, 'recruiter phrasing');
  return done('other', 0.3, 'no rule matched');
}

/* ---------- company matching ---------- */

const ATS_DOMAIN = /(^|\.)(greenhouse\.io|greenhouse-mail\.io|myworkday\.com|workday\.com|myworkdayjobs\.com|ashbyhq\.com|lever\.co|icims\.com|smartrecruiters\.com|jobvite\.com|taleo\.net|oraclecloud\.com|successfactors\.(com|eu)|brassring\.com|hackerrank\.com|codesignal\.com|codility\.com|hirevue\.com|goodtime\.io|calendly\.com|workable\.com|breezy\.hr|rippling\.com|gem\.com|linkedin\.com|joinhandshake\.com)$/i;
const GENERIC_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|notifications?|jobs|careers|recruiting|talent|hr|team|info|hello|mailer|support|apply|applications?)$/i;
const SUFFIX = /\b(inc|llc|ltd|corp|corporation|co|company|technologies|technology|group|holdings|labs?|systems|solutions|software|the)\b/g;
// Short forms people (and mail systems) use. Keys and values are normalised names.
const ALIASES = {
  bofa: 'bank of america', bankofamerica: 'bank of america', lindenwick: 'lindenwick', umbermoor: 'umbermoor',
  jpmc: 'jpmorgan chase', jpmorgan: 'jpmorgan chase', 'jp morgan': 'jpmorgan chase', capone: 'capital one', 'capital one': 'capital one',
  dd: 'glenfield', 'palo alto': 'palo alto networks', pan: 'palo alto networks', copperfield: 'umberfield', ge: 'general electric',
};
const WEAK_FIRST = new Set(['bank', 'american', 'united', 'first', 'general', 'national', 'global', 'new', 'north', 'south', 'the', 'data', 'cloud', 'digital', 'federal', 'health']);

function norm(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
}
function compact(s) {
  return norm(s).replace(/ /g, '');
}
/** All names a row's company may appear under, normalised and ordered strongest first. */
function aliasesFor(company) {
  const n = norm(company);
  const out = new Set([n]);
  const words = n.split(' ').filter(Boolean);
  if (words.length > 1 && words[0].length >= 5 && !WEAK_FIRST.has(words[0])) out.add(words[0]);
  for (const [k, v] of Object.entries(ALIASES)) if (norm(v) === n || norm(k) === n) { out.add(norm(k)); out.add(norm(v)); }
  return [...out].filter((x) => x.length >= 2);
}
function hasWord(hay, needle) {
  if (!needle) return false;
  return new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(hay);
}

/** Row accessors: tolerate {id, version, data:{...}} (ArtifactData docs) and flat rows. */
function rowFields(row) {
  return (row && (row.data || row.fields || row.doc)) || row || {};
}
function rowId(row) {
  return row && (row.doc_id ?? row.id ?? row._id ?? rowFields(row).id ?? null);
}
function rowVersion(row) {
  const v = row && (row.version ?? row.if_version ?? row._version ?? rowFields(row)._version);
  return v === undefined ? null : v;
}

function scoreRow(email, row) {
  const f = parseFrom(email.from);
  const fields = rowFields(row);
  const names = aliasesFor(fields.company);
  if (!names.length || !norm(fields.company)) return { score: 0, reason: '' };
  const ats = ATS_DOMAIN.test(f.domain);
  const nameN = norm(f.name.replace(/\bvia\b.*$/i, ''));
  const subjN = norm(email.subject);
  const bodyN = norm(`${email.snippet || ''} ${email.body || email.bodyExcerpt || ''}`);
  const domLabels = f.domain.split('.').slice(0, -1).filter((l) => !/^(mail|email|e|us|eu|notifications?|recruiting|careers|jobs|talent|hire|mg|em|reply)$/.test(l));
  let best = 0;
  let reason = '';
  const bump = (n, why) => { if (n > best) { best = n; reason = why; } };
  for (const a of names) {
    const c = a.replace(/ /g, '');
    const isFull = a === names[0];
    const w = isFull ? 1 : 0.9; // alias/short-form hits count a bit less
    if (!ats && domLabels.some((l) => l === c || (c.length >= 5 && l === c.slice(0, l.length) && l.length >= 5))) bump(5 * w, 'sender domain');
    if (ats && GENERIC_LOCAL.test(f.local) === false && compact(f.local) === c) bump(5 * w, 'ATS tenant sender');
    if (hasWord(nameN, a)) bump(4 * w, 'sender name');
    if (hasWord(subjN, a)) bump(3 * w, 'subject');
    if (ats || !domLabels.length) { if (hasWord(bodyN, a)) bump(1.5 * w, 'body (ATS sender)'); }
    else if (hasWord(bodyN, a)) bump(1 * w, 'body');
  }
  return { score: best, reason };
}

function roleOverlap(email, row) {
  const role = norm(rowFields(row).role).split(' ').filter((w) => w.length > 2 && !['intern', 'internship', 'summer', 'fall', 'the', 'and'].includes(w));
  if (!role.length) return 0;
  const hay = norm(`${email.subject} ${email.snippet || ''} ${email.body || email.bodyExcerpt || ''}`);
  return role.filter((w) => hasWord(hay, w)).length / role.length;
}

/** Best row with its evidence: {row, score, reason} or null. Ambiguity (different companies close, same company no role tiebreak) -> null. */
function matchDetail(email, rows) {
  const scored = (rows || []).map((row) => ({ row, ...scoreRow(email, row) })).filter((s) => s.score >= 2.5).sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const top = scored[0];
  const sameCo = (s) => norm(rowFields(s.row).company) === norm(rowFields(top.row).company);
  const other = scored.find((s) => !sameCo(s));
  if (other && other.score >= top.score - 0.5) return null; // two companies fit about equally: don't guess
  const cands = scored.filter((s) => sameCo(s) && s.score >= top.score - 0.5);
  if (cands.length === 1) return top;
  const ranked = cands.map((c) => ({ ...c, ro: roleOverlap(email, c.row) })).sort((a, b) => b.ro - a.ro);
  if (ranked[0].ro > 0 && ranked[0].ro > ranked[1].ro) return ranked[0];
  return null; // several roles at the same company and the email names none: the owner picks
}
function matchCompany(email, rows) {
  const m = matchDetail(email, rows);
  return m ? m.row : null;
}

/* ---------- planning ---------- */

function normStatus(s) {
  const t = String(s || '').toLowerCase();
  if (/reject|declin|denied|closed|withdr/.test(t)) return 'rejected';
  if (/offer/.test(t)) return 'offer';
  if (/interview|onsite|on-site|screen/.test(t)) return 'interviewing';
  if (/assess|\boa\b|challenge|coding/.test(t)) return 'assessment';
  if (/appl|submit|receiv/.test(t)) return 'applied';
  return null;
}
const rankOf = (s) => RANK[s] || 0;

function atsName(email) {
  const d = parseFrom(email.from).domain;
  const hit = (d.match(/greenhouse|workday|ashbyhq|lever|icims|smartrecruiters|jobvite|taleo|oraclecloud|successfactors|hackerrank|codesignal|codility|hirevue|goodtime|calendly|linkedin|handshake/i) || [])[0];
  return hit ? hit.toLowerCase() : '';
}
function noteFor(email, c, today) {
  const tag = '#' + String(email.id || '').slice(-8);
  const bits = [KIND_LABEL[c.kind]];
  const via = atsName(email) || (c.reason === 'assessment vendor' ? '' : '');
  if (via) bits[0] += ` (${via})`;
  if (c.deadline) bits.push(`${c.kind === 'interview' ? 'on' : 'due'} ${c.deadline}${c.deadlineTime ? ' ' + c.deadlineTime : ''}`);
  const subj = String(email.subject || '').replace(/\s+/g, ' ').slice(0, 70);
  return `[inbox ${today}] ${bits.join(', ')}: ${subj} ${tag}`.trim();
}

/**
 * plan(emails, rows, {today}) -> [{rowId, version, company, set:{status?, notes, followUp?}, emails:[{id, kind, ...}]}]
 * One update per row, folding every email for it (oldest first). Never lowers a status. Re-running over
 * emails already noted (their #tag is in the notes) produces nothing, so /inbox is idempotent.
 */
function planAll(emails, rows, opts) {
  const today = (opts && opts.today) || iso(new Date());
  const items = (emails || []).map((e) => ({ email: e, c: classify(e) }));
  const counts = {};
  const unmatched = [];
  const byRow = new Map();
  for (const it of items) {
    counts[it.c.kind] = (counts[it.c.kind] || 0) + 1;
    if (it.c.kind === 'noise') continue;
    const m = matchDetail(it.email, rows);
    if (!m) {
      if (it.c.kind !== 'other' || it.c.confidence > 0) unmatched.push({ id: it.email.id, kind: it.c.kind, from: it.email.from, subject: it.email.subject, date: it.email.date, deadline: it.c.deadline || null });
      continue;
    }
    const key = String(rowId(m.row));
    if (!byRow.has(key)) byRow.set(key, { row: m.row, list: [] });
    byRow.get(key).list.push(it);
  }

  const updates = [];
  for (const { row, list } of byRow.values()) {
    const fields = rowFields(row);
    let status = normStatus(fields.status);
    const startStatus = fields.status || '';
    let notes = String(fields.notes || '');
    let followUp = fields.followUp == null ? '' : String(fields.followUp);
    const set = {};
    const used = [];
    list.sort((a, b) => emailDate(a.email) - emailDate(b.email));
    for (const { email, c } of list) {
      if (c.kind === 'other' && c.confidence < 0.5) continue; // too weak to write on a row
      const tag = '#' + String(email.id || '').slice(-8);
      if (email.id && notes.includes(tag)) continue; // already recorded on an earlier run
      const target = KIND_STATUS[c.kind];
      let note = noteFor(email, c, today);
      if (target === 'rejected') {
        if (status !== 'offer') status = 'rejected';
        if (followUp) followUp = '';
      } else if (target && status === 'rejected') {
        note += ' [after a rejection: other role? status left as rejected]';
      } else if (target && rankOf(target) > rankOf(status)) {
        status = target;
      }
      if ((c.kind === 'oa' || c.kind === 'interview') && c.deadline && status !== 'rejected') {
        if (!followUp || followUp > c.deadline || followUp < today) followUp = c.deadline;
      }
      notes = notes ? `${notes} | ${note}` : note;
      used.push({ id: email.id, kind: c.kind, deadline: c.deadline || null });
    }
    if (!used.length) continue;
    set.notes = notes;
    if (status && status !== normStatus(startStatus) && status !== startStatus) set.status = status;
    if (followUp !== (fields.followUp == null ? '' : String(fields.followUp))) set.followUp = followUp;
    set.updated = today;
    updates.push({ rowId: rowId(row), version: rowVersion(row), company: fields.company || '', set, emails: used });
  }
  const deadlines = [];
  for (const it of items) {
    if (!it.c.deadline || it.c.kind === 'noise' || it.c.kind === 'rejection') continue;
    const m = matchDetail(it.email, rows);
    deadlines.push({ date: it.c.deadline, time: it.c.deadlineTime || null, kind: it.c.kind, company: m ? rowFields(m.row).company : null, from: it.email.from, subject: it.email.subject, text: it.c.deadlineText });
  }
  deadlines.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  return { updates, unmatched, counts, deadlines };
}
function plan(emails, rows, opts) {
  return planAll(emails, rows, opts).updates;
}

/* ---------- Gmail query + state ---------- */

const ATS_SENDERS = ['greenhouse.io', 'greenhouse-mail.io', 'myworkday.com', 'myworkdayjobs.com', 'ashbyhq.com', 'lever.co', 'icims.com', 'smartrecruiters.com', 'jobvite.com', 'taleo.net', 'hackerrank.com', 'codesignal.com', 'codility.com', 'hirevue.com', 'goodtime.io', 'calendly.com'];
const KEYWORDS = ['"your application"', '"thank you for applying"', '"thanks for applying"', 'assessment', 'interview', '"next steps"', '"coding challenge"', '"not moving forward"', 'unfortunately', '"other candidates"', '"your candidacy"'];
const EXCLUDE_FROM = ['jobalerts-noreply@linkedin.com', 'jobs-listings@linkedin.com', 'jobs-noreply@linkedin.com', 'invitations@linkedin.com', 'messages-noreply@linkedin.com', 'joinhandshake.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com'];

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}
function writeState(now) {
  const state = { lastCheck: (now || new Date()).toISOString() };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  return state;
}
function sinceDate(state, now) {
  const n = now || new Date();
  const last = state && state.lastCheck ? new Date(state.lastCheck) : null;
  if (last && !Number.isNaN(last.getTime()) && last <= n) return last;
  return new Date(n.getTime() - DEFAULT_DAYS * 86400000);
}
function buildQuery(state, now) {
  const d = sinceDate(state, now);
  const p = (x) => String(x).padStart(2, '0');
  const after = `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
  return [
    `after:${after}`,
    `(from:(${ATS_SENDERS.join(' OR ')}) OR ${KEYWORDS.join(' OR ')})`,
    '-category:promotions -category:social -category:forums',
    `-from:(${EXCLUDE_FROM.join(' OR ')})`,
    '-subject:("job alert" OR "jobs for you" OR newsletter OR digest OR "new jobs")',
  ].join(' ');
}

/** Tolerant loader for tracker rows: a JSON file, or a directory of JSON files (ArtifactData out_dir). */
function loadRows(src) {
  const files = fs.statSync(src).isDirectory() ? fs.readdirSync(src).filter((f) => f.endsWith('.json')).map((f) => path.join(src, f)) : [src];
  const rows = [];
  const take = (x, file) => {
    if (Array.isArray(x)) return x.forEach((y) => take(y));
    if (!x || typeof x !== 'object') return;
    for (const k of ['docs', 'documents', 'rows', 'results', 'items']) if (Array.isArray(x[k])) return take(x[k]);
    if (!rowFields(x).company) return;
    // ArtifactData out_dir writes each document as its plain fields in <doc_id>.json: the id is the file
    // name (2026-10-08: without it every row had id null and all emails were merged into one update).
    if (rowId(x) == null && file) x = { ...x, doc_id: path.basename(file, '.json') };
    rows.push(x);
  };
  for (const f of files) take(JSON.parse(fs.readFileSync(f, 'utf8')), files.length > 1 || fs.statSync(src).isDirectory() ? f : null);
  return rows;
}

module.exports = { classify, extractDeadline, parseFrom, matchCompany, matchDetail, plan, planAll, buildQuery, sinceDate, readState, writeState, loadRows, normStatus, rowFields, rowId, rowVersion, aliasesFor, STATE_FILE, RANK, DEFAULT_DAYS };
