'use strict';
/*
 * The application driver: a loop that looks at the page, decides what kind of
 * page it is, does the one obvious thing, and repeats until the application is
 * submitted or something needs a decision it cannot make.
 *
 *   landing  -> press Apply (or the ATS's equivalent)
 *   auth     -> sign in / create the account (per-site password from the keyring)
 *   form     -> upload resume, run Formhand's fill pass, then Next / Submit
 *   done     -> confirmation page seen: log it
 *
 * It stops with status `needs_input` (required questions it has no answer for,
 * validation errors, a verification email...), `blocked` (captcha, stuck page)
 * or `ready_to_submit` (--no-submit, or policy.autoSubmit off). Every stop
 * returns a report the /apply skill (Claude) can act on, then `jobctl continue`.
 */
const fs = require('node:fs');
const path = require('node:path');
const C = require('./client');
const D = require('./data');
const S = require('./secrets');
const R = require('./runs');
const U = require('./urls');
const { ROOT } = require('./paths');
const { STATES } = require('./history');

const MAX_STEPS = 40;
// Waits that tests shorten.
const TUNE = { createWaitMs: 10000, afterSubmitWaitMs: 12000, unknownWaitMs: 3500, unknownWaitWorkdayMs: 10000, navWaitMs: 15000 };
// A tab whose frames changed under a snapshot (iCIMS iframe navigation): re-snapshot, never crash the run.
const FRAME_GONE = /invalid frame ids|frame \d+ is gone|no frame with id/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (frameId, ref) => `${frameId}:${ref}`;

function splitRef(ref) {
  const m = /^(\d+):(.+)$/.exec(String(ref));
  if (!m) throw new Error(`bad ref "${ref}" (expected <frame>:<ref>, e.g. 0:12)`);
  return { frameId: Number(m[1]), ref: m[2] };
}

/* ------------------------------------------------------------------ */
/* Looking at the page                                                  */
/* ------------------------------------------------------------------ */

/** Password inputs come back with their live value; mask it so no snap, run file or report ever holds one. */
function redactSecrets(fields) {
  return (fields || []).map((f) => (f && (f.kind === 'password' || /password/i.test(f.type || '')) && f.value ? { ...f, value: '<redacted>' } : f));
}

async function snapshot(tabId, opts) {
  const res = await C.page(tabId, 'snapshot', opts || {});
  const frames = res.filter((r) => r.result && !r.error).map((r) => ({ frameId: r.frameId, ...r.result, fields: redactSecrets(r.result.fields) }));
  const top = frames.find((f) => f.top) || frames[0] || { fields: [], buttons: [], signals: {} };
  // Refs belong to this tab (lib/focus.js); their labels name the field in hand-fix hiccups.
  const labels = {};
  for (const f of frames) {
    for (const x of f.fields || []) if (x.ref != null) labels[q(f.frameId, x.ref)] = String(x.label || '').slice(0, 120);
    for (const b of f.buttons || []) if (b.ref != null) labels[q(f.frameId, b.ref)] = String(b.text || '').slice(0, 80);
  }
  require('./focus').recordSnap(tabId, top.url, labels);
  const all = (k) => frames.flatMap((f) => (f[k] || []).map((x) => ({ ...x, ref: q(f.frameId, x.ref), frame: f.frameId })));
  const sig = (k) => frames.some((f) => f.signals && f.signals[k]);
  const fields = all('fields');
  return {
    url: top.url,
    title: top.title,
    heading: top.heading,
    adapter: (frames.find((f) => f.fields && f.fields.length > 1) || top).adapter,
    frames,
    fields,
    buttons: all('buttons'),
    signals: {
      confirmation: sig('confirmation'),
      alreadyApplied: sig('alreadyApplied'),
      closed: sig('closed'),
      verifyEmail: sig('verifyEmail'),
      captcha: frames.flatMap((f) => (f.signals && f.signals.captcha) || []),
      passwordFields: frames.reduce((n, f) => n + ((f.signals && f.signals.passwordFields) || 0), 0),
      errors: frames.flatMap((f) => (f.signals && f.signals.errors) || []),
      embeddedForms: frames.flatMap((f) => (f.signals && f.signals.embeddedForms) || []),
      securityCode: sig('securityCode'),
      uploading: sig('uploading'),
      workdayPage: (frames.find((f) => f.signals && f.signals.workdayPage) || { signals: {} }).signals.workdayPage || null,
      // document.visibilityState / hasFocus() of the top frame: a step that stalled in a hidden or unfocused tab
      // (timers throttled, rendering paused) shows up in the per-step timing log.
      visibility: (top.signals && top.signals.visibility) || null,
      focus: top.signals && top.signals.focus != null ? top.signals.focus : null,
    },
    text: opts && opts.text ? frames.map((f) => f.text || '').join('\n\n') : undefined,
  };
}

/** A fingerprint of what the page shows, to tell whether a click changed anything. */
function signature(snap) {
  return [snap.url, snap.heading, snap.fields.map((f) => f.label).join('|'), snap.buttons.map((b) => b.text).join('|'), snap.signals.confirmation].join('#');
}

// Form fields that count toward "this is an application form": not search boxes,
// not a lone newsletter email box, not the cookie banner's switches.
function formFields(snap) {
  // (range: video players' seek / volume sliders made a careers landing page look like a form.)
  return snap.fields.filter((f) => f.kind !== 'range' && !/search|keyword|newsletter|subscribe|cookie|filter/i.test(f.label));
}

/** A sign-up whose page is really the full application profile (name, phone, address... beyond the login boxes). */
function isCombinedSignupForm(snap) {
  const other = formFields(snap).filter((f) => f.kind !== 'password' && f.kind !== 'file' && f.kind !== 'checkbox' && !/login|e-?mail|user ?name|password/i.test(f.label));
  return other.length >= 4 && !snap.buttons.some((b) => /^(create (an )?account|register|sign ?up)$/i.test(b.text));
}

/** Every emailed-code box on the page holds a character (Greenhouse's 8 boxes). */
function codeTyped(snap) {
  const boxes = formFields(snap).filter((f) => /security code|verification code/i.test(f.label));
  return boxes.length > 0 && boxes.every((f) => f.value);
}

function classify(snap) {
  const s = snap.signals;
  const ff = formFields(snap);
  // iCIMS lands on `.../job?mode=submit_apply` after the last step (Cedarhall 2026-10-09).
  const doneUrl = /\/(confirmation|thanks|thank-?you|application-?submitted)(\/|\?|$)|[?&]mode=submit_apply\b|[?&]step=confirmation\b/i.test(snap.url || '');
  // A confirmation page can keep a stale required box from the step before (an iCIMS certify checkbox): only empty
  // required fields that are not tick boxes keep it from counting as done.
  const openRequired = ff.filter((f) => f.required && !f.value && !/^checkbox(es)?$/.test(f.kind || ''));
  // Workday's footer Next / Save and Continue still on the page means the application is not finished, whatever the
  // text says (Allison 2026-10-09: the WOTC step reads "Thank you for your application." and was taken as done).
  const wdFooterNext = snap.buttons.some((b) => b.aid === 'pageFooterNextButton' && !b.disabled);
  if (((s.confirmation && !wdFooterNext) || doneUrl) && openRequired.length === 0) return 'done';
  if (s.securityCode) return 'security_code';
  if (s.alreadyApplied) return 'already';
  if (s.captcha.some((c) => /challenge|interstitial/.test(c))) return 'captcha';
  if (s.closed && ff.length < 2) return 'closed';
  if (s.passwordFields > 0) return 'auth';
  if (s.verifyEmail && ff.length <= 2) return 'verify';
  // iCIMS / Oracle: an email box and a Next button before anything else.
  if (ff.length === 1 && /e-?mail/i.test(ff[0].label + ' ' + ff[0].kind) && snap.buttons.some((b) => NEXT.test(b.text) || /^(submit|go|start)$/i.test(b.text))) return 'email_gate';
  if (ff.length >= 2 || ff.some((f) => f.kind === 'file')) return 'form';
  // A Workday step with one question (DRIFTRIDGE 2026-10-09: "Are you a U.S. Citizen?") plus its footer Next is a form too.
  if (ff.length === 1 && wdFooterNext) return 'form';
  // Workday's last step (Review) has no fields, only the footer Submit (Coppermoor / Elmbrook, 2026-10-09):
  // a form page, so stepForm presses Submit through the usual dry / autoSubmit gates.
  if (snap.buttons.some((b) => b.aid === 'pageFooterNextButton' && SUBMIT.test(b.text))) return 'form';
  if (findApply(snap)) return 'landing';
  // Workday sign-in chooser (AmFam, 2026-10-09): Google / LinkedIn / "Sign in with email" buttons before the
  // email + password boxes that lead on to Create Account.
  if (emailSignInButton(snap)) return 'auth_chooser';
  return 'unknown';
}

/* ------------------------------------------------------------------ */
/* Buttons                                                              */
/* ------------------------------------------------------------------ */

const APPLY = /^(apply( now| here| today| online)?|i want to apply|i'?d like to apply|apply (for|to) (this )?(job|position|role|opening|internship)|apply on company (site|website)|start (your |my )?application|begin application|i'?m interested|apply manually|autofill with resume|use my last application|application)$/i;
const APPLY_BAD = /linkedin|indeed|seek|glassdoor|with google|with facebook|refer|share|save|alert|similar|sign ?up for/i;
const NEXT = /^(next|continue|save (and|&) continue|save (and|&) next|next step|review( (and|&) submit| application)?|proceed|continue to (the )?next (step|page)|go to next step|create profile|update profile)$/i;
// Accessibility skip links and menu toggles are <button type=submit> on some sites (Driftmere's iCIMS page):
// never a form's submit.
// "Finish Later" / "Save for later" / "Save draft" park the application: never Next or Submit (Driftmere iCIMS,
// 2026-10-09: the bare-submit fallback pressed "Finish Later" twice instead of "Update Profile").
// A row's Delete / Remove (Workday My Experience: type=submit buttons) is never the way forward (DUNVALE 2026-10-09: taken as
// the Submit while the footer re-rendered).
const NOT_NAV = /^(skip to|toggle|show more|back to)\b|^(delete|remove|discard|withdraw|clear|reset|cancel)\b|main content|navigation|captcha|^(finish|save( (it|this))?|continue|complete|apply) (for )?later\b|^save (as )?(a )?draft\b|^save (and|&) (exit|close|quit)\b/i;
const SUBMIT = /^(submit( (my |your )?application)?|send( (my )?application)?|apply|complete( (my )?application)?|finish|submit and finish|confirm (and|&) submit)$/i;
const SIGNIN = /^(sign ?in|log ?in|continue|next|submit)$/i;
const SIGNUP = /^(create (an |my )?account|sign ?up|register|create)$/i;
const TO_SIGNUP = /(create (an |my )?account|sign ?up|register|new user|don'?t have an account)/i;

function findApply(snap, opts) {
  const btns = snap.buttons.filter((b) => !APPLY_BAD.test(b.text));
  // Workday: the job page's Apply, then the "how do you want to apply" modal. "Use My Last
  // Application" needs an account on this tenant; without one, autofill from the resume.
  const wd = (aid) => btns.find((b) => b.aid === aid);
  const hasAccount = !!(opts && opts.hasAccount);
  return (
    (hasAccount && (wd('useMyLastApplication') || btns.find((b) => /^use my last application$/i.test(b.text)))) ||
    wd('autofillWithResume') ||
    btns.find((b) => /^autofill with resume$/i.test(b.text)) ||
    wd('applyManually') ||
    wd('adventureButton') ||
    btns.find((b) => APPLY.test(b.text) && !b.chrome) ||
    btns.find((b) => APPLY.test(b.text)) ||
    btns.find((b) => /^apply\b/i.test(b.text) && b.text.length < 40) ||
    // Company-built sites word it their own way; a link to <posting>/apply is the apply step.
    btns.find((b) => b.href && /\/apply\/?(\?|#|$)/i.test(b.href) && !b.chrome && b.text.length < 40)
  );
}

function findNav(snap) {
  // Workday's footer Back is a submit-type button: never a way forward (AmFam / Driftgate, 2026-10-09).
  // A disabled button (Rippling's Apply until every required answer is in) is never pressed.
  const btns = snap.buttons.filter((b) => !b.disabled && !b.chrome && !NOT_NAV.test(b.text) && !/^(back|previous|prev)$/i.test((b.text || '').trim()) && !/BackButton$/i.test(b.aid || ''));
  // Workday's footer Next / Save and Continue sits in the page's button bar, which the snapshot may mark as chrome
  // (UMBERMOOR 2026-10-09: listed, yet "no Next button"): its automation id is enough, chrome or not.
  const byAid = (re) => btns.find((b) => b.aid && re.test(b.aid)) || snap.buttons.find((b) => !b.disabled && b.aid && re.test(b.aid) && !/BackButton$/i.test(b.aid));
  const wdNext = byAid(/^(pageFooterNextButton|bottom-navigation-next-button)$/);
  if (wdNext) return { kind: /submit/i.test(wdNext.text) ? 'submit' : 'next', btn: wdNext };
  const next = btns.filter((b) => NEXT.test(b.text)).pop();
  if (next) return { kind: /submit/i.test(next.text) ? 'submit' : 'next', btn: next };
  const submit = btns.filter((b) => SUBMIT.test(b.text)).pop() || btns.find((b) => b.submit && !/search|sign|log/i.test(b.text));
  if (submit) return { kind: 'submit', btn: submit };
  return null;
}

/* ------------------------------------------------------------------ */
/* Actions                                                              */
/* ------------------------------------------------------------------ */

async function call(tabId, frameId, fn, args, timeout) {
  const [r] = await C.page(tabId, fn, args, [frameId], timeout);
  if (!r) throw new Error(`frame ${frameId} is gone`);
  if (r.error) throw new Error(r.error);
  return r.result;
}

// A click that opens a new tab (an Apply link, window.open) shows the tab in the spawn log within ~300 ms. The
// old fixed 1.2 s sleep after EVERY click only existed to catch that. Now: look at once, then every 150 ms for at
// most 600 ms, and stop looking as soon as the tab itself navigated (then no new tab is coming). Callers that
// never open tabs (Next / Submit, deletes, sign-in boxes) pass { tab: false } and do not look at all.
const SPAWN_POLL = 150;
const SPAWN_MAX = 600;

/** A tab the page opened since `since` (an Apply link): switch to it. False when there is none; true once one was found (it is kept only if it loaded). */
async function followSpawned(run, since) {
  const fresh = await C.send('spawned', { opener: run.tabId, since }).catch(() => []);
  if (!fresh.length) return false;
  const opener = run.tabId;
  run.tabId = fresh[fresh.length - 1];
  try {
    await C.send('activate', { tabId: run.tabId });
    await C.send('waitLoad', { tabId: run.tabId, timeout: 30000 });
  } catch (e) {
    // The new tab closed while loading (waitLoad rejects at once now): stay on the page that opened it.
    run.tabId = opener;
  }
  return true;
}

async function click(run, ref, opts) {
  const { frameId, ref: r } = splitRef(ref);
  const before = Date.now();
  const watch = !(opts && opts.tab === false);
  const first = watch ? await C.send('tab', { tabId: run.tabId }).catch(() => null) : null;
  const res = await call(run.tabId, frameId, 'click', { ref: r, autoConsent: D.profile().policy.autoConsent });
  if (res && res.navigate) {
    await C.send('goto', { tabId: run.tabId, url: res.navigate });
    return res;
  }
  if (!watch) return res;
  const max = (opts && opts.tabWait) || SPAWN_MAX; // an Apply button gets longer: a tab that opens late must not be missed
  for (let waited = 0; ; waited += SPAWN_POLL) {
    if (await followSpawned(run, before)) break;
    if (waited >= max) break;
    const now = await C.send('tab', { tabId: run.tabId }).catch(() => null);
    if (first && now && (now.url !== first.url || now.status === 'loading')) break; // the page moved on by itself
    await sleep(SPAWN_POLL);
  }
  return res;
}

/** Wait for the tab to finish loading, then for the DOM to be quiet (`quiet` ms, at most `max`). */
async function settle(tabId, o) {
  try {
    await C.send('waitLoad', { tabId, timeout: 30000 });
    if (o && o.quiet === 0) return;
    await C.page(tabId, 'waitQuiet', { quiet: (o && o.quiet) || 800, max: (o && o.max) || 6000 }, [0], 15000);
  } catch (e) {
    await sleep(1500);
  }
}

// Runs whose last waitChange returned a page that held still across two looks: the loop skips its settle for them.
const STABLE = new WeakMap();
const POLL_MS = 250;

/**
 * Wait until the page differs from `before` (or `ms` passes). Polls every 250 ms (was a fixed 900 ms first look)
 * and returns the changed page once two looks in a row agree on it, so the loop does not need a settle of its own.
 */
async function waitChange(run, before, ms) {
  const end = Date.now() + (ms || 20000);
  let snap = null;
  let prev = null;
  while (Date.now() < end) {
    await sleep(POLL_MS);
    try {
      snap = await snapshot(run.tabId);
      const sg = signature(snap);
      if (sg !== before) {
        if (sg === prev) {
          STABLE.set(run, Date.now());
          return snap;
        }
        prev = sg;
      } else prev = null;
    } catch (e) {
      /* navigating: frames come and go */
      prev = null;
    }
  }
  return snap;
}

/** Poll `look(snap)` every 250 ms until it returns something truthy (that value) or `ms` passes (null). */
async function pollPage(run, look, ms) {
  const end = Date.now() + (ms || 5000);
  while (true) {
    try {
      const v = look(await snapshot(run.tabId));
      if (v) return v;
    } catch (e) {
      /* navigating */
    }
    if (Date.now() >= end) return null;
    await sleep(POLL_MS);
  }
}

function fileInfo(file) {
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
  const ext = path.extname(abs).toLowerCase();
  const mime = ext === '.pdf' ? 'application/pdf' : ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : ext === '.doc' ? 'application/msword' : 'text/plain';
  return { abs, name: path.basename(abs), mime };
}

async function upload(run, frameId, which, file, ref) {
  const f = fileInfo(file);
  if (!fs.existsSync(f.abs)) throw new Error(`${which} file not found: ${f.abs}`);
  const b64 = fs.readFileSync(f.abs).toString('base64');
  return call(run.tabId, frameId, 'upload', { which, name: f.name, mime: f.mime, b64, ref }, 60000);
}

function today(kind) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  if (kind === 'date') return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (kind === 'dmy') return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
}

/*
 * Home-address facts (State, Country, ZIP, County) only go in the applicant's own address block:
 * never an employer's, school's, reference's or relative's (same rule as Address Line 1).
 */
const NOT_HOME = /employ|experience|work|company|school|education|emergency|reference|relative|guardian|parent|spouse|beneficiar|contact person|next of kin|\bposition\b|supervisor|manager|volunteer|\bprevious\b|\bprior\b|\bjob (title|history|location)/i;
const CHOICE = /select|combobox|radio|buttons|checkboxes/;
const normOpt = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Drop "US" / "United States" decoration from a normalized option ("us va", "virginia united states" -> "va", "virginia"). */
const stripUs = (t) => t.replace(/\b(?:united states(?: of america)?|u s a|usa|u s|us)\b/g, ' ').replace(/\s+/g, ' ').trim();
/** Dial codes in a normalized option ("united states of america 1") are not part of the name. */
const stripDigits = (t) => t.replace(/\b\d{1,3}\b/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The profile state as an exact option, or as text. Options come in many dresses: "VA", "Virginia", "VA - Virginia",
 * "Virginia (VA)", "Virginia - VA", "US-VA", "Virginia, United States". Compared as the code and / or the full name
 * once whitespace, punctuation, case and a "US" / "United States" decoration are gone.
 */
function stateAnswer(n, state) {
  const raw = String(state || '').trim();
  const code = STATES[raw.toUpperCase()] ? raw.toUpperCase() : Object.keys(STATES).find((k) => STATES[k].toLowerCase() === raw.toLowerCase());
  if (!code) return null; // not a U.S. state we can name both ways: ask
  const full = STATES[code];
  const opts = n.options || [];
  if (opts.length) {
    const c = normOpt(code);
    const f = normOpt(full);
    const ok = new Set([f, c, `${c} ${f}`, `${f} ${c}`]);
    return opts.find((o) => ok.has(stripUs(normOpt(o)))) || null;
  }
  if (CHOICE.test(n.kind || '')) return null; // a list we could not read: a fuzzy pick could land on the wrong state
  const abbr = /abbrev|2[- ]?letter|two[- ]letter|\bcode\b/i.test(`${n.label || ''} ${n.placeholder || ''}`) || /^(e\.?g\.?,?\s*)?[A-Z]{2}$/.test(String(n.placeholder || '').trim()) || Number(n.maxLength) === 2;
  return abbr ? code : full;
}

const US_NAME = '(?:united states(?: of america)?|u s a|u s|usa|us)';
const US = new RegExp(`^${US_NAME}(?: ${US_NAME})?$`);
/** An option naming the United States however it is decorated: "United States of America (+1)", "US - United States", "United States (US)". */
const isUsOption = (o) => US.test(stripDigits(normOpt(o)));

/** The profile country as an exact option ("United States of America", "USA", "United States of America (+1)", ...), or as text. */
function countryAnswer(n, country) {
  const want = normOpt(country);
  if (!want) return null;
  const opts = n.options || [];
  if (opts.length) {
    const exact = opts.find((o) => normOpt(o) === want) || opts.find((o) => stripDigits(normOpt(o)) === stripDigits(want));
    if (exact) return exact;
    return US.test(stripDigits(want)) ? opts.find(isUsOption) || null : null;
  }
  return CHOICE.test(n.kind || '') ? null : country;
}

/*
 * Matching a stored answer to the options a form really lists. The page's own picker (extension/agent/page.js
 * bestIndex) takes exact, then prefix, then substring, then "same meaning", then any option sharing half its
 * words: with ties it takes the first, so "Fall 2027" against [May 2027, December 2027] picked May. The driver
 * checks a value the same way BEFORE sending it and only sends one that safely names exactly one option.
 */
const fuzzy = (t) => String(t == null ? '' : t).toLowerCase().replace(/&/g, ' and ').replace(/[\u2019']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const DECLINE = /\b(decline\w*|prefer not|don ?t wish|do not wish|dont want|do not want|choose not|rather not|not (to )?(answer|disclose|say|specify|state|provide)|no answer|wish not|not (wish|want))\b/;
const NEGATION = /\b(not|non|no|never|none|neither|nor|without|cannot|dont|doesnt|didnt|wont|cant|isnt|arent|wasnt|havent|hasnt|un(employed|able|authori[sz]ed|willing|available|married|eligible))\b/;
const negated = (t) => NEGATION.test(t);
// Sanctioned / embargoed or otherwise foreign countries an option or answer must never claim for the owner unless he
// names it himself (Cedarhall 2026-10-09: "Yes – North Korea"). Same list as extension/agent/page.js COUNTRY_RISK.
const COUNTRY_RISK = /\b(north korea|dprk|iran|syria|cuba|crimea|russia|belarus|venezuela|sudan|myanmar|donetsk|luhansk)\b/;
const COUNTRY_RISK_LABEL = /\b(north korea|dprk|iran|syria|cuba|crimea|russia|belarus|venezuela|sudan|myanmar|donetsk|luhansk|embargo\w*|sanction\w*)\b/i;

/** yes / no / decline when an answer text says exactly that ("Yes, I am", "No - I do not", "I do not want to answer"); else null. "No longer a student" and "No answer" are not "No". */
function answerMeaning(raw) {
  const t = fuzzy(raw);
  if (DECLINE.test(t)) return 'decline';
  const r = String(raw == null ? '' : raw).trim();
  if (/^(yes|y)\s*([,.;:!\-\u2013\u2014(]|$)/i.test(r) || (/^i (am|do|will|have|can|would)\b/.test(t) && !negated(t))) return 'yes';
  if (/^(no|n|none)\s*([,.;:!\-\u2013\u2014(]|$)/i.test(r) || /^i (am|do|will|have|can|would) not\b|^i (dont|wont|cant|havent)\b|^i (have |am |do )?never\b|^never\b/.test(t)) return 'no';
  return null;
}

/**
 * The one option that safely means `value` (its exact text), or null when none does or several could.
 * Exactly the same words (case, spacing and punctuation aside); a yes / no / decline answer to the one option that
 * says the same thing (never "No" -> "No answer" / "No longer a student" / "I do not want to answer"); or a value
 * that is a whole segment of an option split on - / : ( ) , ("LinkedIn" -> "Job Board - Linkedin",
 * "Summer 2027" -> "Summer 2027 (May - August)"), with the same negation on both sides ("U.S. Citizen" is not
 * "Non-U.S. Citizen", "I am not a veteran" is not "Veteran"). A prefix that adds words is not a match
 * ("Information Technology" is not "Information Technology Management").
 */
function optionFor(value, options) {
  const v = fuzzy(value);
  const opts = (options || []).filter((o) => fuzzy(o));
  if (!v || !opts.length) return null;
  const ns = opts.map(fuzzy);
  const only = (idx) => (idx.length === 1 ? opts[idx[0]] : null);
  const all = (pred) => ns.map((t, i) => (pred(t, opts[i]) ? i : -1)).filter((i) => i >= 0);
  const exact = all((t) => t === v);
  if (exact.length) return opts[exact[0]];
  // Only a bare Yes / No (or a short decline) is matched by meaning: a sentence ("I am not a veteran") is not
  // "the one option that says no" ("I am not a protected veteran" is another answer).
  const want = /^(yes|y|true)$/.test(v) ? 'yes' : /^(no|n|false|none)$/.test(v) ? 'no' : answerMeaning(value) === 'decline' && v.split(' ').length <= 8 ? 'decline' : null;
  // A bare Yes / No only takes a plain option: "Yes, but I require sponsorship" is a different answer.
  // ("No, I do not require sponsorship" is still a plain No: the conditions only disqualify a No when it hedges.)
  const QUALIFIED = { yes: /\b(but|however|except|unless|only|if|require\w*|need\w*|sponsor\w*)\b/, no: /\b(but|however|except|unless|only|if)\b/ };
  const plain = (raw) => !QUALIFIED[want].test(fuzzy(raw).replace(/^(yes|no|y|n)\b/, ''));
  if (want) return only(all((t, raw) => answerMeaning(raw) === want && (want === 'decline' || plain(raw))));
  const neg = negated(v);
  // The same answer with only a trailing note: "Asian (Not Hispanic or Latino)", "United States of America",
  // "U.S. Citizen or National". The note's own negation does not count; the core must match exactly.
  const core = (raw) => fuzzy(String(raw).replace(/\([^)]*\)\s*$/, '')).replace(/ (of america|or (u s )?national)$/, '');
  const cored = all((t, raw) => core(raw) === v && negated(core(raw)) === neg);
  if (cored.length) return only(cored);
  const segs = (raw) => String(raw).split(/[-\u2013\u2014\/:|()\[\],]+/).map(fuzzy).filter(Boolean);
  return only(all((t, raw) => segs(raw).length > 1 && segs(raw).includes(v) && negated(t) === neg));
}

/**
 * "How did you hear about us?": the owner's standing answer (extras.howHeard, LinkedIn). On a list, in order:
 * an option naming it ("LinkedIn", "Linkedin", "LinkedIn Job Posting"); then, for LinkedIn only, the plain
 * social-networking category ("Social Networking", "Social Media"); then a plain job-board one ("Job Board").
 * "... - Other" catch-alls and anything else are asked.
 */
const HOW_HEARD = /^(?:how|where)(?: did| do|'d|’d) you (?:first |initially )?(?:(?:hear|learn)(?: out)? (?:about|of)|find out(?: about)?|(?:find|come across|discover|see)) +(.+)$/i;
// What comes after the verb must be the job, the role, the company or us: "How did you discover the field of
// cybersecurity" and "How did you find the application process" are not "how did you hear about us".
const HOW_HEARD_OBJECT = /^(?:us\b|(?:this|the|our)\b[^?]{0,25}\b(?:job|role|position|posting|opening|opportunit\w*|internship|vacancy|listing|company|team|program|us)\b)/i;
function isHowHeard(label) {
  const l = String(label || '').replace(/[*✱:\s]+$/, '').trim();
  const m = l.length <= 120 && HOW_HEARD.exec(l);
  if (!m || /referr|specify|name of|explain|describe|if other/i.test(l)) return false;
  const obj = m[1].trim();
  // "hear / learn about Elmstone / Thornhaven": a company named with a capital letter is fine; "find / discover" need the job words.
  const named = /\b(?:hear|learn)(?: out)? (?:about|of)\b/i.test(l) && /^[A-Z][A-Za-z0-9&.'’-]*/.test(obj) && !/^(The|This|Our|A|An|Your|My)\b/.test(obj);
  return HOW_HEARD_OBJECT.test(obj) || named;
}
function howHeardAnswer(n, howHeard) {
  const want = String(howHeard || '').trim();
  if (!want) return null;
  const opts = n.options || [];
  if (!opts.length) return CHOICE.test(n.kind || '') ? null : want;
  const w = normOpt(want);
  const named = opts.find((o) => normOpt(o) === w) || opts.find((o) => ` ${normOpt(o)} `.includes(` ${w} `));
  if (named) return named;
  if (w !== 'linkedin') return null;
  // "Social Media/External Job Board" (Driftmere iCIMS, 2026-10-09) is one option naming both.
  const fallbacks = [/^social (networking|network|networks|media)( sites?| websites?)?( external job boards?)?$/, /^(online |internet |external |web )?job (board|boards|site|sites|website|websites)$/, /^job (advert|advertisement|ad|posting) job board$/];
  for (const re of fallbacks) {
    const hit = opts.find((o) => re.test(normOpt(o)));
    if (hit) return hit;
  }
  // Owner 2026-10-09: any option will do, never stop for it. An online / company-site source, then Other, then the
  // first real option that names no person (no referral / recruiter / employee: those ask for a name he can't give).
  const real = opts.filter((o) => normOpt(o) && !/^(select|choose|please select|make a selection|none selected)\b|^-+$|^—/i.test(String(o).trim()));
  const noPerson = real.filter((o) => !/\b(referr\w*|refer\w*|recruiter|employee|friend|colleague|relative|family|agency|staffing)\b/i.test(o));
  return noPerson.find((o) => /\b(online|internet|web ?site|career (site|page|website)|company (site|website|career)|search engine|google|indeed|handshake|glassdoor|job (board|site|posting))\b/i.test(o))
    || noPerson.find((o) => /^other\b/i.test(String(o).trim()))
    || noPerson[0] || null;
}

/**
 * Major / Discipline list: the real major, else an option that starts with it ("Information Technology
 * and Management"), else "Other" (owner rule: never a different major such as Computer Science), else ask.
 */
function majorAnswer(n, major) {
  const want = normOpt(major);
  if (!want) return null;
  const opts = n.options || [];
  if (!opts.length) return CHOICE.test(n.kind || '') ? null : major; // unread list: fuzzy matching could pick "Information Systems"
  return (
    opts.find((o) => normOpt(o) === want) ||
    opts.find((o) => normOpt(o).startsWith(want + ' ')) ||
    opts.find((o) => /^other( \(.*\))?$/i.test(String(o).trim())) ||
    null
  );
}

// Profile-driven dropdown labels (shared by profileAnswer and the search-as-you-type reader).
const STATE_LABEL = /^(state|province|state\s?\/\s?province|province\s?\/\s?state|state or province|state\s?\/\s?region|state\s?\/\s?province\s?\/\s?region|state\s?\/\s?territory|state or territory|state of residence)$/i;
const COUNTRY_LABEL = /^(country|country\s?\/\s?region|country of residence)$/i;
const MAJOR_LABEL = /^((undergrad(uate)? )?(discipline|major)(\(s\))?|field of study|area of study|major\/field of study)$/i;
const PHONE_CODE_LABEL = /^(country )?phone code$|^country (calling )?code$|^phone country( code)?$|^dial(ing)? code$/i;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Plain profile facts for fields Formhand's adapters left empty (custom dropdowns such as
 * Greenhouse's School / Location (City) react-selects). Returns { value, query? } or null.
 * Only facts straight from data/profile.json; anything ambiguous is left for a person.
 */
const home0 = (n) => !NOT_HOME.test(`${n.section || ''} ${n.label || ''}`);
function profileAnswer(n, p) {
  const label = String(n.label || '').replace(/[*✱:\s]+$/, '').trim();
  const ctx = `${n.section || ''} ${label}`;
  const pr = p.profile || {};
  // High school is not the college in the profile (2026-10-07: "Year of High School Graduation"
  // got the college grad year on a Lever dry run).
  if (/\b(high school|secondary school|secondary education|ged|hs diploma)\b/i.test(ctx)) return null;
  const short = label.length <= 60; // a long sentence is a question, not a profile field
  if (short && /^(location|location \(city\)|city|(your )?current location|your location|city of residence|where are you (currently )?located\??)$/i.test(label) && pr.city) {
    // A plain "City" belongs to the applicant's own address block only: not an employer's or school's.
    if (/^city$/i.test(label) && !home0(n)) return null;
    // A plain City text box (Oracle, iCIMS) wants just the city; the pickers (Greenhouse Location (City)) want "City, ST" typed as the city.
    if (/^city$/i.test(label) && /^(text|input|)$/.test(n.kind || 'text') && !(n.options || []).length) return { value: pr.city };
    return { value: [pr.city, pr.state].filter(Boolean).join(', '), query: pr.city };
  }
  // Oracle's required "Preferred First / Last Name" (Fernhaven 2026-10-09: left blank, the page refused to move on).
  if (short && /^preferred first name$/i.test(label) && (pr.preferredName || pr.firstName)) return { value: pr.preferredName || pr.firstName };
  if (short && /^preferred last name$/i.test(label) && pr.lastName) return { value: pr.lastName };
  const schoolQ = /^(which|what) (university|college|school)\b.*\b(attend|attending|enrolled)\b/i.test(label) || /^(please )?(re-?confirm|confirm|verify|select|enter) (the |your )?(name of )?(university|college|school)( that)? you (currently |are currently )?(attend|attending|are attending|are enrolled in)\b/i.test(label);
  if (((short && /^(school|university|college|school name|institution|college\/university|school or university)$/i.test(label)) || schoolQ) && pr.school) {
    return { value: pr.school };
  }
  if (short && MAJOR_LABEL.test(label) && pr.major) {
    const v = majorAnswer(n, pr.major);
    return v ? { value: v } : null;
  }
  // "intended graduation year for the degree ... you are currently pursuing" is fine at any length.
  const grad = /graduat/i.test(label) || (/^end date/i.test(label) && /educat|school/i.test(ctx));
  if (grad && /month/i.test(label) && !/year/i.test(label) && pr.gradMonth) {
    const m = Number(pr.gradMonth);
    return { value: m >= 1 && m <= 12 ? MONTHS[m - 1] : pr.gradMonth };
  }
  if (grad && /year/i.test(label) && !/month/i.test(label) && pr.gradYear) return { value: pr.gradYear };
  // A full graduation date (date pickers want a day: Ashby keeps "12/15/2027", drops "12/2027"),
  // only when the owner gave one (extras.gradDateExact, MM/DD/YYYY).
  const ex = (p.extras || {}).gradDateExact;
  if (ex && /^(expected )?graduation date$|^(expected|anticipated) graduation$/i.test(label)) return { value: ex };
  // Oracle's Address Line 1 is a suggestion combobox (typing the street offers the full address, which also
  // fills ZIP / City / State). Home address only: never an employer's or school's address block.
  const home = !NOT_HOME.test(`${n.section || ''} ${n.label || ''}`);
  if (short && home && /^(address line 1|street address|address 1)$/i.test(label) && pr.addressLine1) {
    return { value: pr.addressLine1, query: pr.addressLine1 };
  }
  // The rest of the home address (Oracle / iCIMS / Greenhouse address blocks): an exact option or nothing.
  const one = (v) => (v ? { value: v } : null);
  if (short && home && STATE_LABEL.test(label) && pr.state) {
    return one(stateAnswer(n, pr.state));
  }
  if (short && home && COUNTRY_LABEL.test(label) && pr.country) return one(countryAnswer(n, pr.country));
  // Workday "Country Phone Code": the dial-code list names the U.S. like "United States of America (+1)".
  if (short && home && PHONE_CODE_LABEL.test(label) && pr.country && US.test(stripDigits(normOpt(pr.country)))) {
    const hit = (n.options || []).find(isUsOption);
    return hit ? { value: hit } : null;
  }
  // Workday "Phone Device Type" (Mobile / Home / Work): the type the owner's profile gives for the phone.
  if (short && home && /^phone (device )?type$/i.test(label) && pr.phoneType && (n.options || []).length) {
    return one(optionFor(pr.phoneType, n.options));
  }
  if (short && home && /^(zip|zip code|zipcode|postal code|postcode|zip\s?\/\s?postal code|postal\s?\/\s?zip code|zip or postal code)$/i.test(label) && pr.postalCode) {
    return CHOICE.test(n.kind || '') ? null : { value: pr.postalCode };
  }
  // County: only a county the owner wrote down; never derived from the city or ZIP.
  if (short && home && /^county$/i.test(label)) {
    if (!pr.county) return null;
    const opts = n.options || [];
    if (!opts.length) return CHOICE.test(n.kind || '') ? null : { value: pr.county };
    return one(opts.find((o) => normOpt(o) === normOpt(pr.county) || normOpt(o) === normOpt(`${pr.county} county`)));
  }
  if (isHowHeard(n.label)) return one(howHeardAnswer(n, (p.extras || {}).howHeard));
  return null;
}

/**
 * The owner's standard answer (profile.json standardAnswers) for a question the page labels
 * differently from what Formhand saw: Formhand's own detector and option matcher, so the
 * pick is exactly an option that means the stored answer, or nothing.
 */
function standardAnswer(n, p, ctx) {
  const ST = D.AF.standard;
  const kind = n.kind === 'combobox' ? 'select' : n.kind === 'buttons' ? 'radio' : n.kind;
  let hit = ST.detect({ label: n.label || '', context: n.section || '', inputType: kind });
  // Workday's CC-305 self-identify step asks "Please check one of the boxes below:" (DUNVALE 2026-10-09): the label says
  // nothing, the options are the disability statuses.
  if (!hit && (n.options || []).filter((o) => /\bdisabilit/i.test(o)).length >= 2) hit = { id: 'disability' };
  if (!hit) return null;
  // "Are there any restrictions or limitations on your right to work ...?" is detected as work authorization,
  // whose stored answer is "yes": backwards for this question (Elmbrook asked it 4 times). Left to logisticsAnswer.
  if (hit.id === 'workAuth' && isWorkRestriction(n.label || '')) return null;
  // "Previously employed by <company>" is "no" for everyone except the places he worked (Quillstone interned: not "no").
  // "Worked with Python before" is not an employment question at all.
  if (hit.id === 'previouslyEmployed' || hit.id === 'clientEmployed') {
    if (workedAt(n.label) || workedAt(whoseForm(ctx)) || (n.options || []).some(workedAt)) return null;
    if (/\bworked\s+(for|at|with)\b/i.test(n.label || '') && !employerQuestion(n.label, ctx)) return null;
  }
  const answerId = (p.standardAnswers || {})[hit.id];
  if (!answerId || !n.options || !n.options.length) return null;
  const want = ST.fillValue(hit.id, answerId, { label: n.label, inputType: kind }, null, hit);
  if (!want) return null;
  const m = ST.matchOption(n.options.map((text) => ({ text })), hit.id, want);
  return m ? { value: n.options[m.index], source: 'standard:' + hit.id } : null;
}

/**
 * Logistics questions every internship form asks, from the owner's standing answers in profile.json extras
 * (2026-10-07/08: onsite or hybrid fine, relocation yes, U.S. citizen, internTerm, graduation / gradYear /
 * gradMonthYear / gradDateExact, priorInternships + lastInternship, gpa, pronouns, earliestStart). Pure:
 * label + kind + options in, value or null out. A choice question only gets one of its own options; anything
 * ambiguous returns null and is asked as before. Each pattern is narrow on purpose (code review 2026-10-08:
 * a loose one would put an untrue answer or an opt-in on a form that submits unattended).
 */
const MONTH3 = MONTHS.map((m) => m.slice(0, 3).toLowerCase());

// Places he has worked, so "previously employed by <company>" is never No there: the employers on the master resume
// (data/resumes/master.json, split into the names a form might use) plus the names facts.md gives for them
// (Quillstone; EXU / ECI research, grant-funded; Gamma Project, Civic Lab, Civic Org).
const WORKED_BUILTIN = ['Quillstone', 'Example State University', 'EXU', 'Gamma Project', 'Civic Lab', 'ECI', 'Example Cyber Institute', 'Example Cyber', 'Civic Org', 'Grant Agency', 'Grant Agency'];
let workedCache = null;
function workedRe() {
  let file = null;
  let mtime = 0;
  try {
    file = path.join(D.DATA_DIR, 'resumes', 'master.json');
    mtime = fs.statSync(file).mtimeMs;
  } catch (e) {
    file = null;
  }
  if (workedCache && workedCache.file === file && workedCache.mtime === mtime) return workedCache.re;
  const names = new Set(WORKED_BUILTIN);
  if (file) {
    try {
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const x of [...(Array.isArray(r.experience) ? r.experience : []), ...(Array.isArray(r.education) ? r.education : r.education ? [r.education] : [])]) {
        for (const part of String(x.company || x.school || '').split(/[(),;]/)) if (part.trim().length >= 3) names.add(part.trim());
      }
    } catch (e) {
      /* a half-written master.json: the built-in names still apply */
    }
  }
  const alts = [...names]
    .map((nm) => fuzzy(nm).split(' ').filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z0-9]+'))
    .filter(Boolean);
  const re = new RegExp(`(?<![a-z0-9])(?:${alts.join('|')})(?![a-z0-9])`, 'i');
  workedCache = { file, mtime, re };
  return re;
}
/** Does the text name a place he has worked? */
const workedAt = (text) => workedRe().test(String(text || ''));

/** The host and first path words of a URL ("job-boards.greenhouse.io/brookvale/jobs/1" -> "job-boards greenhouse io brookvale jobs"). */
function urlWords(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/\./g, ' ')} ${u.pathname.split('/').slice(1, 3).join(' ')}`;
  } catch (e) {
    return '';
  }
}
/** The run's company plus its URL's words: whose form this is, as far as the driver can tell. */
const whoseForm = (ctx) => `${(ctx && ctx.company) || ''} ${urlWords(ctx && ctx.url)}`.trim();
const GENERIC_WORDS = new Set(['www', 'careers', 'career', 'jobs', 'job', 'boards', 'board', 'apply', 'icims', 'com', 'net', 'org', 'io', 'myworkdayjobs', 'workday', 'oraclecloud', 'greenhouse', 'lever', 'ashbyhq', 'ashby', 'external', 'en', 'us', 'the', 'inc', 'llc', 'corp', 'corporation', 'company', 'co', 'ltd', 'group', 'fa', 'hcmui', 'candidateexperience', 'sites', 'cx', 'embed', 'job_app']);
const nameWords = (t) => fuzzy(t).split(' ').filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w) && !/^wd\d+$/.test(w));
/** Does `obj` (the thing a question says he worked for / at / with) name THIS form's company? "us" and "this company" do. */
function namesThisCompany(obj, ctx) {
  const o = fuzzy(obj);
  if (!o) return false;
  if (/^(us|this company|our company|the company|this organi[sz]ation|our organi[sz]ation|this employer|our team|here)$/.test(o)) return true;
  const mine = new Set(nameWords(whoseForm(ctx)));
  return nameWords(obj).some((w) => mine.has(w));
}
/** What a question says he worked / interned / was employed "for", "at", "with" or "by": { prep, obj } or null. */
function workedClaim(label) {
  const m = /\b(?:worked|interned|been employed|employed|served)\s+(?:directly\s+)?(for|at|with|by)\s+(.+?)(?=\s+before\b|\s+previously\b|\s+as\s+an?\b|\s+in\s+the\s+past\b|\s*[?,;.]|\s+or\b|\s*$)/i.exec(String(label || '').replace(/[*✱\s]+$/, ''));
  return m ? { prep: m[1].toLowerCase(), obj: m[2] } : null;
}
/**
 * Is "worked for / at / with X" an employer question we can answer from the facts? "us" / this company / the
 * company of this form always; "for" or "at" a named organization (Capitalised, not "a university"); never "with X"
 * for another X ("worked with Python / Kubernetes / the Grant Agency" are skills, tools or clients).
 */
function employerQuestion(label, ctx) {
  const c = workedClaim(label) || (/\bworked with us\b/i.test(label) ? { prep: 'with', obj: 'us' } : null);
  if (!c) return false;
  if (namesThisCompany(c.obj, ctx)) return true;
  return (c.prep === 'for' || c.prep === 'at') && /^[A-Z0-9]/.test(c.obj) && !/^(The )?(Following|U\.?S\.?|United States)\b/.test(c.obj);
}

// "restrictions or limitations on your right to work": the polarity is the opposite of "are you authorized".
const WORK_RESTRICTION_WORDS = /\b(restrictions?|limitations?|prevents?|prevented|prohibit\w*|barred|impediments?)\b/i;
// ... but "authorized to work WITHOUT restrictions" is the positive question again.
const isWorkRestriction = (label) => WORK_RESTRICTION_WORDS.test(label) && !/\b(without|free (of|from)|unrestricted)\b|\bno (restrictions?|limitations?|impediments?)\b/i.test(label);

function logisticsAnswer(n, p, ctx) {
  const label = String(n.label || '').replace(/\s+/g, ' ');
  const company = (ctx && ctx.company) || '';
  const who = whoseForm(ctx); // the run's company and its URL's host / first path words
  const opts = n.options || [];
  const choice = /select|combobox|radio|buttons|checkboxes/.test(n.kind || '');
  const pick = (re) => opts.find((o) => re.test(o)) || null;
  // A plain Yes / No: on a list, the ONE option that says it and names no sanctioned / foreign country ("Yes – North
  // Korea" is not a Yes, Cedarhall 2026-10-09); two candidates are a guess, so none.
  const sole = (re) => {
    const hits = opts.filter((o) => re.test(o) && !COUNTRY_RISK.test(fuzzy(o)));
    return hits.length === 1 ? hits[0] : null;
  };
  const yes = () => (choice ? sole(/^yes\b/i) : 'Yes');
  const no = () => (choice ? sole(/^no\b/i) : 'No');
  const e = (p && p.extras) || {};
  const asks = (re) => re.test(label);
  const first = (...fns) => {
    for (const f of fns) {
      const v = f();
      if (v) return v;
    }
    return null;
  };
  // Follow-ups asking for details of a previous answer, and anything about opting in or out: never here.
  if (asks(/if (you answered|yes|no)\b|please (explain|describe|provide (additional )?details)/i)) return null;
  if (asks(/\bopt(ing)?[- ](in|out)\b|communications?|newsletter|marketing/i)) return null;
  const rules = [
    // Visa / immigration status: an exact "U.S. citizen" option (never "Non-U.S. citizen"), or No to "are you in F-1 status".
    () => asks(/^(what is )?your (current )?(visa|immigration|work authori[sz]ation) status\b|\bvisa status\b/i) && (choice ? pick(/^\s*(u\.?s\.?|united states) citizen\b/i) : e.citizenship),
    () => asks(/\bare you (a student )?(currently )?(in|on) (an? )?f-?1\b|\bf-?1 status\b/i) && no(),
    // OPT / CPT are F-1 work permits: a U.S. citizen is on neither (Birchgate, 2026-10-08).
    () => asks(/\b(on|using) (stem )?(opt|cpt)\b|\b(opt|cpt)\s*(,|or|\/)\s*(stem opt|opt|cpt)\b/i) && !asks(/\b(will|plan|intend)\b/i) && /citizen/i.test(e.citizenship || '') && no(),
    // "Not open to F-1 / J-1 ... confirm your understanding": only the option that says no sponsorship is needed (Thorngate).
    () => asks(/\b[fj]-?1\b/i) && asks(/\bconfirm\b/i) && choice && /citizen/i.test(e.citizenship || '') && pick(/confirm\b.*\bdo not require\b/i),
    // "Willing to work within 50 miles of the Seattle office?": relocation yes covers it (Thorngate).
    // Not "do you currently live within 25 miles" (where he lives now is not a relocation answer).
    () => asks(/\bwithin \d+\s*(mi|miles|km)\b.*\boffice\b/i) && asks(/\b(willing|able|plan|confirm|accept)/i) && !asks(/\b(currently|now) (live|reside|located)|\bdo you (live|reside)\b/i) && /^yes/i.test(e.relocation || '') && yes(),
    // A statement with Yes/No ("This position is based in San Francisco and requires being in-office 4x/week",
    // Northmoor, 2026-10-09): onsite fine, so Yes.
    () => choice && asks(/\brequires? (being |working |you to (be|work) )?(in[- ]office|on[- ]?site|in[- ]person)\b|\b(in[- ]office|on[- ]?site|in[- ]person) \d\s*(x|days?)\b/i) && !asks(/\b(not|unable|cannot|can't)\b/i) && /onsite|hybrid/i.test(e.workMode || '') && yes(),
    // A sanctioned-country citizenship / residency question ("Is your most recent country of citizenship or permanent
    // residency one of: North Korea; Syria; Iran; or Cuba?", Cedarhall): No for a U.S. citizen, never about relatives.
    () => asks(COUNTRY_RISK_LABEL) && asks(/\b(citizen\w*|nationalit\w*|residen\w*|passport)\b/i) && !asks(/\b(relatives?|family|spouse|parents?|household|anyone)\b/i) && /citizen/i.test(e.citizenship || '') && (choice ? first(() => no(), () => sole(/^none\b|^not? (a )?(citizen|resident)\b|^none of (these|the above)\b/i)) : 'No'),
    // ITAR / U.S. person / export control: Yes only to the plain status question. Not a list of countries, citizenship
    // of a named country, licensing, sponsorship, or any sanctioned-country wording.
    () => asks(/\bitar\b|\bu\.?s\.? person\b|export control/i) && !asks(/\b(do|will) you (require|need)|sponsor|licens|countr|nationalit|embargo|sanction|foreign|non[- ]?u\.?s\b/i) && !asks(COUNTRY_RISK_LABEL) && yes(),
    () => (asks(/\b(in[- ]office|on[- ]?site|in[- ]person|hybrid|commut)/i) || asks(/\boffice\b.*\bdays?\b|\bdays? (a|per|each) week\b/i)) && asks(/\b(able|willing|open|can you|commit|comfortable|available)\b/i) && /onsite|hybrid/i.test(e.workMode || '') && yes(),
    // Willing to relocate: yes. Asking for relocation assistance / a stipend is a request for a benefit: not ours
    // to answer. A question that only mentions a stipend ("...stipends may also be available", Dunhaven) is fine.
    () => asks(/\b(willing|open|able|plan)\b[^.?]{0,30}\breloca|\brelocation\s*\?|\bopen to relocation\b/i) && !asks(/\b(require|need|request|want|expect)\b[^.?]{0,40}\b(assist|stipend|package|reimburs|benefit|support|help|cover)|relocation (assistance|package|stipend|benefit|reimbursement|support)s?\b[^.]*\?|\b(ever|unwilling|not willing|currently live)\b/i) && /^yes/i.test(e.relocation || '') && (choice ? first(() => pick(/^yes\b/i), () => pick(/\b(open|willing) to relocat/i)) : 'Yes'),
    // "Have you been previously employed by <company>?": No, unless the company is one he has worked for (workedAt:
    // the master resume's employers, Quillstone, EXU / ECI, Gamma Project / Civic Lab, the Civic Org / Grant Agency). "Employed by / at / with" and
    // "former employee" are about an employer; "worked with Python" is not, so "worked for / at / with X" needs X to be
    // this form's company. Relatives / referrals / "applied before" / a generic "a university" are not this rule.
    () => (asks(/\b(previously|ever|formerly)\b[^?]{0,20}\bemployed\b[^?]{0,20}\b(by|at|with)\b|\bprevious(ly)? (an )?employee of\b|\bformer employee\b/i) || (asks(/\b(have|did|had) you\b[^?]{0,25}\b(ever |previously |formerly )?(worked|interned)\s+(for|at|with)\b|\bworked with us before\b/i) && employerQuestion(label, ctx))) && !asks(/\b(relatives?|family members?|friends?|refer|applied|contractor|intern(ed)? (for|at)|government|military|federal)\b/i) && !asks(/\b(employed|worked)\b[^?]{0,15}\b(by|at|with|for) (a|an|any|another|one|some)\b/i) && !workedAt(label) && !workedAt(who) && !opts.some(workedAt) && (company || urlWords(ctx && ctx.url) || !asks(/\b(us|this company|our company|the company)\b/i)) && no(),
    // A list of employment statuses ("I currently work at X ...", "I have never worked at X"): the never-worked option
    // for the company the question names; never when that company, the form's host or any option names a place he worked.
    () => {
      if (!choice || !asks(/\b(ever|previously|formerly)\b[^?]{0,20}\b(worked|been employed)\b/i) || asks(/\b(relatives?|family members?|friends?|refer|applied|government|military|federal)\b/i)) return null;
      if (workedAt(label) || workedAt(who) || opts.some(workedAt)) return null;
      const o = pick(/^\s*(i have )?never (worked|been employed|been an?)\b/i);
      const named = o && /\bnever (?:worked|been employed|been an? \w+)\s+(?:at|for|with)\s+(.+)$/i.exec(o);
      // The option must name the company the question names (a list that says "never worked at Acme" under a question about Acme).
      return o && named && fuzzy(label).includes(fuzzy(named[1])) ? o : null;
    },
    // The U.S. citizen has no LEGAL restriction on his right to work (the work-authorization standard answer "Yes" would
    // be backwards here). Not "restrictions on your ability to work weekends / nights / on-site / overtime".
    () => asks(/\b(restrictions?|limitations?)\b[^?]{0,80}\b(right|authori[sz]ation|eligibility|permission) to work\b|\bright to work\b[^?]{0,80}\b(restrictions?|limitations?)/i) && !asks(/\b(relatives?|family|spouse)\b|\b(without|free (of|from)|unrestricted)\b|\bno (restrictions?|limitations?)\b|\b(weekends?|nights?|shifts?|overtime|on-?site|remote|schedule|hours|travel|lifting|physical)\b/i) && /citizen/i.test(e.citizenship || '') && no(),
    // "Are you able to work/live within the United States or Canada for the duration of your internship?": the "or"
    // wording is true for a U.S. citizen; "Canada AND the United States", "the EU and the US", "US and UK" are not.
    () => {
      const m = /\b(able|willing|available|eligible)\b[^?]{0,40}\b(work|live|reside|be (based|located))\b(?:\s*(?:\/|and|or|and\/or)\s*(?:work|live|reside))?\s+(?:within|in)\s+(?:the\s+)?(united states|u\.?s\.?a?)\b(?:\s+or\s+canada)?/i.exec(label);
      if (!m) return null;
      const rest = label.slice(m.index + m[0].length);
      if (/^\s*(,|\/|&|and\b|both\b|plus\b|as well\b)/i.test(rest) || /\bboth\b/i.test(label.slice(0, m.index + m[0].length).split(/\b(?:within|in)\b/i).pop())) return null;
      if (asks(/sponsor|visa|require|permit|relocat/i) || !/citizen/i.test(e.citizenship || '')) return null;
      return yes();
    },
    () => asks(/push (back )?your (expected )?graduation|delay your graduation/i) && no(),
    () => asks(/\breturn to (school|your (program|studies|university|degree))\b/i) && yes(),
    () => asks(/\bcurrently enrolled in (a |an )?(university|college|school|degree program|undergraduate|bachelor'?s|education program)\b/i) && !asks(/ph\.?d|doctor|master|mba|bootcamp|graduate program/i) && !asks(/\bnot\b|\bno longer\b|\b(18|eighteen)\b/i) && yes(),
    () => asks(/\b12[- ]week|full[- ]time \(?40 hours|40 hours (per|a) week/i) && asks(/\b(available|able|commit)\b/i) && yes(),
    () => asks(/\bable to start between\b/i) && startWindowFits(label, e.earliestStart) && yes(),
    () => asks(/which term|\bterms?\(?s?\)?\b.*\b(available|able|work)\b|internship term|available to intern|which season|when are you available for (a |an |the )?(\d+[- ]week )?internship\b/i) && (choice ? first(() => pick(/summer\s*2027/i), () => pick(/^summer\b/i)) : e.internTerm),
    () => asks(/length of (the )?internship|how long .*intern|internship (length|duration)/i) && choice && pick(/^3 months|^12 weeks|10\s*-\s*12 weeks/i),
    () => asks(/(expected|anticipated) (graduation|grad)|(expected|anticipated) date of (your )?graduation|when do you (expect|plan) to graduate|graduation (date|year)|(intend|expect|plan) to (complete|finish) your degree|(expected|anticipated) (degree )?completion( date)?|\bdate (that )?you (will |expect to )?(complete|finish|graduate)|\b(on track|set|scheduled) to graduate\b|\bwhat (semester|term|season)\b[^?]{0,40}\bgraduat/i) && !asks(/what degree|which degree|high school/i) && (asks(/graduat/i) || (asks(/\b(degree|bachelor'?s?|undergraduate|university|college|school|studies|academic|education)\b/i) && !asks(/certif|licen[cs]e|\b(job|role|position|project|internship|employment|work|assignment|contract|training|bootcamp|course|exam|test|program(me)? at)\b/i))) && gradAnswer(n, label, choice, pick, opts, e),
    // 2026-10-08 (Dunhaven, Kestrelhaven, Zephyrhaven): standing answers the forms phrase their own way.
    () => asks(/\b(ideal|earliest|preferred|desired) (internship )?start date\b|when (can|could) you start\b/i) && !asks(/full[- ]time|after graduat|permanent/i) && !choice && e.earliestStart,
    () => asks(/\bclass (year|standing)\b|\byear in school\b|academic (year|standing)\b/i) && !asks(/graduat/i) && e.classYear && (choice ? first(() => opts.find((o) => o.trim().toLowerCase() === e.classYear.toLowerCase()), () => pick(new RegExp('^\\s*' + e.classYear.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b(?!.*\\d{4})', 'i'))) : e.classYear),
    () => asks(/\b(active|current|held|hold)\b[^?]{0,30}\bclearances?\b|^active security clearance/i) && !asks(/eligib|obtain|willing|able to/i) && /none held/i.test(e.clearance || '') && choice && pick(/^never held|^none\b|^no (active |security )?clearance|^n\/a\b/i),
    () => asks(/clearance eligib|eligible (for|to obtain) (a )?(security )?clearance/i) && !asks(/relative|family|spouse|related to|household|parent|sibling|anyone/i) && /eligible/i.test(e.clearance || '') && !asks(/\bare you a (u\.?s\.?|united states) citizen\b/i) && yes(),
    () => asks(/\bare you a (u\.?s\.?|united states) citizen\b/i) && !asks(/dual|other citizenship|relative|family|spouse|related to|household|parent|sibling|anyone/i) && /citizen/i.test(e.citizenship || '') && yes(),
    () => asks(/^citizenship( status)?[\s*✱:]*$/i) && /citizen/i.test(e.citizenship || '') && choice && pick(/^\s*u\.?s\.? citizen\b/i),
    // "What's your citizenship / employment eligibility?" with "I am a U.S. Citizen/ Permanent Resident" (Willowcrest 2026-10-08).
    () => asks(/^(what('?s| is) your )?citizenship\s*(\/|or|and)\s*(employment|work) (eligibility|authori[sz]ation)\b/i) && /citizen/i.test(e.citizenship || '') && choice && pick(/^\s*(i am an? )?u\.?s\.? citizen\b/i),
    () => asks(/legally authori[sz]ed to work in the (u\.?s\.?|united states)/i) && !asks(/sponsor/i) && /citizen/i.test(e.citizenship || '') && (choice ? first(() => opts.find((o) => /authori[sz]ed to work .*for any employer/i.test(o) && !/sponsor|require|but\b/i.test(o)), () => pick(/^yes\s*$/i)) : null),
    () => asks(/\b(?:do you have,? or )?are you (?:currently )?pursuing,? (?:a |an )?(?:college |university |bachelor'?s |undergraduate )?degree\b(?!\s+in\b)/i) && !asks(/master|ph\.?d|doctor|mba|graduate degree/i) && yes(),
    () => asks(/auditor independence/i) && asks(/\b(currently )?work(ed)? for\b|\bemployed (by|at)\b/i) && !asks(/financial interest|invest|relative|family|spouse|related to|household|parent|sibling|anyone/i) && no(),
    () => asks(/^\s*are you a (current or former|former or current|current) (u\.?s\.? )?(federal )?government employee\b/i) && !asks(/relative|family|spouse|related to|household|parent|sibling|anyone|military/i) && e.govEmployee === 'No' && no(),
    () => asks(/how many (prior |previous )?internships/i) && e.priorInternships && (choice ? pick(new RegExp('^' + e.priorInternships + '\\b')) : e.priorInternships),
    () => asks(/where was your (last|most recent) internship/i) && !choice && e.lastInternship,
    () => asks(/\b(current|cumulative|overall) (grade point average|gpa)\b|what is your gpa/i) && (choice ? gpaRange(opts, e.gpa) : e.gpa),
    () => asks(/\bpronouns?\b/i) && (choice ? pick(/^\s*he\s*\/\s*him\s*$/i) : e.pronouns),
    // "Will you be at least 18 years old at or before the start of your internship?" (Coppermoor Workday): the whole
    // question is the age; "... and a valid driver license / 3 years of experience / ever been convicted" is not.
    () => /^(?:are you (?:18|eighteen) years (?:of age|old)(?: or older)?|(?:(?:will|are|do|can) you(?: be)?|are you) (?:at least|over|older than|above|aged?) ?(?:18|eighteen)(?: years(?: old| of age)?)?(?: (?:of age|old|or older))?(?: or older)?(?: (?:at or before|before|by|on) the (?:start|beginning) of (?:your|the) (?:internship|program|role|employment|start date|job|position|co-?op))?)$/i.test(label.replace(/[*✱:\s?.]+$/, '').trim()) && /^y/i.test(String(e.over18 || '')) && yes(),
    // Committing to the whole internship (Coppermoor, Elmbrook Workday): the same standing "available for the full 12
    // weeks" -- only when the question names no dates, or dates inside the summer term (earliestStart + 4 months of the
    // internTerm year): "full duration, Jan - Aug 2027" and "a fall co-op (Aug - Dec 2026)" are different terms.
    () => asks(/\b(entire|full|whole) (duration|length|period|term)\b/i) && asks(/\b(internship|program|co-?op)\b/i) && asks(/\b(able|willing|available|commit|confirm)\b/i) && !asks(/\b(not|unable|part[- ]time)\b|relocat|sponsor/i) && termFits(label, e) && yes(),
    // "Which month can you start?" with a month list: the month (and year, when the list has one) of extras.earliestStart ("May 2027").
    () => choice && asks(/\b(select|choose|what|which)\b[^?]{0,40}\bmonth\b[^?]{0,50}\b(start|begin)/i) && !asks(/graduat/i) && e.earliestStart && startMonthOption(opts, label, e.earliestStart),
    // Bound by nothing that keeps him from taking the job (owner, 2026-10-08 / 10-09: no NDA, non-compete or other
    // agreement with any employer). QUARRYHALL Workday: "Are you aware of any legal restrictions on your ability to accept and
    // perform this job, such as an agreement with your current or former employer?" -> No. Never about relatives.
    () => asks(/\b(legal |contractual )?(restrictions?|limitations?|obligations?|agreements?|covenants?)\b/i) && asks(/\b(current|former|previous|prior|past) employers?\b|\bnon-?(compet|solicit|disclosure)\w*|\bpreclude/i) && asks(/^\s*(are|is|do|does|have|has|were|was) (you|there|any)\b/i) && !asks(/\b(willing|prepared|comfortable|sign)\b|\b(relatives?|family|spouse|household|parents?|sibling)\b|\b(read|reviewed?|accept(ed)? the|acknowledg\w*|agree (to|with) the)\b/i) && no(),
    // Never signed an NDA / non-compete / non-solicit with any employer (owner, 2026-10-08, memory no-nda-noncompete).
    // Only the question about an agreement he HAS signed / is bound by with an employer: reading, reviewing,
    // accepting or signing one now ("Have you read and accepted the confidentiality agreement?") is another question.
    () => asks(/\b(non-?compet\w*|non-?disclosure|non-?solicit\w*|restrictive covenants?|confidentiality agreement|nda)\b/i) && asks(/\b(have you|do you have|are you|were you|did you)\b[^?]{0,60}\b(signed|entered into|subject to|bound by|party to)\b|\bsigned (a |an )?(non|nda|confidential)/i) && asks(/\b(current|previous|prior|former|past)\b[^?]{0,20}\b(employer|employers|employment|company|companies)\b|\b(preclude|restrict|limit|prevent)\b/i) && !asks(/\b(read|reviewed?|accept(ed)?|acknowledg\w*|agree(d)?|consent|willing|would you|will you|prepared to|able to|comfortable)\b|\bplease (sign|review|read)\b/i) && no(),
  ];
  return first(...rules) || null;
}

/** The option whose "a - b" range holds the GPA ("3.50 - 4.00 or higher", "3.5 - 3.69"); null when none does. */
function gpaRange(opts, gpa) {
  const g = Number(gpa);
  if (!g) return null;
  return opts.find((o) => {
    const m = String(o).match(/(\d\.\d+)\s*(?:-|–|to)\s*(\d\.\d+)/);
    return m && g >= Number(m[1]) && g <= Number(m[2]);
  }) || null;
}

/**
 * Is the term a question names inside the one he offers (summer of extras.internTerm's year, from extras.earliestStart
 * for four months)? A label naming no month, year or season fits; one naming another year, a month before his start
 * or after the summer, or fall / winter / spring does not.
 */
function termFits(label, e) {
  const t = String(label || '').toLowerCase();
  const years = [...t.matchAll(/\b(20\d\d)\b/g)].map((m) => m[1]);
  const months = MONTH3.map((m, i) => (new RegExp('\\b' + m + '[a-z]*\\b').test(t) ? i : -1)).filter((i) => i >= 0);
  const season = /\b(fall|autumn|winter|spring)\b/.test(t);
  if (!years.length && !months.length && !season) return true;
  const start = MONTH3.indexOf(String(e.earliestStart || '').slice(0, 3).toLowerCase());
  const year = (String(e.internTerm || e.earliestStart || '').match(/20\d\d/) || [])[0];
  if (start < 0 || !year || season) return false;
  if (years.some((y) => y !== year)) return false;
  return months.every((m) => m >= start && m <= start + 4);
}

/** The option for the month (and year, if it has one) of `earliestStart`; null when none or several fit, or the question names another year. */
function startMonthOption(opts, label, earliestStart) {
  const [mon, yr] = String(earliestStart).split(/\s+/);
  if (!mon || !yr) return null;
  const full = MONTHS.find((m) => m.slice(0, 3).toLowerCase() === mon.slice(0, 3).toLowerCase());
  if (!full) return null;
  // The whole month name or its abbreviation: "May" must not match "Maybe" (review 2026-10-09).
  const re = new RegExp('^\\s*(?:' + full + '|' + full.slice(0, 3) + '\\.?)\\b', 'i');
  const other = [...String(label).matchAll(/\b(20\d\d)\b/g)].some((m) => m[1] !== yr);
  if (other) return null;
  const hits = opts.filter((o) => re.test(o) && (!/\b20\d\d\b/.test(o) || new RegExp('\\b' + yr + '\\b').test(o)));
  return hits.length === 1 ? hits[0] : null;
}

/** Grad date in the form's own shape: an option (Dec 2027 / Fall 2027 / 2027), MM/YYYY, a date input, or prose. */
function gradAnswer(n, label, choice, pick, opts, e) {
  if (choice) return pick(/dec(ember)?\.?\s*2027|12\/2027/i) || pick(/fall\s*2027|winter\s*2027/i) || (opts.some((o) => /^\s*20\d\d\s*$/.test(o)) ? pick(new RegExp('^\\s*' + (e.gradYear || '2027') + '\\s*$')) : null);
  if (n.kind === 'date') return e.gradDateExact || null;
  if (/mm\s*\/\s*yyyy|mm\/yy/i.test(label + ' ' + (n.placeholder || ''))) return e.gradMonthYear || null;
  if (/\byear\b/i.test(label)) return e.gradYear || null;
  return e.graduation || null;
}

/** "able to start between January and September 2027": yes only when the window holds the owner's start month. */
function startWindowFits(label, earliestStart) {
  const t = label.toLowerCase();
  const found = MONTH3.map((m, i) => [t.search(new RegExp('\\b' + m)), i]).filter(([at]) => at >= 0).sort((x, y) => x[0] - y[0]);
  const want = MONTH3.indexOf(String(earliestStart || '').slice(0, 3).toLowerCase());
  if (found.length < 2 || want < 0 || !/2027/.test(t)) return false;
  return found[0][1] <= want && found[found.length - 1][1] >= want + 3; // covers a full summer from the start month
}

function isSalaryAmountQuestion(label) {
  const t = String(label || '');
  if (!/salary|compensation|pay|hourly rate|wage/i.test(t)) return false;
  if (/willing|accept|comfortable|okay|ok with|agree|aware|acknowledge|understand/i.test(t)) return false;
  // "Is the posted salary range within your desired salary range?" is yes/no too (Willowcrest 2026-10-08 got "$40/hour").
  if (/^\s*(is|are|does|do)\b/i.test(t) && /\b(within|fits?|in line with|match(es)?)\b/i.test(t)) return false;
  return /expect|desired|requirement|what|target|range you|your (salary|pay|rate)/i.test(t);
}

/** Conflict-of-interest disclosures (owner rule: always No). Not prior employment or referrals. */
/** "Are you / Do you have / Is there ..." asking for a fact, not asking him to agree / acknowledge / certify something. */
function isFactQuestion(label) {
  const l = String(label || '').trim();
  return /^(are|do|have|has|is|were|was|did|will|would|could) (you|there|any)\b/i.test(l) && !/\b(agree|agrees|agreed|agreeing|consent\w*|acknowledg\w*|certif\w*|accept\w*|understand|understood|authori[sz]\w*|attest\w*|confirm\w*|read)\b/i.test(l.replace(/\bability to accept\b/ig, ''));
}

function isConflictQuestion(label) {
  const t = String(label || '');
  // Not when it names a place he worked ("any family members ever worked for Quillstone?"), nor when HE is the one who
  // worked / was employed there: those are employment history, answered from the facts or by the owner.
  if (workedAt(t) || /\b(have|did|were|had|are|do) you\b(?: or (?:any |your )?(?:family members?|relatives?|spouse))?\s+(?:ever |previously |formerly |currently )*(?:worked|been employed|employed|interned)\b/i.test(t)) return false;
  return (
    /conflict of interest|outside business|outside employment (or |and |\/ ?)?activit|(negotiate|influence|sign)\b.{0,40}\b(commercial|government) contracts|(government|regulatory) (office|agency|body)\b.{0,40}\boversight|oversight over|investment (that is )?greater than|greater than 5\s?%|intellectual property|government official|personal\/familial relationship|familial relationship|close personal relationship/i.test(t) ||
    /(related to|relatives?|family members?)\b.*\b(anyone|employees?|employed|work(s|ed|ing)? (at|for))/i.test(t)
  );
}

// Questions that exist to catch bots ("What is to the immediate left of your computer? If this is a bot, say
// 'Mona Lisa'", Embercrest 2026-10-09): only the owner can answer them truthfully, so they always go to him.
const HUMAN_CHECK = /\b(?:if|in case) (?:you are|you're|this is|you be) (?:an? )?(?:bot|robot|ai|llm|language model)\b|\bare you (?:a )?(?:human|robot|bot)\b|prove (?:that )?you(?:'re| are) (?:a )?human|not a (?:ro)?bot\b/i;
const AI_POLICY = /\bAI\b.*\b(policy|use|assist)|artificial intelligence|generative|chatgpt|llm/i;
// Same pattern as extension/agent/page.js OPT_IN (job alerts, marketing, "other roles").
const OPT_IN = /\b(receive|send me|get|sign me up for)\b.{0,40}\b(updates?|alerts?|notifications?|newsletters?|marketing|promotions?|promotional|communications?|offers|news|emails? about)|\bmarketing\b|newsletter|job alerts?|talent (community|network|pool|pipeline)|\b(consider|contact|notify) me\b.{0,30}\b(other|future|similar|new)\b|future (job |career )?opportunit|new job opportunit|other (open )?(roles|positions|jobs|opportunit)|similar (roles|positions|jobs)|\bsubscribe\b|text messages?|\bsms\b/i;
const NEGATIVE = /^(no\b|i do not|i don'?t|do not|don'?t|opt out|not interested)/i;
const POSITIVE = /^(yes|i (will )?(have )?read|i agree|agree|i accept|accept|acknowledge|i acknowledge|acknowledge\/confirm|confirm|i confirm|i consent|consent|i certify|i understand|understood|ok)\b/i;

const CHOICE_KIND = /^(checkbox|checkboxes|radio|select|combobox|buttons)$/;

/**
 * Owner rule (2026-10-08): never opt in to job alerts / marketing / texts / "other roles". What to do with an
 * opt-in question given its choices: its "no" option; else an optional one is left alone (`skip`) and a
 * required one goes to the owner (`need`). Audit 2026-10-08: a required opt-in box fell through to the
 * consent rule and was ticked. null: not an opt-in choice (a phone box that mentions texts is still a phone box).
 */
function optInOutcome(n, options) {
  if (!(n.optIn || OPT_IN.test(n.label || '')) || !CHOICE_KIND.test(n.kind || '')) return null;
  const no = (options || []).find((o) => NEGATIVE.test(String(o).trim()));
  if (no) return { value: no };
  if (!n.required) return { skip: true };
  return { need: { ...n, type: 'opt_in_required', note: 'required opt-in box: the owner decides' } };
}

/** Runs whose Address Line 1 suggestion was just picked: Oracle then fills ZIP / City / State / County a moment later. */
const ADDRESS_PICKED = new WeakSet();

/**
 * What to type into a search box to make a long / async list show the profile's answer, per label.
 * [] for a label that is not one of the profile-driven dropdowns.
 */
function searchTerms(n, p) {
  const label = String(n.label || '').replace(/[*✱:\s]+$/, '').trim();
  const pr = (p && p.profile) || {};
  const short = label.length <= 60;
  const home = !NOT_HOME.test(`${n.section || ''} ${n.label || ''}`);
  if (short && home && STATE_LABEL.test(label) && pr.state) {
    const raw = String(pr.state).trim();
    const code = STATES[raw.toUpperCase()] ? raw.toUpperCase() : Object.keys(STATES).find((k) => STATES[k].toLowerCase() === raw.toLowerCase());
    return code ? [STATES[code]] : [];
  }
  if (short && home && COUNTRY_LABEL.test(label) && pr.country) return [/^usa?$/i.test(String(pr.country).trim()) ? 'United States' : String(pr.country)];
  if (short && home && PHONE_CODE_LABEL.test(label) && pr.country) return [String(pr.country)];
  if (short && MAJOR_LABEL.test(label) && !/\b(high school|secondary)\b/i.test(`${n.section || ''} ${label}`) && pr.major) return [pr.major, 'Other'];
  if (isHowHeard(n.label) && ((p && p.extras) || {}).howHeard) return [p.extras.howHeard];
  return [];
}

/** Read a dropdown again with a search term typed in, until the profile has an answer in what it shows. */
async function searchAnswer(run, n, p) {
  if (!/select|combobox/.test(n.kind || '')) return null;
  const { frameId, ref } = splitRef(n.ref);
  for (const term of searchTerms(n, p).slice(0, 2)) {
    const opts = await call(run.tabId, frameId, 'options', { ref, query: term }, 30000).catch(() => null);
    if (!Array.isArray(opts) || !opts.length) continue;
    const pa = profileAnswer({ ...n, options: opts }, p);
    if (pa) return { value: pa.value, query: pa.query || term };
  }
  return null;
}

/** The run's company and page, as the rules that need to know whose form this is want them. */
const ctxOf = (run) => ({ company: run.company, url: run.lastUrl || run.url });
/** Do two answers say the same thing (both Yes, both No, both a decline, or both just a value)? */
const sameMeaning = (a, b) => answerMeaning(a) === answerMeaning(b);

/** A second answer for a question once the page has named its real options; never one that contradicts what was tried. */
function reanswer(n, p, run, tried) {
  const mapped = optionFor(tried, n.options);
  if (mapped && mapped !== tried) return { value: mapped };
  const alt = (() => {
    const pa = profileAnswer(n, p);
    if (pa) return pa;
    const sa = standardAnswer(n, p, ctxOf(run));
    if (sa) return { value: sa.value };
    const la = logisticsAnswer(n, p, ctxOf(run));
    return la ? { value: la } : null;
  })();
  return alt && sameMeaning(tried, alt.value) ? alt : null;
}

/**
 * Needs the driver can settle without asking: bank answers Formhand could not
 * place, owner policy (consent), signature name/date when consent is on.
 * Returns the needs that are left.
 */
async function autoResolve(run, needs) {
  const p = D.profile();
  const left = [];
  run.reviewed = run.reviewed || [];
  for (const n of needs) {
    const { frameId, ref } = splitRef(n.ref);
    let value = null;
    let query;
    const label = n.label || '';
    if (n.review) {
      // Low-confidence fill: reported once for a check against the facts, then trusted as checked.
      if (n.consent && p.policy.autoConsent) continue;
      if (run.reviewed.includes(label)) continue;
      run.reviewed.push(label);
      left.push({ ...n, type: 'review' });
      continue;
    }
    // Topics the owner chose not to answer (profile.json extras.declined, e.g. "high school"):
    // not asked again; reported so Claude can tell him the form wants it.
    const declined = ((p.extras || {}).declined || []).find((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(label));
    if (declined) {
      left.push({ ...n, declined, note: `the owner declined to give "${declined}" info` });
      continue;
    }
    if (HUMAN_CHECK.test(label)) {
      left.push({ ...n, type: 'human_check', note: 'bot-check question: only the owner can answer it' });
      continue;
    }
    if (AI_POLICY.test(label)) {
      left.push({ ...n, aiPolicy: true });
      continue;
    }
    // Owner rule (2026-10-08): never opt in. A question with a way to say no gets it; an optional
    // box is left unticked; a required one is the owner's call (never the consent rule's).
    const optIn = n.optIn || OPT_IN.test(label);
    if (optIn && CHOICE_KIND.test(n.kind || '')) {
      const opts = n.options || (n.kind === 'checkbox' ? [] : (await call(run.tabId, frameId, 'options', { ref }, 20000).catch(() => null)) || []);
      const out = optInOutcome(n, opts);
      if (out.skip) continue;
      if (out.need) {
        left.push(out.need);
        continue;
      }
      value = out.value;
    }
    // A yes / no FACT question that merely mentions an agreement ("Are you aware of any legal restrictions ..., such as
    // an agreement with your current or former employer?", QUARRYHALL 2026-10-09: answered Yes) is not a consent box.
    if (!value && n.consent && !optIn && p.policy.autoConsent && !isFactQuestion(label)) {
      if (n.kind === 'checkbox') value = 'yes';
      else if (/^(text|textarea)$/.test(n.kind || '')) value = /name|signature|sign/i.test(label) ? p.extras.fullName : null;
      else {
        const opts = n.options || (await call(run.tabId, frameId, 'options', { ref }, 20000).catch(() => null)) || [];
        value = opts.find((o) => POSITIVE.test(o)) || (opts.length === 1 ? opts[0] : null);
      }
    }
    // A bare "Date" next to the typed name on a self-identify form (Workday CC-305, DUNVALE 2026-10-09) is the signature date.
    const sigDate = /(today'?s date|signature date|date signed|date of signature)/i.test(label) || (n.signature && /date/i.test(`${label} ${n.placeholder || ''}`)) || (/^date\*?$/i.test(label.trim()) && (/self.?identif|disabilit|voluntary (self|disclos)/i.test(n.section || '') || needs.some((m) => (m.options || []).some((o) => /\bdisabilit/i.test(o)))));
    // Workday's self-identify step signs with a bare "Name*" (DUNVALE 2026-10-09); Workday's own name fields say First / Last.
    const sigName = /^name\*?$/i.test(label.trim()) && (/self.?identif|disabilit/i.test(n.section || '') || /myworkdayjobs\.com|\.workday\.com/i.test(run.lastUrl || run.url || ''));
    if (!value && p.policy.autoConsent && !sigDate && (n.signature || sigName || /(electronic )?signature|type your (full |legal )?name|sign(ed)? (your )?name/i.test(label))) value = p.extras.fullName;
    if (!value && p.policy.autoConsent && sigDate) value = /dd\/mm/i.test(n.placeholder || '') ? today('dmy') : today(n.kind);
    // Salary: only a question asking for the amount gets the number. "Are you willing to accept the posted
    // range?" is a yes/no question (Willowvale got "$40/hour, negotiable" there): bank / owner.
    if (!value && isSalaryAmountQuestion(label) && p.extras.salaryExpectation) {
      value = n.kind === 'number' ? p.extras.salaryHourly || null : p.extras.salaryExpectation;
    }
    // Conflict of interest (relationships with employees / vendors, outside business, investments, IP,
    // government officials): the owner's standing answer is No (2026-10-07).
    if (!value && p.extras.conflictOfInterest && isConflictQuestion(label)) {
      const opts = n.options || [];
      value = opts.length ? opts.find((o) => /^no\b/i.test(o)) || null : /select|combobox|radio|buttons|checkboxes/.test(n.kind || '') ? null : p.extras.conflictOfInterest;
    }
    // "How did you hear about us?" maps the standing answer onto the list (Pinecrest has no LinkedIn option, only
    // "Social Networking"): ahead of the bank, whose plain "LinkedIn" matches no option there.
    if (!value && isHowHeard(n.label)) {
      // A Workday prompt may hold categories ("Online" > "LinkedIn", Thornby 2026-10-09): its options read fresh
      // come back as "Category > Leaf" paths, and only a leaf is an answer.
      if (/myworkdayjobs\.com|\.workday\.com/i.test(run.lastUrl || run.url || '') && /select|combobox/.test(n.kind || '')) {
        const tree = await call(run.tabId, frameId, 'options', { ref }, 60000).catch(() => null);
        if (Array.isArray(tree) && tree.some((o) => /\s>\s/.test(o))) n.options = tree;
      }
      let pa = profileAnswer(n, p);
      // A list that is not read yet (Greenhouse / Workday search boxes, iCIMS ajax menus): open it, else search it by name.
      if (!pa && /select|combobox/.test(n.kind || '') && (!n.options || !n.options.length)) {
        n.options = await call(run.tabId, frameId, 'options', { ref }, 20000).catch(() => undefined);
        pa = n.options && n.options.length ? profileAnswer(n, p) : null;
        if (!pa) pa = await searchAnswer(run, n, p);
      }
      if (pa) ({ value, query } = pa);
    }
    // The bank's stored answer, checked against the form's own list when we have it (optionFor): "Fall 2027" on a
    // [May 2027, December 2027] list must not become May. A miss falls through to the other sources.
    let bankMiss = null;
    if (!value) {
      const hit = D.lookup(n, run.company);
      if (hit) {
        const listed = /^(select|combobox|radio|buttons)$/.test(n.kind || '') && n.options && n.options.length;
        let mapped = listed ? optionFor(hit.answer, n.options) : hit.answer;
        // A date input cannot take "Fall 2027": a bank answer without day / month digits goes to the date rules below.
        if (n.kind === 'date' && !/\d{1,2}[\/.-]\d{1,2}|\d{4}-\d{2}/.test(String(hit.answer))) mapped = null;
        if (mapped) value = mapped;
        else if (hit.answer) bankMiss = hit.answer;
      }
    }
    if (!value && n.dialCode && p.profile.phone) {
      // International phone widget: it keeps a number only after its dial code.
      value = `${n.dialCode} ${String(p.profile.phone).replace(/^\+?1[\s-]*(?=\(?\d{3})/, '')}`;
    }
    if (!value) {
      const pa = profileAnswer(n, p);
      if (pa) ({ value, query } = pa);
    }
    if (!value && /select|combobox|radio|checkboxes|buttons/.test(n.kind || '')) {
      // An empty list is an ajax menu not opened yet (iCIMS Country / State / sponsorship, 2026-10-08): open it.
      let opened = false;
      if ((!n.options || !n.options.length) && /select|combobox/.test(n.kind)) {
        n.options = await call(run.tabId, frameId, 'options', { ref }, 20000).catch(() => undefined);
        opened = true;
        // Profile facts that need the list (State "VA" vs "Virginia", Country, Discipline -> Other).
        const pa = n.options && n.options.length ? profileAnswer(n, p) : null;
        if (pa) ({ value, query } = pa);
      }
      // A search-as-you-type list shows only its first entries (iCIMS States, Greenhouse Discipline, Workday
      // "How did you hear"): ask it for the answer by name.
      if (!value && (opened || n.kind === 'combobox')) {
        const sa = await searchAnswer(run, n, p);
        if (sa) ({ value, query } = sa);
      }
      if (!value) {
        const sa = standardAnswer(n, p, ctxOf(run));
        if (sa) value = sa.value;
      }
    }
    if (!value) value = logisticsAnswer(n, p, ctxOf(run));
    // The bank's answer found no option on this list. Another source may word it differently ("Fall 2027" ->
    // "December 2027") but must not contradict it: a stored Yes never becomes a rule's No.
    if (value != null && bankMiss != null && !sameMeaning(bankMiss, value)) {
      left.push({ ...n, bank: bankMiss, tried: value, note: 'the stored answer names none of the listed options and the other rules answer it differently' });
      continue;
    }
    if (value == null && bankMiss != null) {
      left.push({ ...n, bank: bankMiss, note: 'the stored answer names none of the listed options' });
      continue;
    }
    if (value == null) {
      left.push(n);
      continue;
    }
    // Never claim a sanctioned / foreign country for the owner: an answer naming one is his to give.
    if (COUNTRY_RISK.test(fuzzy(value))) {
      left.push({ ...n, tried: value, note: 'the answer names a sanctioned / foreign country: the owner answers this' });
      continue;
    }
    const attempt = (v, qy) => call(run.tabId, frameId, 'set', { ref, value: v, query: qy, autoConsent: p.policy.autoConsent }, 30000);
    try {
      let res = await attempt(value, query);
      if (res && res.ok) {
        if (query && /address/i.test(label)) ADDRESS_PICKED.add(run);
        // Kept on the run: what the driver answered on its own, page by page (an audit needs it; Cedarhall 2026-10-09).
        (run.autoAnswers = run.autoAnswers || {})[label.slice(0, 300)] = value;
        continue;
      }
      // The page listed the options it has: map the answer onto them once more (the stored value was a variant).
      let alt = res && Array.isArray(res.options) && res.options.length ? reanswer({ ...n, options: res.options }, p, run, value) : null;
      // Still nothing: the visible part of a long list may just lack it (State, Country, Discipline): search for it by name.
      if (!(alt && alt.value) && res && res.error && /select|combobox/.test(n.kind || '')) alt = await searchAnswer(run, n, p);
      if (alt && alt.value && (alt.value !== value || (alt.query && alt.query !== query))) {
        const res2 = await attempt(alt.value, alt.query);
        if (res2 && res2.ok) continue;
        value = alt.value;
        res = res2;
      }
      left.push({ ...n, tried: value, error: res && res.error, options: (res && res.options) || n.options });
    } catch (err) {
      left.push({ ...n, tried: value, error: err.message });
    }
  }
  return left;
}

/* ------------------------------------------------------------------ */
/* Steps                                                                */
/* ------------------------------------------------------------------ */

async function stepLanding(run, snap) {
  const btn = findApply(snap, { hasAccount: !!D.accounts()[S.accountKey(snap.url, Object.keys(D.accounts()))] });
  if (!btn) return stop(run, 'blocked', 'no Apply button found on this page', snap);
  log(run, 'landing', `press "${btn.text}"`);
  const before = signature(snap);
  const since = Date.now();
  await click(run, btn.ref, { tabWait: 1500 });
  const after = await waitChange(run, before, 15000);
  // An Apply link whose tab opened after the poll: follow it now instead of pressing Apply a second time.
  if (!after || signature(after) === before) {
    if (await followSpawned(run, since)) return null;
    // Workday's Apply ignoring a plain click (QUARRYHALL 2026-10-09): press its adventureButton / overlay instead.
    await workdayPress(run, btn, before, 15000);
  }
  return null;
}

/** Needs the owner already answered by hand (`jobctl answer`) and the page still holds: not asked again. */
function dropHandAnswered(run, needs, snap) {
  const hand = run.handAnswers || {};
  if (!snap || !Object.keys(hand).length) return needs;
  const filled = new Set(formFields(snap).filter((f) => f.value && hand[f.label] != null).map((f) => f.label));
  return needs.filter((n) => n.type || n.kind === 'file' || !filled.has(n.label));
}

function emailSignInButton(snap) {
  return snap.buttons.find((b) => b.aid === 'SignInWithEmailButton' || /^sign in with email$/i.test(b.text || ''));
}

async function stepAuthChooser(run, snap) {
  run.chooserAttempts = (run.chooserAttempts || 0) + 1;
  if (run.chooserAttempts > 2) return stop(run, 'blocked', '"Sign in with email" does not open the sign-in form', snap);
  const btn = emailSignInButton(snap);
  log(run, 'auth', `press "${btn.text}"`);
  const before = signature(snap);
  await click(run, btn.ref, { tab: false });
  await waitChange(run, before, 15000);
  return null;
}

async function stepEmailGate(run, snap) {
  const field = formFields(snap)[0];
  const { frameId, ref } = splitRef(field.ref);
  run.gateAttempts = (run.gateAttempts || 0) + 1;
  if (run.gateAttempts > 2) return stop(run, 'blocked', 'the email step does not move on', snap);
  await call(run.tabId, frameId, 'set', { ref, value: D.profile().profile.email });
  const btn = snap.buttons.find((b) => b.frame === frameId && (NEXT.test(b.text) || /^(submit|go|start)$/i.test(b.text)));
  if (!btn) return stop(run, 'blocked', 'email step: no Next button found', snap);
  log(run, 'email', `enter email, press "${btn.text}"`);
  const before = signature(snap);
  await click(run, btn.ref, { tab: false });
  await waitChange(run, before, 15000);
  return null;
}

/**
 * Fill whatever Workday auth form is showing (email, password, verify password, the terms box when autoConsent is on)
 * with the keyring's password and press NOTHING, so the owner only taps (owner, 2026-10-09: a blank Sign In page after a
 * Create Account left him nothing to do). Filling is not a sign-in attempt: no lockout risk. `toSignup`: on a Sign In
 * page, first switch to the Create Account form (the link, never the NoCaptcha button) so his one tap creates it.
 * Best effort: never throws.
 */
async function prefillAuth(run, site, email, opts) {
  try {
    const password = S.get(site);
    if (!password) return false;
    let snap = await snapshot(run.tabId);
    if (opts && opts.toSignup && snap.signals.passwordFields === 1) {
      const to = snap.buttons.find((b) => TO_SIGNUP.test(b.text || '') && b.aid !== 'click_filter' && !b.chrome);
      if (to) {
        const before = signature(snap);
        await click(run, to.ref, { tab: false });
        snap = (await waitChange(run, before, 10000)) || (await snapshot(run.tabId));
      }
    }
    const frame = snap.frames.find((f) => f.signals && f.signals.passwordFields > 0);
    if (!frame) return false;
    const res = await call(run.tabId, frame.frameId, 'authFill', { email, password });
    if (res && res.uncheckedBoxes && res.uncheckedBoxes.length && D.profile().policy.autoConsent && !(res.requiredOptIns || []).length) {
      for (const b of res.uncheckedBoxes) await call(run.tabId, frame.frameId, 'set', { ref: b.ref, value: 'yes', autoConsent: true });
    }
    log(run, 'auth', `prefilled the ${snap.signals.passwordFields >= 2 ? 'Create Account' : 'Sign In'} form on ${site} for the owner's tap`);
    return true;
  } catch (err) {
    log(run, 'auth', `prefill failed on ${site}: ${String(err.message).slice(0, 120)}`);
    return false;
  }
}

/**
 * What the page shows after the driver pressed Workday's Create Account (docs/SITE-NOTES.md 2026-10-09):
 *   verify    a "verify your account / check your email" notice appeared (the press worked: the link is in Gmail)
 *   proceeded signed in and on the application form (AmFam, Driftgate went straight on)
 *   captcha   a visual captcha showed up
 *   error     the sign-up form is still here with an error
 *   flipped   the page is the Sign In form (fewer password boxes, no error: QUARRYHALL and the Oakgate did this)
 *   same      nothing happened yet
 * Pure: the snapshot from before the press and the one now.
 */
/** Errors on `now` that were not already on `before` (a sign-up page can show "invalid: Password" before anything is pressed). */
function newErrors(before, now) {
  const had = new Set(((before && before.signals && before.signals.errors) || []).map(String));
  return ((now && now.signals && now.signals.errors) || []).filter((e) => !had.has(String(e)));
}

function createOutcome(before, now) {
  if (!now) return 'same';
  const s = now.signals;
  if (s.captcha && s.captcha.length) return 'captcha';
  const pw0 = (before && before.signals.passwordFields) || 0;
  // The sign-up form itself may mention verifying; only a notice that is new, or one where the boxes are gone, counts.
  if (s.verifyEmail && (!(before && before.signals.verifyEmail) || s.passwordFields === 0)) return 'verify';
  if (s.passwordFields === 0) {
    const onForm = /^applyFlow/.test(s.workdayPage || '') || formFields(now).length >= 2;
    return onForm && !emailSignInButton(now) ? 'proceeded' : 'same';
  }
  if (newErrors(before, now).length) return 'error';
  if (s.passwordFields < pw0 || (now.buttons.some((b) => /^(sign ?in|log ?in)$/i.test(b.text || '') && !b.chrome) && s.passwordFields === 1)) return 'flipped';
  return 'same';
}

/**
 * Workday's NoCaptcha only counts a press on the transparent click_filter overlay as human (docs/ATS-FLOWS.md).
 * Owner's standing instruction (2026-10-09): the driver presses Create Account itself, ONCE per tenant, and the owner
 * taps only when the tenant ignores the scripted press (QUARRYHALL and the Oakgate did; AmFam and Driftgate did not).
 * The press is recorded (run.accountPressed[site] and the account record) BEFORE it happens, so no later pass,
 * `jobctl continue` or other run on the tenant presses again; a refused sign-up is never retried (lockout risk).
 */
async function stepWorkdayCreate(run, snap, ctx) {
  const { site, email, password, created, frameId, overlay } = ctx;
  run.accountPressed = run.accountPressed || {};
  const known = D.accounts()[site] || {};
  // Before handing off, the Create Account form is filled (switched to from a Sign In page if the tenant flipped):
  // the owner's one tap creates the account.
  const owner = async (why, extra, from) => {
    const filled = await prefillAuth(run, site, email, { toSignup: true });
    return stop(run, 'blocked', `Workday account for ${site}: ${why}`, from || snap, [{ type: 'workday_create_account', site, email, pressed: true, prefilled: filled, note: `scripted press ignored by this tenant; owner must tap Create Account once${filled ? ' (the form is filled: just tap it)' : ''}`, ...(extra || {}) }]);
  };

  if (snap.signals.captcha.length) {
    await shot(run, 'captcha');
    return stop(run, 'blocked', `captcha on the Workday sign-up for ${site} (${snap.signals.captcha.join(', ')}): solve it in the browser window and press "Create Account", then \`jobctl continue\``, snap, [
      { type: 'workday_create_account', site, email, captcha: snap.signals.captcha, note: 'visual captcha: the owner solves it and presses Create Account' },
    ]);
  }
  const prior = run.accountPressed[site] || known.createPressedAt;
  if (prior) {
    return owner(`the driver already pressed Create Account (${prior}); not pressing again. If nothing came of it, tap "Create Account" once in the jobbot window, then \`jobctl continue <run> --owner\``, { pressedAt: prior });
  }
  const at = new Date().toISOString();
  run.accountPressed[site] = at;
  D.saveAccount(site, { email, created: at, verified: false, passwordCreated: created, createPressedAt: at });
  R.save(run);
  log(run, 'auth', `create account on ${site}: press "${overlay.text || 'Create Account'}" once`);
  const sBefore = snap;
  try {
    await click(run, q(frameId, overlay.ref), { tab: false });
  } catch (err) {
    // The press may or may not have gone through: either way no sign-in with the made-up password, and no second press.
    D.saveAccount(site, { viaOwnerClick: true, pendingOwnerClick: true, createIgnored: at, createIgnoredRun: run.id, createIgnoredContinues: run.continues || 0 });
    return owner(`pressing Create Account failed (${String(err.message).slice(0, 120)}); not pressing again. Tap "Create Account" once in the jobbot window, open the emailed link, then \`jobctl continue <run> --owner\``, { result: 'click_failed' });
  }
  let seen = null;
  let kind = 'same';
  const outcome = await pollPage(
    run,
    (now) => {
      seen = now;
      kind = createOutcome(sBefore, now);
      return kind !== 'same' ? kind : null;
    },
    TUNE.createWaitMs
  );
  const after = seen || snap;
  log(run, 'auth', `Create Account on ${site}: ${outcome || 'no change in 10 s'}`);
  if (outcome === 'verify') {
    D.saveAccount(site, { viaOwnerClick: false, verifyPending: true });
    return stop(run, 'needs_input', `Workday sent a verification email for ${site}: read it from Gmail (myworkday.com / otp.workday.com), open the link, then \`jobctl continue\``, after, [
      { type: 'email_verification', site, email, sender: 'myworkday.com / otp.workday.com', pageText: after.heading, note: 'Create Account was pressed by the driver; open the verification link from the email (Gmail in:anywhere from:otp.workday.com newer_than:1h), then continue' },
    ]);
  }
  if (outcome === 'proceeded') {
    // Straight onto the application: the account is real (the next run on this tenant signs in, never creates again).
    D.saveAccount(site, { viaOwnerClick: false, verified: true });
    return null;
  }
  if (outcome === 'captcha') {
    await shot(run, 'captcha');
    return stop(run, 'blocked', `captcha after pressing Create Account on ${site} (${after.signals.captcha.join(', ')}): solve it in the browser window, then \`jobctl continue\``, after, [
      { type: 'workday_create_account', site, email, pressed: true, captcha: after.signals.captcha, note: 'visual captcha after the press: the owner solves it' },
    ]);
  }
  // flipped back to Sign In, an error, or nothing in 10 s: the tenant ignored the press. Never press again, and
  // never sign in with the password that was just made up: the account probably does not exist (lockout).
  const errs = newErrors(sBefore, after);
  D.saveAccount(site, { viaOwnerClick: true, createIgnored: at, createIgnoredRun: run.id, createIgnoredContinues: run.continues || 0 });
  return owner(`the scripted Create Account press was ignored (${outcome || 'no change'}${errs.length ? ': ' + errs.join(' | ').slice(0, 160) : ''}). Check Gmail first (from:<tenant>@otp.workday.com newer_than:1h, ~3 min): the press often worked anyway (DRIFTRIDGE 2026-10-09); a verify email = open its link, then \`jobctl continue <run> --owner\`. Only no email: the owner taps "Create Account" once in the jobbot window`, { result: outcome || 'same', errors: errs }, after);
}

/** The page an emailed reset link opens: new-password boxes, no email box, a reset / change / new password heading. */
function isResetPage(snap) {
  const t = `${snap.heading || ''} ${snap.title || ''} ${snap.fields.map((f) => f.label).join(' ')}`;
  return snap.signals.passwordFields >= 1 && /\b(reset|change|new|create new|choose a new) password\b/i.test(t) && !snap.fields.some((f) => f.kind === 'email' || /e-?mail/i.test(f.label || ''));
}

/**
 * Wrong stored password on a real account: press "Forgot your password?", enter the email, submit, and stop for the
 * reset link (Claude opens it from Gmail: `jobctl open "<link>"`, then `jobctl continue`). Null when the site has no
 * reset button (the old stop applies).
 */
async function requestPasswordReset(run, snap, site, email) {
  const forgot = snap.buttons.find((b) => /forgot (your )?password|reset (your )?password|trouble signing in/i.test(b.text || ''));
  if (!forgot) return null;
  log(run, 'auth', `stored password refused on ${site}: press "${forgot.text}" (reset by email)`);
  let before = signature(snap);
  await click(run, forgot.ref, { tab: false });
  let page = (await waitChange(run, before, 10000)) || (await snapshot(run.tabId));
  const box = formFields(page).find((f) => f.kind === 'email' || /e-?mail/i.test(f.label || ''));
  if (box) {
    const { frameId, ref } = splitRef(box.ref);
    await call(run.tabId, frameId, 'set', { ref, value: email });
    const go = page.buttons.find((b) => b.frame === frameId && /^(submit|reset( password)?|send( (reset )?(link|email))?|continue|next)$/i.test(b.text || '') && !b.chrome);
    if (go) {
      before = signature(page);
      await click(run, go.ref, { tab: false });
      page = (await waitChange(run, before, 10000)) || page;
    }
  }
  D.saveAccount(site, { resetPending: new Date().toISOString() });
  return stop(run, 'needs_input', `password reset requested for ${site}: open the emailed reset link, then \`jobctl continue\``, page, [
    { type: 'email_verification', site, email, reset: true, sender: 'myworkday.com / otp.workday.com', note: 'password reset: Gmail from:(myworkday.com OR otp.workday.com) newer_than:1h, `jobctl open "<link>"`, then `jobctl continue`' },
  ]);
}

/** The reset link's page: a fresh password into the keyring first, then into the form, then its button. */
async function stepPasswordReset(run, snap, site) {
  const password = S.generate();
  S.set(site, password);
  const frame = snap.frames.find((f) => f.signals && f.signals.passwordFields > 0) || snap.frames[0];
  const res = await call(run.tabId, frame.frameId, 'authFill', { email: D.profile().profile.email, password });
  const btns = (res && res.buttons) || [];
  const go = btns.find((b) => /^(submit|reset( password)?|change password|save|update( password)?|continue|set password)$/i.test(b.text || ''));
  if (!go) return stop(run, 'needs_input', `reset page on ${site}: new password filled (keyring updated) but no button to press`, snap, [{ type: 'password_reset', site }]);
  log(run, 'auth', `reset password on ${site}: new password in the keyring, press "${go.text}"`);
  D.saveAccount(site, { resetPending: false, passwordResetAt: new Date().toISOString(), verified: true, signInRefused: false });
  const before = signature(snap);
  await click(run, q(frame.frameId, go.ref), { tab: false });
  await waitChange(run, before, 15000);
  return null;
}

/** A sign-in went through: the account is real and verified; clear what a press the tenant ignored had flagged. */
function markSignedIn(site) {
  const acc = D.accounts()[site];
  if (acc && (acc.createIgnored || acc.viaOwnerClick || acc.pendingOwnerClick || acc.signInRefused || acc.verified !== true)) {
    D.saveAccount(site, { createIgnored: null, createIgnoredRun: null, signInRefused: false, viaOwnerClick: false, pendingOwnerClick: false, verifyPending: false, verified: true });
  }
}

/** A verification notice is proof an account exists now (the owner's tap worked): sign-in is allowed again there. */
function noteVerifySeen(snap) {
  const site = S.accountKey(snap.url, Object.keys(D.accounts()));
  const acc = D.accounts()[site];
  if (acc && acc.createIgnored) D.saveAccount(site, { createIgnored: null, signInRefused: false, verifyPending: true, viaOwnerClick: false, pendingOwnerClick: false });
}

async function stepAuth(run, snap) {
  const p = D.profile();
  const site = S.accountKey(snap.url, Object.keys(D.accounts()));
  const email = p.profile.email;
  const account = D.accounts()[site];
  const fieldsText = snap.fields.map((f) => f.label).join(' ');
  const isSignup = snap.signals.passwordFields >= 2 || /verify (new )?password|confirm (new )?password|re-?enter password/i.test(fieldsText);
  // iCIMS "Candidate Profile" (YARROWMERE, 2026-10-08): the create-login boxes sit inside the whole profile form,
  // with one "Submit Profile" button and no create-account button. Fill the password, then run it as a form.
  if (isSignup && isCombinedSignupForm(snap)) {
    const { password, created } = S.getOrCreate(site);
    const formFrame = snap.frames.find((f) => f.signals && f.signals.passwordFields > 0) || snap.frames[0];
    await call(run.tabId, formFrame.frameId, 'authFill', { email, password });
    if (!account) D.saveAccount(site, { email, created: new Date().toISOString(), verified: false, passwordCreated: created });
    log(run, 'auth', `sign-up boxes are part of the profile form on ${site}: filled, continuing as a form`);
    return stepForm(run, await snapshot(run.tabId));
  }
  run.authAttempts++;
  if (run.authAttempts > 4) return stop(run, 'needs_input', 'sign-in keeps failing', snap, [{ type: 'auth_failed', site, email, errors: snap.signals.errors }]);

  // The page the emailed reset link opens (owner 2026-10-09, memory password-reset-ok): a new password goes into the
  // keyring and the form. Only after the driver itself asked for the reset on this site (account.resetPending).
  if (isResetPage(snap) && account && account.resetPending) return stepPasswordReset(run, snap, site);

  if (!isSignup && !account && !S.get(site)) {
    // No account here yet: find the way to "Create Account".
    const to = snap.buttons.find((b) => TO_SIGNUP.test(b.text));
    if (to) {
      log(run, 'auth', `no account for ${site}: press "${to.text}"`);
      const before = signature(snap);
      await click(run, to.ref, { tab: false });
      await waitChange(run, before, 10000);
      return null;
    }
  }
  if (!isSignup && account && !S.get(site)) return stop(run, 'needs_input', `account exists for ${site} but no password in the keyring`, snap, [{ type: 'password_reset', site, email }]);

  // A tenant that ignored the scripted Create Account press has no account behind the password we made up: a
  // sign-in there only counts toward a lockout. Allowed once, and only after a human `continue` in this run (the
  // owner tapped Create Account and the link was opened); never again once it was refused.
  if (!isSignup && account && account.createIgnored) {
    // Only the owner saying so unlocks it: `jobctl continue <run> --owner` (run.ownerTapAt), never a bare continue or
    // `answer --continue`. A verify notice or a signed-in page (noteVerifySeen / markSignedIn) lifts the flag by itself.
    const humanSince = account.createIgnoredRun === run.id && !!run.ownerTapAt && String(run.ownerTapAt) > String(account.createIgnored);
    if (!humanSince || account.signInRefused) {
      // The Sign In page is filled (no press): if the owner already created and verified the account he taps Sign In.
      await prefillAuth(run, site, email);
      return stop(run, 'blocked', `Workday account for ${site}: Create Account was ignored earlier and the owner has not tapped it yet; not signing in (lockout risk). Check Gmail first (from:<tenant>@otp.workday.com newer_than:1h, ~3 min): the press often worked anyway (DRIFTRIDGE 2026-10-09); a verify email = open its link, then \`jobctl continue <run> --owner\`. Only no email: the owner taps "Create Account" once in the jobbot window`, snap, [
        { type: 'workday_create_account', site, email, pressed: true, note: 'scripted press ignored by this tenant; owner must tap Create Account once' },
      ]);
    }
  }

  // A Create Account form on a tenant where he already has a working account (signed in before: UMBERMOOR, 2026-10-09):
  // switch to Sign In instead of pressing Create Account (which Workday ignores for an existing email).
  if (isSignup && account && S.get(site) && (account.verified === true || account.existed) && !account.createIgnored && !account.pendingOwnerClick && !account.signInRefused && !run.toSignInTried) {
    const to = snap.buttons.find((b) => /^(sign ?in|log ?in|already have an account\b.*)$/i.test(b.text || '') && b.aid !== 'click_filter' && !b.chrome);
    if (to) {
      run.toSignInTried = true;
      log(run, 'auth', `account already exists on ${site}: press "${to.text}" instead of Create Account`);
      const before = signature(snap);
      await click(run, to.ref, { tab: false });
      await waitChange(run, before, 10000);
      return null;
    }
  }

  const { password, created } = isSignup ? S.getOrCreate(site) : { password: S.get(site), created: false };
  if (!password) return stop(run, 'needs_input', `no password for ${site}`, snap, [{ type: 'password_reset', site, email }]);

  const formFrame = snap.frames.find((f) => f.signals && f.signals.passwordFields > 0) || snap.frames[0];
  const res = await call(run.tabId, formFrame.frameId, 'authFill', { email, password });
  // A sign-up that requires a job-alert / marketing box: never ticked here, the owner decides (audit 2026-10-08).
  if (res.requiredOptIns && res.requiredOptIns.length) {
    return stop(run, 'needs_input', 'the create-account form requires an opt-in box (alerts / marketing / texts): the owner decides', snap, res.requiredOptIns.map((b) => ({ type: 'opt_in_required', ref: q(formFrame.frameId, b.ref), label: b.label, kind: 'checkbox', required: true, note: 'required opt-in box: the owner decides' })));
  }
  if (res.uncheckedBoxes && res.uncheckedBoxes.length) {
    if (p.policy.autoConsent) {
      for (const b of res.uncheckedBoxes) await call(run.tabId, formFrame.frameId, 'set', { ref: b.ref, value: 'yes', autoConsent: true });
    } else if (isSignup) {
      return stop(run, 'needs_input', 'the create-account form has boxes to tick (terms / privacy)', snap, res.uncheckedBoxes.map((b) => ({ type: 'consent', ref: q(formFrame.frameId, b.ref), label: b.label })));
    }
  }
  const btns = res.buttons || [];
  // Workday NoCaptcha: only a click on the transparent click_filter overlay counts as human (docs/ATS-FLOWS.md).
  const overlay = btns.find((b) => b.aid === 'click_filter');
  if (overlay && isSignup) return stepWorkdayCreate(run, snap, { site, email, password, created, frameId: formFrame.frameId, overlay });
  const pick = overlay ? overlay : isSignup ? btns.find((b) => SIGNUP.test(b.text)) || btns.find((b) => /create|register|sign ?up/i.test(b.text)) : btns.find((b) => /^(sign ?in|log ?in)$/i.test(b.text)) || btns.find((b) => SIGNIN.test(b.text));
  if (!pick) return stop(run, 'blocked', 'filled the sign-in form but found no button to press', snap);
  if (isSignup) D.saveAccount(site, { email, created: new Date().toISOString(), verified: false, passwordCreated: created });
  log(run, 'auth', `${isSignup ? 'create account' : 'sign in'} on ${site}: press "${pick.text}"`);
  const before = signature(snap);
  await click(run, q(formFrame.frameId, pick.ref), { tab: false });
  const after = await waitChange(run, before, 20000);
  // Signed in (no password boxes left, no notice to verify): whatever an earlier ignored press flagged is over.
  // Only a real form page proves it (a blank page between sign-in and the wrong-password notice must not clear the
  // ignored-press guard: review 2026-10-09 saw a third sign-in click that way).
  const onForm = after && (/^applyFlow/.test(after.signals.workdayPage || '') || formFields(after).length >= 2);
  if (!isSignup && onForm && after.signals.passwordFields === 0 && !after.signals.verifyEmail && !after.signals.errors.length && signature(after) !== before) markSignedIn(site);
  if (after && after.signals.passwordFields > 0 && after.signals.errors.length) {
    const err = after.signals.errors.join(' | ');
    if (!isSignup && /wrong (email|password)|incorrect|invalid (email|password|credentials)|might be locked|locked/i.test(err)) {
      // One failed sign-in only: a retry can lock the account. Fresh accounts usually need the emailed link first.
      const acc = D.accounts()[site] || {};
      if (acc.createIgnored) D.saveAccount(site, { signInRefused: true });
      // A real account (signed in before) with a stored password the site now refuses: reset it from the email instead
      // of stopping (owner 2026-10-09, memory password-reset-ok). Once per site until the reset is used.
      if (!acc.createIgnored && !acc.resetPending && (acc.verified === true || acc.existed)) {
        const reset = await requestPasswordReset(run, after, site, email);
        if (reset) return reset;
      }
      // The boxes are filled again (no press) so the owner only taps Sign In once the account is verified.
      await prefillAuth(run, site, email);
      return stop(run, 'needs_input', 'sign-in was refused; not retrying (lockout risk)', after, [
        acc.verified === false ? { type: 'email_verification', site, email, note: 'account created this run and not verified yet: open the emailed link, then continue' } : { type: 'auth_failed', site, email, errors: after.signals.errors },
      ]);
    }
    if (/already (exists|registered|in use)|account (already )?exists/i.test(err)) {
      D.saveAccount(site, { email, existed: true });
      const to = after.buttons.find((b) => /^(sign ?in|log ?in|back to sign ?in)/i.test(b.text));
      if (to) await click(run, to.ref, { tab: false });
    }
  }
  return null;
}

/**
 * The page a file slot belongs to, for "uploaded once per page": the URL minus session params. iCIMS reloads its
 * profile form with a new query (`csrf=`, `uploadResume=1`), and a resume uploaded again there is
 * re-parsed over every answer already fixed on the form (Driftmere, 2026-10-08).
 */
function uploadPage(url) {
  try {
    const u = new URL(url);
    // iCIMS session / reload params; a real step param (?step=2) still makes a new page.
    for (const k of [...u.searchParams.keys()]) if (VOLATILE_QUERY.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    const q = u.searchParams.toString();
    return u.origin + u.pathname + (q ? '?' + q : '');
  } catch (e) {
    return String(url).split('#')[0];
  }
}
// iCIMS iframe layout params (bga / height / width / jan1offset / jun1offset: the width changes with the window, IRONFIELD
// 2026-10-09) made every continue a "new" page: the resume went up again and its parse overwrote the fixed history.
const VOLATILE_QUERY = /^(csrf|uploadResume|eem|code|ga|from|hashed|in_iframe|accept_gdpr|mobile|needsRedirect|_ga|utm_\w+|bga|height|width|jan1offset|jun1offset)$/i;

/**
 * Apply lib/history.js's plan on an iCIMS profile page. Sets first, then clears, then deletes (a delete can
 * re-render the form, so each delete button is found again by its text). The page counts as done once a fresh
 * plan finds nothing left to change, else it gets one more try. Returns { touched } when anything ran (stepForm
 * then drops needs that were settled or vanished with a deleted block).
 */
/**
 * A snapshot taken once the form holds still: same labels and values on two looks ~1.5 s apart, and at least
 * ~3 s after the first look (the parse can land after a quiet second). Max ~12 s.
 */
async function settledSnapshot(tabId, wait = 1500, tries = 8) {
  const sig = (s) => formFields(s).map((f) => `${f.label}=${f.value || ''}`).join('|');
  let prev = await snapshot(tabId).catch(() => null);
  for (let i = 0; prev && i < tries; i++) {
    await new Promise((r) => setTimeout(r, wait));
    const cur = await snapshot(tabId).catch(() => null);
    if (!cur) return prev;
    if (i >= 1 && sig(cur) === sig(prev)) return cur;
    prev = cur;
  }
  return prev;
}

/** Workday My Experience: delete work blocks the resume parser built from projects (once per page). */
async function fixWorkdayJunk(run, first, resumeFile) {
  // The cheap checks come from the snapshot the step started with; the page is only looked at again when they pass.
  if (first.signals.workdayPage !== 'applyFlowPage' || !first.fields.some((f) => /^company\b/i.test(f.label || ''))) return 0;
  const key = uploadPage(first.url) + '#junk';
  run.historyTries = run.historyTries || {};
  if (run.historyTries[key]) return 0;
  run.historyTries[key] = 1;
  const H = require('./history');
  const resume = H.resumeJsonFor(resumeFile, path.join(D.DATA_DIR, 'resumes'));
  if (!resume) return 0;
  const snap = await snapshot(run.tabId);
  const refs = H.workdayJunkBlocks(formFields(snap), snap.buttons, resume);
  let n = 0;
  for (const ref of refs) if (await click(run, ref, { tab: false }).then(() => true, () => false)) n++;
  if (n) log(run, 'fix', `deleted ${n} Workday work block(s) parsed from resume projects`);
  return n;
}

/** An iCIMS page (some companies embed it in an iframe under their own domain). */
function onIcims(snap) {
  return [snap.url, ...(snap.frames || []).map((f) => f.url)].some((u) => {
    try {
      return /\.icims\.com$/i.test(new URL(u).hostname);
    } catch (e) {
      return false;
    }
  });
}

async function fixParsedHistory(run, snap, resumeFile, p) {
  const out = { touched: false, fixed: new Set() };
  if (!onIcims(snap)) return out;
  const key = uploadPage(snap.url);
  run.historyTries = run.historyTries || {};
  if ((run.historyTries[key] || 0) >= 2) return out;
  const H = require('./history');
  const resume = H.resumeJsonFor(resumeFile, path.join(D.DATA_DIR, 'resumes'));
  // The resume parse lands a few seconds after the upload and re-renders the blocks (Ravenhaven 2026-10-08: a
  // rewrite of the first block only, then the parser wrote its own five blocks over it). Wait until the
  // form stops growing before planning.
  const fresh = await settledSnapshot(run.tabId);
  if (!resume || !fresh) return out;
  let plan = H.planHistory(formFields(fresh), fresh.buttons, resume, p);
  if (!plan.sets.length && !plan.clears.length && !plan.deletes.length && !plan.adds) return out;
  run.historyTries[key] = (run.historyTries[key] || 0) + 1;
  out.touched = true;
  const put = async (ref, value) => {
    const r = splitRef(ref);
    const res = await call(run.tabId, r.frameId, 'set', { ref: r.ref, value }, 30000).catch(() => null);
    return !!(res && res.ok);
  };
  let ok = 0;
  let cleared = 0;
  const apply = async (pl) => {
    for (const st of pl.sets) {
      if (await put(st.ref, st.value)) {
        ok++;
        out.fixed.add(st.ref);
      }
    }
    for (const c of pl.clears) if (await put(c.ref, '')) cleared++;
  };
  await apply(plan);
  const planned = plan.sets.length;
  // Jobs the form has no block for (an optional, empty Professional Experience): press Add, fill the new block, and
  // again until every resume job is there (the owner 2026-10-09: every application lists all four jobs).
  let added = 0;
  for (let k = 0; k < 6 && plan.adds > 0; k++) {
    const now = await snapshot(run.tabId).catch(() => null);
    const btn = now && now.buttons.find((b) => b.text === plan.addButton);
    if (!btn || !(await click(run, btn.ref, { tab: false }).then(() => true, () => false))) break;
    added++;
    const grown = await settledSnapshot(run.tabId, 700, 6);
    if (!grown) break;
    const before = plan.adds;
    plan = H.planHistory(formFields(grown), grown.buttons, resume, p);
    await apply({ sets: plan.sets, clears: plan.clears });
    if (plan.adds >= before) break; // the press added no block
  }
  let deleted = 0;
  for (const text of plan.deletes) {
    const now = await snapshot(run.tabId).catch(() => null);
    const btn = now && now.buttons.find((b) => b.text.toLowerCase() === text.toLowerCase());
    if (btn && (await click(run, btn.ref, { tab: false }).then(() => true, () => false))) deleted++;
  }
  // Done only when a fresh look finds nothing left to change; otherwise the next pass tries again (max 2).
  const check = await snapshot(run.tabId).catch(() => null);
  const again = check ? H.planHistory(formFields(check), check.buttons, resume, p) : null;
  if (again && !again.sets.length && !again.deletes.length) run.historyTries[key] = 2;
  log(run, 'fix', `work history from the resume: ${ok}/${planned} set, ${cleared} cleared, ${deleted}/${plan.deletes.length} extra block(s) deleted${added ? `, ${added} job block(s) added` : ''}${plan.note.length ? '; ' + plan.note.join('; ') : ''}`);
  return out;
}

/** The page's repeating history sections (JB.repeaters in every frame), refs qualified "<frame>:<ref>". */
async function readRepeaters(run) {
  const res = await C.page(run.tabId, 'repeaters', {}).catch(() => []);
  const out = [];
  for (const r of res || []) {
    if (!r || !r.result || r.error) continue;
    const fq = (ref) => (ref ? q(r.frameId, ref) : ref);
    const fl = (fields) => (fields || []).map((f) => ({ ...f, ref: fq(f.ref) }));
    for (const s of r.result.sections || []) {
      out.push({
        ...s,
        add: fq(s.add),
        entries: (s.entries || []).map((e) => ({ ...e, del: fq(e.del), edit: fq(e.edit), fields: fl(e.fields) })),
        open: s.open ? { ...s.open, save: fq(s.open.save), cancel: fq(s.open.cancel), fields: fl(s.open.fields) } : null,
      });
    }
  }
  return out;
}
const repSig = (secs) => JSON.stringify(secs.map((s) => [s.kind, s.add, s.entries.map((e) => [e.title, e.subtitle, e.invalid, e.fields.map((f) => f.value)]), s.open && s.open.fields.map((f) => f.label)]));

/** Poll the sections every 250 ms until they differ from `before` (a new block, the inline form, a saved tile), at most `ms`. */
async function waitRepeaters(run, before, ms) {
  const end = Date.now() + ms;
  let secs = await readRepeaters(run);
  while (repSig(secs) === before && Date.now() < end) {
    await sleep(POLL_MS);
    secs = await readRepeaters(run);
  }
  return secs;
}

/**
 * Work history, education and certifications on every application, even where the section is optional and empty
 * (the owner 2026-10-09: applications are much weaker without the jobs; Fernhaven's Oracle import left "Unnamed Major" and two
 * "Unnamed License" tiles with made-up dates). Workday My Experience, Oracle profile tiles, an Employment / Education
 * repeater on any other form. lib/history.js nextRepeaterAction plans one step at a time from JB.repeaters(); this
 * does it and looks again (max 60 steps). Once per page, a second pass only when the first left work undone. iCIMS
 * keeps its own planner (fixParsedHistory). Returns { touched, fixed: refs set, filled: refs of history boxes holding a value }.
 */
async function fillRepeaters(run, snap, resumeFile, p) {
  const out = { touched: false, fixed: new Set(), filled: new Set() };
  if (onIcims(snap)) return out;
  // Newer Workday tenants mark every step applyFlowPage (DUNVALE 2026-10-09): the My Experience step is known by its
  // heading or its Job Title / Company boxes.
  const wd = snap.signals.workdayPage === 'applyFlowMyExpPage' || (!!snap.signals.workdayPage && (/\bmy experience\b/i.test(snap.heading || '') || formFields(snap).some((f) => /^(job title|company|role description)\b/i.test(f.label || ''))));
  if (snap.signals.workdayPage && !wd) return out; // the other Workday steps hold no history
  const oracle = ORACLE_URL.test(snap.url || '');
  const hint = snap.buttons.some((b) => /^\+?\s*add\b/i.test(b.text || '')) || formFields(snap).some((f) => /^(company|employer)( name)?\b/i.test(f.label || ''));
  if (!wd && !oracle && !hint) return out;
  const key = uploadPage(snap.url) + '#history';
  run.historyTries = run.historyTries || {};
  if ((run.historyTries[key] || 0) >= 2) return out;
  run.historyTries[key] = (run.historyTries[key] || 0) + 1;
  const H = require('./history');
  const resume = H.resumeJsonFor(resumeFile, path.join(D.DATA_DIR, 'resumes'));
  if (!resume) return out;
  const facts = H.formFacts(resume, p);
  const memo = {};
  const done = {};
  const notes = [];
  const dateSets = [];
  let secs = await readRepeaters(run);
  let finished = false;
  for (let i = 0; i < 60 && secs.length; i++) {
    const act = H.nextRepeaterAction(secs, facts, memo);
    if (!act) {
      finished = true;
      break;
    }
    out.touched = true;
    const before = repSig(secs);
    const tag = `${act.kind} ${act.why}`;
    done[tag] = (done[tag] || 0) + 1;
    if (act.do === 'fill') {
      for (const st of act.sets) if (st.date || /^(start|end)(Year)?$/.test(st.key || '')) dateSets.push(st);
      for (const st of act.sets) {
        const r = splitRef(st.ref);
        let ok = false;
        // A choice worded another way on this form ("Jun" for "June", "Bachelors" for "Bachelor of Science").
        for (const v of [st.value, ...(st.alts || [])]) {
          const res = await call(run.tabId, r.frameId, 'set', { ref: r.ref, value: v }, 30000).catch(() => null);
          if (res && res.ok) {
            ok = true;
            break;
          }
        }
        if (ok) out.fixed.add(st.ref);
        else notes.push(`${act.kind} "${st.label}" would not take "${String(st.value).slice(0, 40)}"`);
      }
    } else {
      const r = splitRef(act.ref);
      await call(run.tabId, r.frameId, 'click', { ref: r.ref }).catch(() => null);
      if (act.why === 'cancel' && act.note) notes.push(act.note);
    }
    // A fill shows at once; an Add / Save / Delete re-renders (Oracle saves to the server): wait for the change.
    secs = await waitRepeaters(run, before, act.do === 'fill' ? 0 : 6000);
  }
  // A date typed into a panel Workday just added shows, yet the page says "From is required" on Save (Thornby / DUNVALE
  // 2026-10-09; the same value set a second time sticks): set each Workday date once more after the panel settled.
  if (wd && dateSets.length) {
    await new Promise((r) => setTimeout(r, 400));
    for (const st of dateSets) {
      const r = splitRef(st.ref);
      await call(run.tabId, r.frameId, 'set', { ref: r.ref, value: st.value }, 30000).catch(() => null);
    }
  }
  if (finished) run.historyTries[key] = 2;
  for (const s of secs) for (const e of [...s.entries, ...(s.open ? [{ fields: s.open.fields }] : [])]) for (const f of e.fields) if (f.value) out.filled.add(f.ref);
  if (out.touched) log(run, 'fix', `history sections (${secs[0] ? secs[0].ats : '?'}): ${Object.entries(done).map(([k, n]) => `${k} x${n}`).join(', ')}${finished ? '' : ' (unfinished)'}${notes.length ? '; ' + notes.slice(0, 6).join('; ') : ''}`);
  return out;
}

/** Workday: open each date's calendar and click the day it already shows (selected, else today). */
async function pickWorkdayDates(run, snap) {
  let picked = 0;
  const icons = snap.buttons.filter((b) => b.aid === 'dateIcon');
  const pickerDay = (s) => s.buttons.find((b) => /^datePickerSelected/.test(b.aid || '')) || s.buttons.find((b) => b.aid === 'datePickerSelectedToday');
  for (let i = 0; i < icons.length; i++) {
    const cur = i ? await snapshot(run.tabId) : snap;
    const icon = cur.buttons.filter((b) => b.aid === 'dateIcon')[i];
    if (!icon) break;
    await click(run, icon.ref, { tab: false });
    // The calendar opens within a render or two (was a fixed 1 s): wait for its day button, at most 2 s.
    const day = await pollPage(run, pickerDay, 2000);
    if (!day) continue;
    await click(run, day.ref, { tab: false });
    // ... and for it to close again (was a fixed 0.7 s), at most 1.5 s.
    await pollPage(run, (s) => !s.buttons.some((b) => /^datePicker/.test(b.aid || '')), 1500);
    picked++;
  }
  return picked;
}

const ORACLE_URL = /oraclecloud\.com|\/hcmUI\/CandidateExperience/i;
// Address-block fields that are optional by nature. Oracle sets aria-required on the whole address fieldset, so the
// snapshot calls them required (Quarrymere / Florida Blue / Cedarmere 2026-10-08: "Address Line 2", "Care Of" stopped every run);
// the label of a field that really is required carries a "*" ("Address Line 1 *", "ZIP Code *").
const OPTIONAL_BY_NATURE = /^(address line [23]|(2nd|3rd|second|third) address line|address [23]|care of|c\/o|tax district|po box)$/i;
function oracleOptional(f, url) {
  return ORACLE_URL.test(url || '') && !f.type && OPTIONAL_BY_NATURE.test(String(f.label || '').trim());
}

/** Needs whose field now holds a value in `snap` (matched by ref, else by a label that is unique on the page) are settled. */
function dropFilled(needs, snap) {
  if (!snap) return needs;
  const fields = formFields(snap);
  const key = (l) => String(l || '').replace(/[*✱:\s]+$/, '').trim().toLowerCase();
  const byRef = new Map(fields.map((f) => [f.ref, f]));
  const count = {};
  for (const f of fields) count[key(f.label)] = (count[key(f.label)] || 0) + 1;
  const filled = (f) => !!(f && f.value && !/make a selection|^select\b|^choose\b|^--/i.test(String(f.value)));
  return needs.filter((n) => {
    if (n.type || n.kind === 'file') return true;
    const f = byRef.get(n.ref) || (count[key(n.label)] === 1 ? fields.find((x) => key(x.label) === key(n.label)) : null);
    return !filled(f);
  });
}

/** Wait (poll 300 ms, cap ~5 s) for the address fields behind an Address Line 1 suggestion to fill; the latest snapshot. */
async function waitAddressFilled(run) {
  const dep = (s) => formFields(s).filter((f) => /^(zip|zip code|postal code|city|state|county)\b/i.test(String(f.label || '').trim()));
  const sig = (s) => dep(s).map((f) => `${f.label}=${f.value || ''}`).join('|');
  let last = null;
  let prev = '';
  let stable = 0;
  for (let i = 0; i < 17; i++) {
    const s = await snapshot(run.tabId).catch(() => null);
    if (s) {
      last = s;
      const fields = dep(s);
      if (fields.length && fields.every((f) => f.value)) return s;
      stable = sig(s) === prev ? stable + 1 : 0;
      prev = sig(s);
      if (stable >= 4) return s; // nothing is changing any more (a county the profile does not know stays empty)
    }
    await sleep(300);
  }
  return last;
}

async function stepForm(run, snap) {
  const p = D.profile();
  const data = D.fillData();
  const resume = run.resume || p.documents.resume;
  const formFrames = snap.frames.filter((f) => (f.fields || []).some((x) => !/search/i.test(x.label)));

  // 1. Files first: some ATSs parse the resume into the form.
  let uploadedNow = false;
  for (const f of formFrames) {
    const files = (f.fields || []).filter((x) => x.kind === 'file' && !x.value);
    for (const file of files) {
      // What the slot is for comes from its question text ("Resume/CV", "Cover Letter", "transcript"),
      // never from the button ("Attach"). Each kind is uploaded once per page: a slot that was cleared
      // (or re-rendered with a new ref) is not refilled. A slot of unknown purpose gets the resume only
      // when it is the page's only file slot.
      const which = file.for === 'other' && files.length === 1 && !(f.fields || []).some((x) => x.kind === 'file' && x.value) ? 'resume' : file.for;
      const key = `${uploadPage(f.url)}#${which}`;
      if (run.uploads[key]) continue;
      const src = which === 'cover' ? run.cover : which === 'transcript' ? run.transcript || p.documents.transcript : which === 'resume' ? resume : null;
      if (!src) continue; // reported below if required
      try {
        uploadedNow = true;
        const res = await upload(run, f.frameId, which, src, file.ref);
        run.uploads[key] = res && res.ok ? path.basename(src) : 'failed';
        log(run, 'upload', `${which} -> "${file.label}" ${res && res.ok ? 'ok' : 'FAILED ' + ((res && res.error) || '')}`);
      } catch (err) {
        run.uploads[key] = 'failed';
        log(run, 'upload', `${which} failed: ${err.message}`);
      }
    }
  }
  // Only on the pass that uploaded (every later pass of the same run used to wait again).
  if (uploadedNow) {
    await settle(run.tabId);
    // Lever / Workday show an "uploading" state while they parse the resume (cap ~15 s).
    for (let i = 0; i < 38; i++) {
      const s2 = await snapshot(run.tabId).catch(() => null);
      if (!s2 || !s2.signals.uploading) break;
      await sleep(400);
    }
  }

  // 2. Formhand fill pass in every frame that holds the form.
  let needs = [];
  let company = null;
  for (const f of formFrames) {
    let out;
    try {
      out = await call(run.tabId, f.frameId, 'fill', data, 120000);
    } catch (err) {
      log(run, 'fill', `frame ${f.frameId} failed: ${err.message}`);
      continue;
    }
    company = company || out.company;
    log(run, 'fill', `${out.adapter}${out.step ? ' step ' + out.step : ''}${snap.signals.workdayPage ? ' [' + snap.signals.workdayPage + ']' : ''}: ${out.counts.filled} filled, ${out.counts.review} review, ${out.counts.unknown} missing`);
    needs.push(...out.needs.map((n) => ({ ...n, ref: q(f.frameId, n.ref), frame: f.frameId })));
    for (const file of out.files || []) {
      if (file.required && !file.value) {
        const kind = file.for === 'cover' ? 'cover_letter' : file.for === 'transcript' ? 'transcript' : 'file';
        if (!(file.for === 'resume' && run.uploads[`${uploadPage(f.url)}#resume`])) needs.push({ type: kind, ref: q(f.frameId, file.ref), label: file.label, for: file.for, kind: 'file', required: true });
      }
    }
  }
  if (company && !run.company) run.company = company;
  // Resume parsers fill "Current company" with whatever is listed first (Gamma Project, a class project, on
  // 2026-10-07): set it to the owner's answer (extras.currentEmployer).
  const employer = (p.extras || {}).currentEmployer;
  if (employer && snap.fields.some((x) => /^current (company|employer)\b/i.test(x.label || ''))) {
    const s2 = await snapshot(run.tabId).catch(() => null);
    for (const fld of (s2 && s2.fields) || []) {
      if (!/^current (company|employer)\b/i.test(fld.label) || fld.value === employer || !/^(text|combobox)$/.test(fld.kind)) continue;
      const { frameId, ref } = splitRef(fld.ref);
      const r = await call(run.tabId, frameId, 'set', { ref, value: employer }, 20000).catch(() => null);
      log(run, 'fix', `current company "${fld.value}" -> "${employer}" ${r && r.ok ? 'ok' : 'failed'}`);
    }
  }
  if (!run.role && snap.heading) run.role = snap.heading;
  // iCIMS copies a scrambled work history out of the resume (Employer "SRE", certifications as a job, a
  // "Masters" row): rewrite the blocks from the tailored resume JSON, once per page (lib/history.js).
  if (await fixWorkdayJunk(run, snap, resume)) {
    const after = await snapshot(run.tabId).catch(() => null);
    const present = after ? new Set(after.fields.map((f) => f.ref)) : null;
    if (present) needs = needs.filter((n) => !n.ref || n.kind === 'file' || present.has(n.ref));
  }
  const hist = await fixParsedHistory(run, snap, resume, p);
  if (hist.touched) {
    const fixed = hist.fixed;
    // Settled by the rewrite, or gone with a deleted junk block.
    const after = await snapshot(run.tabId).catch(() => null);
    const present = after ? new Set(after.fields.map((f) => f.ref)) : null;
    needs = needs.filter((n) => !fixed.has(n.ref) && (!present || !n.ref || n.kind === 'file' || present.has(n.ref)));
  }
  // Every application lists the real jobs / school / certifications, optional section or not (lib/history.js).
  const reps = await fillRepeaters(run, snap, resume, p);
  if (reps.touched) {
    const after = await snapshot(run.tabId).catch(() => null);
    const present = after ? new Set(after.fields.map((f) => f.ref)) : null;
    needs = needs.filter((n) => !reps.fixed.has(n.ref) && !reps.filled.has(n.ref) && (!present || !n.ref || n.kind === 'file' || present.has(n.ref)));
  }

  // 3. What Formhand could not answer: bank / policy, else ask.
  const fileNeeds = needs.filter((n) => n.kind === 'file');
  needs = (await autoResolve(run, needs.filter((n) => n.kind !== 'file'))).concat(fileNeeds);
  // Oracle fills ZIP / City / State / County a moment after the Address Line 1 suggestion is picked (Texas
  // Instruments, 2026-10-08: reported empty while they were still filling, and their refs re-rendered).
  if (ADDRESS_PICKED.delete(run)) {
    const settled = await waitAddressFilled(run);
    needs = dropFilled(needs, settled);
  }
  // Oracle marks Address Line 2 / 3, Care Of, Tax District required in aria though the page does not.
  needs = needs.filter((n) => !oracleOptional(n, snap.url));
  // An optional question the engine could not match never blocks the page (Elmbrook, 2026-10-09: a filled,
  // optional work-restrictions box stopped the run on every continue). Low-confidence fills are still reviewed.
  needs = needs.filter((n) => !(n.required === false && !n.type));
  // (A page is only looked at again when the owner answered something by hand.)
  if (needs.length && Object.keys(run.handAnswers || {}).length) needs = dropHandAnswered(run, needs, await snapshot(run.tabId).catch(() => null));
  // Custom dropdowns: list their choices so the answer can be picked exactly.
  for (const n of needs) {
    if (n.options || !/select|combobox/.test(n.kind || '')) continue;
    const { frameId, ref } = splitRef(n.ref);
    n.options = await call(run.tabId, frameId, 'options', { ref }, 20000).catch(() => undefined);
    if (Array.isArray(n.options) && !n.options.length) n.hint = `choices load as you type: jobctl options ${n.ref} <text>`;
  }
  if (needs.length) return stop(run, 'needs_input', `${needs.length} required field(s) need an answer`, await snapshot(run.tabId), needs);

  // 4. Next or Submit, but only once the page agrees every required field has a value: a field that
  //    went blank after the fill pass (a re-render, a widget that reset) gets one more pass.
  const fresh = await snapshot(run.tabId);
  const blank = formFields(fresh).filter((f) => f.required && !f.value && f.kind !== 'file' && !oracleOptional(f, fresh.url));
  if (blank.length) {
    run.refills = (run.refills || 0) + 1;
    if (run.refills <= 2) {
      log(run, 'refill', `required field(s) empty before navigating: ${blank.map((f) => f.label.slice(0, 40)).join(' | ')}`);
      return null;
    }
    return stop(run, 'needs_input', `${blank.length} required field(s) are still empty`, fresh, blank.map((f) => ({ ...f, type: 'empty_required' })));
  }
  run.refills = 0;
  return pressNav(run, fresh, p);
}

// Submit presses per page per `jobctl continue` (audit 2026-10-08): Oracle's "You have 1 issue that needs to be
// fixed" toast changes the page signature on every press, so the stuck check never fired and Zephyrhaven
// got SUBMIT 45 times (Cedarmere 47). Next buttons are not capped: Oracle keeps one URL across its sections.
const MAX_SUBMITS = 2;

/** Presses of Submit so far on this page (keyed like uploads, so iCIMS session params do not reset it). */
function submitCap(run, url) {
  run.submits = run.submits || {};
  const key = uploadPage(url);
  return { key, pressed: run.submits[key] || 0, full: (run.submits[key] || 0) >= MAX_SUBMITS };
}

/** Step 4 of stepForm: press Next / Submit on a page whose required fields all hold a value. */
/**
 * Press a Workday button the way its own scripts accept: the click_filter overlay named like it, then the element
 * with its data-automation-id (QUARRYHALL 2026-10-09: Apply / Save and Continue ignored a plain click, a press there worked).
 * Never for Create Account or Sign In (one press each, lockout rules). Returns the changed page or null.
 */
async function workdayPress(run, btn, before, ms) {
  if (!btn || !(btn.aid || /myworkday/i.test(run.lastUrl || run.url || ''))) return null;
  if (/create account|sign ?in|log ?in|submit/i.test(btn.text || '') || btn.aid === 'click_filter') return null;
  const { frameId } = splitRef(btn.ref);
  const esc = (t) => String(t).replace(/["\\]/g, '\\$&');
  const sels = [];
  if (btn.text) sels.push(`[data-automation-id="click_filter"][aria-label="${esc(btn.text)}"]`);
  if (btn.aid) sels.push(`[data-automation-id="${esc(btn.aid)}"]`);
  for (const selector of sels) {
    const r = await call(run.tabId, frameId, 'pressSelector', { selector }).catch(() => null);
    if (!r || !r.ok) continue;
    log(run, 'nav', `plain click ignored: pressed ${selector}`);
    const after = await waitChange(run, before, ms);
    if (after && signature(after) !== before) return after;
  }
  return null;
}

/** hCaptcha / reCAPTCHA on the page (an invisible one too): its frames or its attribution buttons. */
function captchaOnPage(snap) {
  return (snap.signals.captcha || []).length > 0 || snap.buttons.some((b) => /hcaptcha|recaptcha/i.test(b.text || ''));
}

async function pressNav(run, fresh, p) {
  let nav = findNav(fresh);
  if (!nav) {
    // The button may come back: a resume still parsing (Rippling "Parsing the résumé"), a spinner on the Next button
    // (iCIMS while its hCaptcha runs), a disabled Apply that enables once the page settles. Look again for a while.
    let last = fresh;
    const fieldsOf = (s) => formFields(s).map((f) => f.label).join('|');
    const had = fieldsOf(fresh);
    let late = false;
    const got = await pollPage(run, (s) => {
      last = s;
      // Questions that rendered while we waited (a Workday step still loading: spinner, Save and Continue greyed;
      // Allison / Hollowridge / YARROWHALL 2026-10-09) are filled first: back to the loop, never pressed past unanswered.
      if (s.signals && s.signals.confirmation) return s; // the submit already landed (Greenhouse embed, Ravenvale 2026-10-11)
      if (fieldsOf(s) !== had && formFields(s).length) return (late = true), s;
      return findNav(s) ? s : null;
    }, TUNE.navWaitMs);
    // A step that started on the old form while the submit navigated: the confirmation page has no Next / Submit.
    // Back to the loop, which classifies it as done (2 Ravenvale submits stopped as no_navigation, 2026-10-11).
    if ((got || last).signals && (got || last).signals.confirmation) {
      log(run, 'nav', 'confirmation page while looking for Next: the submit went through');
      R.save(run);
      return null;
    }
    if (got && late && (run.lateRenders = (run.lateRenders || 0) + 1) <= 5) {
      log(run, 'nav', 'the page rendered more questions while waiting for Next: filling them first');
      R.save(run);
      return null;
    }
    if (got) {
      fresh = got;
      nav = findNav(got);
    } else if (captchaOnPage(last) && (/please try again/i.test((last.signals.errors || []).join(' ')) || (last.signals.captcha || []).length)) {
      // iCIMS account page: Next spins forever and "Please try again" shows: the hCaptcha wants a human.
      await shot(run, 'captcha');
      return stop(run, 'blocked', 'captcha: the page waits on an hCaptcha check (Next keeps spinning / "Please try again"): solve it in the browser window, then `jobctl continue`', last, [
        { type: 'captcha', captcha: last.signals.captcha, errors: last.signals.errors, note: 'visual / invisible captcha: the owner solves it' },
      ]);
    } else {
      // Only a disabled Next / Apply / Submit: the form still misses an answer. Name the empty required fields.
      const off = findNav({ ...last, buttons: last.buttons.map((b) => (b.disabled ? { ...b, disabled: false } : b)) });
      if (off) {
        return stop(run, 'needs_input', `"${off.btn.text}" is disabled: a required answer is still missing`, last, [
          { type: 'validation', errors: last.signals.errors, disabled: off.btn.text, emptyRequired: formFields(last).filter((f) => f.required && !f.value) },
        ]);
      }
      return stop(run, 'needs_input', 'form looks complete but no Next / Submit button was found', last, [{ type: 'no_navigation', buttons: last.buttons.slice(0, 30) }]);
    }
  }
  if (nav.kind === 'submit') {
    if (fresh.signals.captcha.length) return stop(run, 'blocked', `captcha before submit (${fresh.signals.captcha.join(', ')}): solve it in the browser window, then \`jobctl continue\``, fresh);
    if (run.noSubmit || run.dry || !p.policy.autoSubmit) {
      await shot(run, 'ready-to-submit');
      return stop(run, 'ready_to_submit', `everything is filled; "${nav.btn.text}" not pressed (${run.noSubmit ? '--no-submit' : 'policy.autoSubmit is off'})`, fresh);
    }
    const cap = submitCap(run, fresh.url);
    if (cap.full) {
      const errors = fresh.signals.errors || [];
      const text = errors.length ? '' : await snapshot(run.tabId, { text: true, textMax: 2000 }).then((s) => s.text || '').catch(() => '');
      const excerpt = (errors.join(' | ') || text).replace(/\s+/g, ' ').trim().slice(0, 500);
      await shot(run, 'submit-bounced');
      return stop(run, 'needs_input', `pressed "${nav.btn.text}" ${cap.pressed} times and the page is still here: fix what it flags, then \`jobctl continue\``, fresh, [
        { type: 'validation', errors, excerpt, emptyRequired: formFields(fresh).filter((f) => f.required && !f.value) },
      ]);
    }
    run.submits[cap.key] = cap.pressed + 1;
    await shot(run, 'before-submit');
    // What went out, for audits ("did the bot answer X?"): every field's label and value, files by name.
    run.submittedFields = formFields(fresh)
      .filter((f) => f.value)
      .map((f) => ({ label: String(f.label || '').slice(0, 120), value: String(f.value).slice(0, 200), kind: f.kind }));
    run.submitPressedAt = new Date().toISOString();
  }
  // Nothing untrue leaves the page: a self-ID answer that means something else than the owner's stops here (lib/eeo.js).
  const eeo = require('./eeo').conflicts(formFields(fresh), p.standardAnswers);
  if (eeo.length) {
    await shot(run, 'eeo-conflict');
    return stop(run, 'needs_input', `self-ID, work-authorization or country answer on the page is not the owner's (${eeo.map((c) => `${c.label} = "${c.value}", owner: ${c.owner}`).join('; ').slice(0, 300)}): set it to his answer, then \`jobctl continue\``, fresh, eeo.map((c) => ({ type: 'eeo_conflict', ...c })));
  }
  log(run, 'nav', `press "${nav.btn.text}" (${nav.kind})`);
  const before = signature(fresh);
  await click(run, nav.btn.ref, { tab: false });
  let after = await waitChange(run, before, nav.kind === 'submit' ? 30000 : 20000);
  // Workday tenants that ignore a plain click on the footer button take a press on its automation-id element or its
  // click_filter overlay (QUARRYHALL 2026-10-09). Not after a Submit: a slow submit must never be pressed twice.
  if (after && signature(after) === before && nav.kind !== 'submit' && !(after.signals.errors || []).length) {
    const again = await workdayPress(run, nav.btn, before, 15000);
    if (again) after = again;
  }
  if (after && signature(after) === before) {
    run.stuck = (run.stuck || 0) + 1;
    // Ashby yes/no pills (Thornhaven, 2026-10-08) can show pressed while the form's state missed the press: the
    // error names the question. Press the other option, then the answer again, check it held, retry once per page.
    const sig = signature(after);
    if (after.signals.errors.length && run.repressedOn !== sig) {
      const norm = (t) => String(t || '').toLowerCase().replace(/[*✱]/g, '').replace(/\s+/g, ' ').trim();
      const errText = norm(after.signals.errors.join(' '));
      const pills = formFields(after).filter((f) => f.kind === 'buttons' && f.value && norm(f.label) && errText.includes(norm(f.label).slice(0, 40)));
      if (pills.length) {
        run.repressedOn = sig;
        for (const f of pills) {
          const { frameId, ref } = splitRef(f.ref);
          const other = (f.options || []).find((o) => o !== f.value);
          if (other) await call(run.tabId, frameId, 'set', { ref, value: other }).catch(() => null);
          const back = await call(run.tabId, frameId, 'set', { ref, value: f.value }).catch((e) => ({ ok: false, error: e.message }));
          // Never leave the opposite answer behind (a sponsorship / ITAR pill on the wrong side would submit next pass).
          if (!back || !back.ok || back.value !== f.value) {
            return stop(run, 'needs_input', `re-pressing "${f.label}" did not restore "${f.value}": check it in the window`, await snapshot(run.tabId), [{ ...f, type: 'validation', tried: f.value, error: back && back.error }]);
          }
        }
        log(run, 'repress', `re-pressed ${pills.length} pill question(s) the form said were missing`);
        return null;
      }
    }
    // Workday date spinbuttons can show 10/09/2026 while the form state is empty ("Date ... is required and
    // must have a value", Coppermoor / Elmbrook 2026-10-09): pick the shown day in the calendar, retry once.
    if (after.signals.errors.some((e) => /required and must have a value/i.test(e)) && after.buttons.some((b) => b.aid === 'dateIcon') && run.datePickedOn !== sig) {
      run.datePickedOn = sig;
      const picked = await pickWorkdayDates(run, after);
      if (picked) {
        log(run, 'fix', `picked ${picked} Workday date(s) in the calendar`);
        return null;
      }
    }
    if (after.signals.errors.length || run.stuck >= 2) {
      return stop(run, 'needs_input', 'the page did not move on after pressing ' + nav.btn.text, after, [
        { type: 'validation', errors: after.signals.errors, emptyRequired: formFields(after).filter((f) => f.required && !f.value) },
      ]);
    }
  } else run.stuck = 0;
  return null;
}

/* ------------------------------------------------------------------ */
/* Loop                                                                 */
/* ------------------------------------------------------------------ */

function log(run, kind, msg, extra) {
  run.steps.push({ at: new Date().toISOString(), kind, msg, ...(extra || {}) });
  if (process.env.JOBBOT_VERBOSE) process.stderr.write(`[${kind}] ${msg}\n`);
}

async function shot(run, name) {
  try {
    const data = await C.send('screenshot', { tabId: run.tabId, quality: 45 });
    return R.saveShot(run, `${String(run.steps.length).padStart(2, '0')}-${name}`, data);
  } catch (e) {
    return null;
  }
}

function stop(run, status, message, snap, needs) {
  run.status = status;
  run.message = message;
  run.needs = needs || [];
  if (snap) {
    run.lastUrl = snap.url;
    run.lastErrors = snap.signals ? snap.signals.errors : [];
  }
  return { status, message };
}

async function drive(run) {
  run.needs = [];
  run.message = null;
  for (let i = 0; i < MAX_STEPS; i++) {
    const t0 = Date.now();
    // A page that came out of waitChange having held still across two looks needs no waitQuiet of its own
    // (the load state is still checked): that settle used to cost >= 0.8 s on every transition.
    const stableAt = STABLE.get(run);
    STABLE.delete(run);
    const skipQuiet = !!(stableAt && Date.now() - stableAt < 3000);
    await settle(run.tabId, skipQuiet ? { quiet: 0 } : undefined);
    const t1 = Date.now();
    let snap = await snapshot(run.tabId);
    const t2 = Date.now();
    // Cookie banners sit over the form (Workday legalNotice*): accept under the owner's autoConsent.
    const cookie = D.profile().policy.autoConsent && snap.buttons.find((b) => b.aid === 'legalNoticeAcceptButton' || /^(accept( all)? cookies|accept all|allow all cookies)$/i.test(b.text));
    if (cookie) {
      log(run, 'cookies', `press "${cookie.text}"`);
      await click(run, cookie.ref, { tab: false }).catch(() => {});
      await settle(run.tabId);
      snap = await snapshot(run.tabId);
    }
    let kind = classify(snap);
    // A page still loading (Workday's spinner after a route change) reads as unknown: one settle, then a look every
    // 250 ms for up to 3.5 s (was four fixed 2.5 s sleeps).
    if (kind === 'unknown') {
      // After a Submit the page that follows is usually a slow confirmation: full settle and up to ~12 s, not 3.5 s.
      const afterSubmit = !!run.submitPressedAt;
      if (skipQuiet || afterSubmit) {
        // (the loop-top settle was the short one: give the page its quiet second now)
        await settle(run.tabId);
        snap = await snapshot(run.tabId);
        kind = classify(snap);
      }
      if (kind === 'unknown') {
        let last = snap;
        // (Workday apply pages can take several seconds to render after a route change (UMBERMOOR 2026-10-09): 10 s there.)
        const got = await pollPage(run, (s) => ((last = s), classify(s) !== 'unknown' ? s : null), afterSubmit ? TUNE.afterSubmitWaitMs : /myworkdayjobs|\.workday\.com/i.test(snap.url || '') ? TUNE.unknownWaitWorkdayMs : TUNE.unknownWaitMs);
        snap = got || last;
        kind = classify(snap);
      }
    }
    const t3 = Date.now();
    run.lastUrl = snap.url;
    R.save(run);
    let res = null;
    try {
    kind = await require('./handshake-apply').kind(run, snap, kind); // Handshake native apply: modal / applied / login
    switch (kind) {
      case 'hs_modal':
        res = await require('./handshake-apply').stepModal(run, snap);
        break;
      case 'hs_login':
        res = stop(run, 'blocked', 'Handshake is logged out: the owner logs in once in the jobbot Firefox (EXU SSO + Duo), then `jobctl continue`', snap);
        break;
      case 'done': {
        await shot(run, 'confirmation');
        res = stop(run, 'submitted', 'confirmation page seen', snap);
        // A submit proves the account works: lift any "Create Account ignored" flag on the tenant (UMBERMOOR 2026-10-09: three
        // submits after the owner's tap left the flag set, and the fourth run refused to sign in).
        markSignedIn(S.accountKey(snap.url, Object.keys(D.accounts())));
        if (!run.loggedApplied) {
          D.logApplied({ run: run.id, url: run.url, company: run.company, role: run.role, location: run.location || '', resume: run.resume, finalUrl: snap.url });
          run.loggedApplied = true;
        }
        break;
      }
      case 'already':
        res = stop(run, 'already_applied', run.hsApplication ? `already applied on Handshake (${String(run.hsApplication.createdAt || '').slice(0, 10)})` : 'the site says you already applied', snap);
        break;
      case 'closed':
        res = stop(run, 'closed', 'posting is closed or gone', snap);
        break;
      case 'captcha':
        await shot(run, 'captcha');
        await C.send('notify', { title: 'Jobbot needs you', message: `Captcha on ${new URL(snap.url).hostname}: solve it, then tell Claude "continue".` }).catch(() => {});
        res = stop(run, 'blocked', `captcha (${snap.signals.captcha.join(', ')}): solve it in the browser window, then \`jobctl continue\``, snap);
        break;
      case 'security_code': {
        // Emailed codes are Claude's to read and type (owner, 2026-10-08), so no desktop ping. Once every code
        // box holds a character, the page goes through stepForm like any form, so its submit gates (--dry,
        // --no-submit, policy.autoSubmit, captcha) and the submittedFields record all apply (Capstone stayed
        // "blocked" with the code typed in). Twice per page at most: a wrong code brings the boxes back.
        const tries = (run.codeTries = run.codeTries || {});
        const key = uploadPage(snap.url);
        if (codeTyped(snap) && (tries[key] || 0) < 2) {
          tries[key] = (tries[key] || 0) + 1;
          log(run, 'code', 'code entered, continuing the form');
          res = await stepForm(run, snap);
          break;
        }
        await shot(run, 'security-code');
        res = stop(run, 'blocked', 'the site wants an emailed security code: read it from Gmail, type it into the code boxes (`jobctl set`), then `jobctl continue`', snap);
        break;
      }
      case 'email_gate':
        res = await stepEmailGate(run, snap);
        break;
      case 'verify': {
        noteVerifySeen(snap);
        const wd = /workday|myworkdayjobs/i.test(snap.url || '');
        res = stop(run, 'needs_input', 'the site sent a verification email', snap, [{ type: 'email_verification', site: S.siteKey(snap.url), email: D.profile().profile.email, pageText: snap.heading, ...(wd ? { sender: 'myworkday.com / otp.workday.com' } : {}) }]);
        break;
      }
      case 'auth':
        res = await stepAuth(run, snap);
        break;
      case 'auth_chooser':
        res = await stepAuthChooser(run, snap);
        break;
      case 'landing':
        res = await stepLanding(run, snap);
        break;
      case 'form':
        res = await stepForm(run, snap);
        break;
      default: {
        // A submit just pressed with no recognizable confirmation: look once more, then report.
        await shot(run, 'unknown');
        res = stop(run, run.submitPressedAt ? 'needs_review' : 'blocked', run.submitPressedAt ? 'submit was pressed; the next page is not a recognizable confirmation: check the screenshot' : 'could not tell what this page is', snap, [
          { type: 'unknown_page', url: snap.url, heading: snap.heading, buttons: snap.buttons.slice(0, 25) },
        ]);
      }
    }
    } catch (e) {
      // Frames replaced under the snapshot (an iframe navigated): look again instead of crashing (Cedarhall 2026-10-09).
      run.frameRetries = (run.frameRetries || 0) + 1;
      if (!FRAME_GONE.test(String(e && e.message)) || run.frameRetries > 3) throw e;
      log(run, 'frames', `frames changed under the page (${String(e.message).slice(0, 80)}): looking again`);
      R.save(run);
      continue;
    }
    // Per-step timing, so a stall can be measured: where the milliseconds went, and whether the tab was hidden or
    // unfocused (Firefox throttles timers and pauses rendering in a background tab).
    const t4 = Date.now();
    log(run, 'timing', `${kind}: ${t4 - t0} ms (settle ${t1 - t0}, snapshot ${t2 - t1}, classify ${t3 - t2}, step ${t4 - t3}); tab ${snap.signals.visibility || '?'}, focus ${snap.signals.focus == null ? '?' : snap.signals.focus}`, {
      step: kind,
      ms: t4 - t0,
      settleMs: t1 - t0,
      snapshotMs: t2 - t1,
      classifyMs: t3 - t2,
      stepMs: t4 - t3,
      visibility: snap.signals.visibility || null,
      focus: snap.signals.focus == null ? null : snap.signals.focus,
    });
    R.save(run);
    if (res) {
      await atStop(run);
      return report(run);
    }
  }
  stop(run, 'blocked', `gave up after ${MAX_STEPS} steps`);
  R.save(run);
  return report(run);
}

/** Every stop: a screenshot for the record and, when the owner has to act, one desktop notification. */
// A finished run's tab is closed (8 GB RAM): only runs that wait on someone keep theirs.
const DONE = new Set(['submitted', 'already_applied', 'closed']);

/**
 * The friction log (data/friction.jsonl): one line per stop, so recurring trouble shows up in
 * `jobctl friction` and the /apply skill can fix the worst of it after each batch.
 */
function logFriction(run) {
  try {
    let host = '';
    try {
      host = new URL(run.lastUrl || run.url).hostname;
    } catch (e) {
      /* keep empty */
    }
    const needs = (run.needs || []).filter((n) => n.type !== 'review');
    const rec = {
      at: new Date().toISOString(),
      run: run.id,
      url: run.url,
      ats: run.ats || U.atsOf(run.url),
      host,
      company: run.company || null,
      role: run.role || null,
      status: run.status,
      message: run.message,
      dry: run.dry || undefined,
      continues: run.continues || 0,
      minutes: Math.round((Date.now() - Date.parse(run.created)) / 60000),
      needTypes: needs.map((n) => n.type || (n.declined ? 'declined' : n.aiPolicy ? 'ai_policy' : 'question')),
      questions: needs.filter((n) => !n.type && n.label).map((n) => String(n.label).slice(0, 120)),
    };
    fs.appendFileSync(path.join(D.DATA_DIR, 'friction.jsonl'), JSON.stringify(rec) + '\n');
  } catch (e) {
    /* the log must never break a run */
  }
}

async function atStop(run) {
  logFriction(run);
  if (run.status !== 'submitted') run.stopShot = await shot(run, `stop-${run.status}`);
  if (DONE.has(run.status) || (run.dry && run.status === 'ready_to_submit')) {
    await C.send('close', { tabId: run.tabId }).catch(() => {});
    run.tabClosed = true;
    R.save(run);
  }
  if (!['needs_input', 'blocked'].includes(run.status)) return;
  const owner = (run.needs || []).filter((n) => !n.review && n.type !== 'review');
  const what = run.status === 'blocked' ? run.message : `${owner.length} item(s): ${owner.slice(0, 3).map((n) => String(n.label || n.type || '').slice(0, 40)).join('; ')}`;
  notify(`jobbot: ${run.company || 'application'}${run.role ? ', ' + run.role.slice(0, 40) : ''}`, what);
}

/** Desktop notification (KDE picks it up; Remote Control may mirror it). Never blocks the run. */
function notify(title, body) {
  if (process.env.JOBBOT_NO_NOTIFY) return;
  try {
    require('node:child_process').spawn('notify-send', ['-a', 'jobbot', '-u', 'normal', String(title).slice(0, 120), String(body).slice(0, 240)], { stdio: 'ignore', detached: true }).unref();
  } catch (e) {
    /* no notifier: fine */
  }
}

function report(run) {
  return {
    run: run.id,
    status: run.status,
    message: run.message,
    company: run.company,
    role: run.role,
    url: run.lastUrl || run.url,
    needs: run.needs,
    errors: run.lastErrors && run.lastErrors.length ? run.lastErrors : undefined,
    lastSteps: run.steps.filter((s) => s.kind !== 'timing').slice(-8).map((s) => `${s.kind}: ${s.msg}`),
    shots: R.dir(run.id),
    shot: run.stopShot || undefined,
  };
}

/** The posting's location from its ATS API, normalized; '' when there is no API or it fails. */
async function postingLocation(url) {
  try {
    const p = await Promise.race([require('./posting').posting(url), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))]);
    return require('./location').normLocation(p.location);
  } catch (e) {
    return '';
  }
}

async function start(url, opts) {
  const direct = U.applyUrl(url);
  const run = R.create(direct, opts);
  run.postingUrl = U.unwrap(url);
  run.ats = U.atsOf(direct);
  // Where the job is, for the tracker row (owner, 2026-10-08): --location, else the posting API
  // (Greenhouse / Ashby / Lever / Workday); other ATSs fill it from the page heading later or stay blank.
  // The ATS API read runs while the tab opens (it used to finish first: up to 15 s of nothing on screen).
  const located = opts && opts.location ? Promise.resolve(require('./location').normLocation(opts.location)) : postingLocation(run.postingUrl);
  run.location = '';
  const tab = await C.send('open', { url: direct, active: true });
  run.tabId = tab.tabId;
  require('./focus').setFocus(run.tabId, 'run');
  log(run, 'open', url);
  const gotLocation = located.then((loc) => {
    run.location = loc || '';
    return run.location;
  });
  R.save(run);
  const lanes = require('./lanes');
  await lanes.place(run, 'work');
  const out = await drive(run);
  // (drive stops late, long after the read finished; this only makes sure a slow read is not lost.)
  await gotLocation;
  if (run.location) R.save(run);
  await lanes.place(run); // red NEEDS YOU / green JOBBOT WORKING / grey DONE (lib/lanes.js)
  return out;
}

async function resume(id, opts) {
  const run = R.load(id);
  if (opts && opts.noSubmit != null) run.noSubmit = opts.noSubmit;
  try {
    await C.send('tab', { tabId: run.tabId });
  } catch (e) {
    // The tab was closed: start over from the last URL (filled fields are gone).
    const tab = await C.send('open', { url: run.lastUrl || run.url, active: true });
    run.tabId = tab.tabId;
    log(run, 'reopen', run.lastUrl || run.url);
  }
  run.stuck = 0;
  run.authAttempts = 0;
  // A continue follows a hand fix: each page gets its 2 Submit presses again ... except after a Submit whose result
  // the driver could not read (needs_review): that application may have gone through, so the cap stays and only a
  // different page (another URL, another key) gets fresh presses.
  if (run.status !== 'needs_review') run.submits = {};
  // ... and the history sections get their passes again (a hand fix or a Back to My Experience may need them).
  run.historyTries = {};
  run.continues = (run.continues || 0) + 1;
  // `jobctl continue <run> --owner`: the owner tapped Create Account himself. The only thing that unlocks the one
  // sign-in on a Workday tenant that ignored the scripted press (a bare continue or `answer --continue` does not).
  if (opts && opts.owner) run.ownerTapAt = new Date().toISOString();
  // Back to the green group while the bot drives; a hand-set lane (jobctl lane) ends with the continue.
  require('./focus').setFocus(run.tabId, 'run');
  const lanes = require('./lanes');
  delete run.lane;
  delete run.handoffAt;
  // While driving, the tab sits in WORKING with the old stop's status: `jobctl handoffs` must not read that as the owner
  // handing it back.
  run.drivingSince = Date.now();
  R.save(run);
  await lanes.place(run, 'work');
  try {
    const out = await drive(run);
    await lanes.place(run);
    return out;
  } finally {
    delete run.drivingSince;
    R.save(run);
  }
}

module.exports = {
  dropHandAnswered,
  HUMAN_CHECK, uploadPage, codeTyped, redactSecrets, isCombinedSignupForm, logisticsAnswer, logFriction, start, resume, snapshot, classify, findApply, findNav, splitRef, call, click, upload, settle, profileAnswer, standardAnswer, stateAnswer, countryAnswer, howHeardAnswer, majorAnswer, isHowHeard, optionFor, isUsOption, searchTerms, createOutcome, stepWorkdayCreate, stepAuth, noteVerifySeen, isWorkRestriction, markSignedIn, followSpawned, newErrors, workedAt, namesThisCompany, employerQuestion, termFits, answerMeaning, pollPage, TUNE, drive, stepForm, waitChange, pickWorkdayDates, fillRepeaters, readRepeaters, fixParsedHistory, dropFilled, oracleOptional, reanswer, waitAddressFilled, isSalaryAmountQuestion, isConflictQuestion, isFactQuestion, OPT_IN, optInOutcome, autoResolve, pressNav, submitCap };
// lib/handshake-apply.js drives Handshake's Apply modal with these.
Object.assign(module.exports, { stop, log, shot });
