// Workday Create Account (owner's standing instruction, 2026-10-09): the driver presses it ONCE per tenant and the
// owner only taps when the tenant ignores the scripted press. Fake snapshots, a scratch data dir, no browser, no keyring.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-wdacct-'));
process.env.JOBBOT_DATA = DIR; // before lib/paths is loaded
fs.writeFileSync(path.join(DIR, 'profile.json'), JSON.stringify({ profile: { email: 'me@example.com' }, extras: {}, standardAnswers: {}, documents: {}, policy: { autoConsent: true, autoSubmit: false } }));
fs.writeFileSync(path.join(DIR, 'accounts.json'), '{}');

const A = require('../lib/apply');
const C = require('../lib/client');
const D = require('../lib/data');
const S = require('../lib/secrets');

A.TUNE.createWaitMs = 700; // the real wait is 10 s

const HOST = 'amfam.wd1.myworkdayjobs.com';
const URL1 = `https://${HOST}/en-US/External/login`;
const sig = (o) => ({ confirmation: false, alreadyApplied: false, closed: false, verifyEmail: false, captcha: [], passwordFields: 0, errors: [], embeddedForms: [], securityCode: false, uploading: false, workdayPage: null, visibility: 'visible', focus: true, ...o });
const fld = (label, extra) => ({ ref: String(label.length), label, kind: 'text', required: true, value: '', ...(extra || {}) });
const btn = (text, extra) => ({ ref: 'b' + text.length, text, ...(extra || {}) });

// The pages a Workday tenant shows.
const signUp = (o) => ({ url: URL1, title: 'Sign up', heading: 'Create Account', top: true, fields: [fld('Email Address'), fld('Password', { kind: 'password' }), fld('Verify New Password', { kind: 'password' })], buttons: [btn('Create Account', { aid: 'click_filter', ref: '9' })], signals: sig({ passwordFields: 2, ...(o || {}) }) });
const signIn = (o) => ({ url: URL1, title: 'Sign in', heading: 'Sign In', top: true, fields: [fld('Email Address'), fld('Password', { kind: 'password' })], buttons: [btn('Sign In', { aid: 'click_filter', ref: '9' }), btn('Create Account', { ref: '8' })], signals: sig({ passwordFields: 1, ...(o || {}) }) });
const verifyNotice = () => ({ url: URL1, title: 'Verify', heading: 'Verify your account', top: true, fields: [], buttons: [btn('Resend Email')], signals: sig({ verifyEmail: true }) });
const applyForm = () => ({ url: `https://${HOST}/en-US/External/job/x/apply/myInformation`, title: 'Apply', heading: 'My Information', top: true, fields: [fld('First Name'), fld('Last Name'), fld('Phone')], buttons: [btn('Save and Continue', { aid: 'pageFooterNextButton' })], signals: sig({ workdayPage: 'applyFlowMyInformationPage' }) });

/** A fake tenant: `state` is what the page shows, `onClick` decides what a press does. */
function tenant(first, onClick, o = {}) {
  const t = { cur: first, clicks: [], fills: 0, sets: [], onClick };
  const saved = { page: C.page, send: C.send, getOrCreate: S.getOrCreate, get: S.get };
  t.restore = () => {
    Object.assign(C, { page: saved.page, send: saved.send });
    Object.assign(S, { getOrCreate: saved.getOrCreate, get: saved.get });
  };
  C.page = async (tabId, fn, args) => {
    if (fn === 'snapshot') return [{ frameId: 0, result: t.cur }];
    if (fn === 'authFill') {
      t.fills++;
      return [{ frameId: 0, result: { ok: true, uncheckedBoxes: o.boxes || [], requiredOptIns: o.optIns || [], buttons: t.cur.buttons } }];
    }
    if (fn === 'click') {
      if (o.clickThrows) throw new Error('frame 0 is gone');
      t.clicks.push(args.ref);
      t.cur = t.onClick ? t.onClick(args.ref, t) || t.cur : t.cur;
      return [{ frameId: 0, result: { ok: true } }];
    }
    if (fn === 'pressSelector') {
      (t.pressed = t.pressed || []).push(args.selector);
      t.cur = (o.onPress && o.onPress(args.selector, t)) || t.cur;
      return [{ frameId: 0, result: { ok: true } }];
    }
    if (fn === 'set') {
      t.sets.push(args);
      return [{ frameId: 0, result: { ok: true } }];
    }
    return [{ frameId: 0, result: null }];
  };
  C.send = async (cmd) => (cmd === 'tab' ? { url: t.cur.url, status: 'complete' } : []);
  S.getOrCreate = () => ({ password: 'x-made-up', created: true });
  S.get = () => 'x-made-up';
  return t;
}
// Presses of Workday's NoCaptcha button (Create Account / Sign In overlay, ref 9); the plain "Create Account" link
// (ref 8) only switches forms.
const presses = (t) => t.clicks.filter((r) => r === '9');
const freshRun = (extra) => ({ id: 'run-' + Math.random().toString(36).slice(2, 8), tabId: 1, steps: [], uploads: {}, authAttempts: 0, continues: 0, ...(extra || {}) });
const reset = () => fs.writeFileSync(path.join(DIR, 'accounts.json'), '{}');
const site = HOST;

test('createOutcome: verify notice, signed in, captcha, error, back to Sign In, nothing', () => {
  const mk = (o) => ({ ...o, frames: [], text: undefined, adapter: undefined });
  const b = mk(signUp());
  assert.strictEqual(A.createOutcome(b, mk(verifyNotice())), 'verify');
  assert.strictEqual(A.createOutcome(b, mk(applyForm())), 'proceeded');
  assert.strictEqual(A.createOutcome(b, mk(signUp({ captcha: ['hcaptcha-checkbox'] }))), 'captcha');
  assert.strictEqual(A.createOutcome(b, mk(signUp({ errors: ['Email already exists'] }))), 'error');
  assert.strictEqual(A.createOutcome(b, mk(signIn())), 'flipped');
  assert.strictEqual(A.createOutcome(b, mk(signUp())), 'same');
  // The sign-up form's own copy mentions verifying: not an outcome until something changes.
  const talky = mk(signUp({ verifyEmail: true }));
  assert.strictEqual(A.createOutcome(talky, mk(signUp({ verifyEmail: true }))), 'same');
  assert.strictEqual(A.createOutcome(b, mk({ ...signUp(), fields: [], signals: sig({ passwordFields: 0 }) })), 'same', 'a blank loading page is not an outcome');
});

test('press works and Workday sends a verification email: stop with email_verification and the sender hint; one press', async () => {
  reset();
  const t = tenant(signUp(), () => verifyNotice());
  try {
    const run = freshRun();
    const snap = await A.snapshot(1);
    const res = await A.stepAuth(run, snap);
    assert.deepStrictEqual(t.clicks, ['9'], 'the click_filter overlay, once');
    assert.strictEqual(res.status, 'needs_input');
    assert.strictEqual(run.needs[0].type, 'email_verification');
    assert.strictEqual(run.needs[0].sender, 'myworkday.com / otp.workday.com');
    assert.ok(run.accountPressed[site], 'press recorded on the run');
    const acc = D.accounts()[site];
    assert.ok(acc.createPressedAt, 'press recorded on the tenant');
    assert.strictEqual(acc.viaOwnerClick, false);
    assert.strictEqual(acc.verified, false);
  } finally {
    t.restore();
  }
});

test('press works and the tenant goes straight to the application (AmFam, Driftgate): carry on', async () => {
  reset();
  const t = tenant(signUp(), () => applyForm());
  try {
    const run = freshRun();
    const res = await A.stepAuth(run, await A.snapshot(1));
    assert.strictEqual(res, null);
    assert.deepStrictEqual(t.clicks, ['9']);
    assert.strictEqual(D.accounts()[site].viaOwnerClick, false);
  } finally {
    t.restore();
  }
});

test('tenant flips back to Sign In (QUARRYHALL, Oakgate): ignored, owner taps once, never pressed or signed in again', async () => {
  reset();
  const t = tenant(signUp(), () => signIn());
  try {
    const run = freshRun();
    const res = await A.stepAuth(run, await A.snapshot(1));
    assert.strictEqual(res.status, 'blocked');
    assert.deepStrictEqual(presses(t), ['9']);
    const need = run.needs[0];
    assert.strictEqual(need.prefilled, true, 'Create Account form filled before the hand-off');
    assert.ok(t.clicks.includes('8'), 'switched from Sign In to the Create Account form (link, not the NoCaptcha press)');
    assert.strictEqual(need.type, 'workday_create_account');
    assert.strictEqual(need.pressed, true);
    assert.match(need.note, /scripted press ignored by this tenant; owner must tap Create Account once/);
    assert.ok(D.accounts()[site].createIgnored);
    assert.strictEqual(D.accounts()[site].viaOwnerClick, true, 'discover keeps flagging the tenant');

    // The next pass of the same run lands on the Sign In page: it must not fill or press anything.
    t.cur = signIn();
    const fills = t.fills;
    const again = await A.stepAuth(run, await A.snapshot(1));
    assert.strictEqual(again.status, 'blocked');
    assert.deepStrictEqual(presses(t), ['9'], 'no second press');
    assert.ok(t.fills > fills, 'the form is filled for the owner (filling is not a sign-in)');

    // The sign-up form again (page reload) in the same run, and in a brand-new run: still no press.
    t.cur = signUp();
    await A.stepAuth(run, await A.snapshot(1));
    await A.stepAuth(freshRun(), await A.snapshot(1));
    assert.deepStrictEqual(presses(t), ['9'], 'one press per tenant, across runs');
  } finally {
    t.restore();
  }
});

test('after the owner taps and `continue` runs, exactly one sign-in attempt; a refused one is never repeated', async () => {
  reset();
  const t = tenant(signUp(), () => signIn());
  try {
    const run = freshRun();
    await A.stepAuth(run, await A.snapshot(1));
    // The owner taps Create Account, the link is opened, `jobctl continue` bumps run.continues and resets authAttempts.
    run.continues = 1;
    run.authAttempts = 0;
    t.cur = signIn();
    // A bare continue (or `answer --continue`) is not the owner's tap: still no sign-in.
    const bare = await A.stepAuth(run, await A.snapshot(1));
    assert.strictEqual(bare.status, 'blocked');
    assert.strictEqual(presses(t).length, 1);
    // `jobctl continue <run> --owner` sets run.ownerTapAt.
    run.ownerTapAt = new Date(Date.now() + 5).toISOString();
    t.onClick = () => ({ ...signIn({ errors: ['The username or password is incorrect'] }), heading: 'Sign In (error)' });
    const res = await A.stepAuth(run, await A.snapshot(1));
    assert.strictEqual(res.status, 'needs_input', 'refused sign-in stops, as before');
    assert.strictEqual(presses(t).length, 2, 'the create press plus one sign-in press');
    assert.strictEqual(D.accounts()[site].signInRefused, true);
    // Another continue: blocked, no new attempt.
    run.continues = 2;
    run.authAttempts = 0;
    t.cur = signIn();
    const third = await A.stepAuth(run, await A.snapshot(1));
    assert.strictEqual(third.status, 'blocked');
    assert.strictEqual(presses(t).length, 2);
  } finally {
    t.restore();
  }
});

test('nothing happens within the wait: also ignored (no second press)', async () => {
  reset();
  const t = tenant(signUp(), () => signUp());
  try {
    const run = freshRun();
    const t0 = Date.now();
    const res = await A.stepAuth(run, await A.snapshot(1));
    assert.ok(Date.now() - t0 >= 600, 'waited for an outcome');
    assert.strictEqual(res.status, 'blocked');
    assert.strictEqual(run.needs[0].pressed, true);
    assert.strictEqual(t.clicks.length, 1);
  } finally {
    t.restore();
  }
});

test('a sign-up error is reported as ignored with the error text', async () => {
  reset();
  const t = tenant(signUp(), () => signUp({ errors: ['Something went wrong'] }));
  try {
    const run = freshRun();
    const res = await A.stepAuth(run, await A.snapshot(1));
    assert.strictEqual(res.status, 'blocked');
    assert.deepStrictEqual(run.needs[0].errors, ['Something went wrong']);
  } finally {
    t.restore();
  }
});

test('a visual captcha on the sign-up: blocked, nothing pressed', async () => {
  reset();
  const t = tenant(signUp({ captcha: ['hcaptcha-checkbox'] }), () => verifyNotice());
  try {
    const run = freshRun();
    const res = await A.stepAuth(run, await A.snapshot(1));
    assert.strictEqual(res.status, 'blocked');
    assert.match(res.message, /captcha/);
    assert.strictEqual(t.clicks.length, 0);
    assert.ok(!run.accountPressed || !run.accountPressed[site], 'not recorded as pressed');
    assert.ok(!D.accounts()[site] || !D.accounts()[site].createPressedAt);
  } finally {
    t.restore();
  }
});

test('opt-in boxes on the sign-up are never ticked and the account is never pressed past them', async () => {
  reset();
  const t = tenant(signUp(), () => verifyNotice(), { optIns: [{ ref: '33', label: 'Yes, send me job alerts' }] });
  try {
    const run = freshRun();
    const res = await A.stepAuth(run, await A.snapshot(1));
    assert.strictEqual(res.status, 'needs_input');
    assert.strictEqual(run.needs[0].type, 'opt_in_required');
    assert.strictEqual(t.clicks.length, 0);
    assert.strictEqual(t.sets.length, 0);
  } finally {
    t.restore();
  }
});

test('terms / privacy boxes are ticked under autoConsent, then the press happens', async () => {
  reset();
  const t = tenant(signUp(), () => verifyNotice(), { boxes: [{ ref: '41', label: 'I acknowledge the Candidate Privacy Notice' }] });
  try {
    const run = freshRun();
    await A.stepAuth(run, await A.snapshot(1));
    assert.deepStrictEqual(t.sets.map((s) => s.ref), ['41']);
    assert.strictEqual(t.clicks.length, 1);
  } finally {
    t.restore();
  }
});

test('a verification page seen on a tenant that ignored the press lifts the sign-in block (the owner tap worked)', async () => {
  reset();
  D.saveAccount(site, { email: 'me@example.com', verified: false, createIgnored: 'x', createIgnoredRun: 'old', createIgnoredContinues: 0, signInRefused: true, viaOwnerClick: true });
  const t = tenant(verifyNotice(), () => null);
  try {
    const snap = await A.snapshot(1);
    assert.strictEqual(A.classify(snap), 'verify');
    A.noteVerifySeen(snap);
    const acc = D.accounts()[site];
    assert.ok(!acc.createIgnored);
    assert.strictEqual(acc.signInRefused, false);
    assert.strictEqual(acc.viaOwnerClick, false);
    // An ordinary tenant (no ignored press) is left alone.
    reset();
    A.noteVerifySeen(snap);
    assert.deepStrictEqual(D.accounts(), {});
  } finally {
    t.restore();
  }
});

test('review 11: a successful sign-in clears what an ignored press flagged (later runs and discover see a real account)', async () => {
  reset();
  D.saveAccount(site, { email: 'me@example.com', verified: false, createIgnored: '2026-10-09T10:00:00.000Z', createIgnoredRun: 'run-x', createIgnoredContinues: 0, viaOwnerClick: true, signInRefused: false });
  assert.strictEqual(D.hasAccount(site), false);
  const t = tenant(signIn(), () => ({ ...applyForm() }));
  try {
    const run = freshRun({ id: 'run-x', continues: 1, ownerTapAt: '2026-10-09T10:05:00.000Z' });
    const res = await A.stepAuth(run, await A.snapshot(1));
    assert.strictEqual(res, null, 'one sign-in, it went through');
    assert.strictEqual(t.clicks.length, 1);
    const acc = D.accounts()[site];
    assert.ok(!acc.createIgnored);
    assert.strictEqual(acc.verified, true);
    assert.strictEqual(acc.viaOwnerClick, false);
    assert.strictEqual(D.hasAccount(site), true);
  } finally {
    t.restore();
  }
});

test('review 12: the press itself throws: recorded as ignored, no sign-in with the made-up password later', async () => {
  reset();
  const t = tenant(signUp(), () => verifyNotice(), { clickThrows: true });
  try {
    const run = freshRun();
    const res = await A.stepAuth(run, await A.snapshot(1));
    assert.strictEqual(res.status, 'blocked');
    assert.strictEqual(run.needs[0].type, 'workday_create_account');
    const acc = D.accounts()[site];
    assert.ok(acc.createIgnored && acc.pendingOwnerClick);
    assert.strictEqual(D.hasAccount(site), false);
    t.cur = signIn();
    run.continues = 1;
    const again = await A.stepAuth(run, await A.snapshot(1));
    assert.strictEqual(again.status, 'blocked', 'no sign-in attempt');
    assert.deepStrictEqual(presses(t), [], 'nothing pressed (the throwing press never landed)');
  } finally {
    t.restore();
  }
});

test('review 13: an error the sign-up page already showed does not make the press look ignored', async () => {
  const before = signUp({ errors: ['invalid: Password'] });
  const mk = (o) => ({ ...o, frames: [] });
  assert.strictEqual(A.createOutcome(mk(before), mk(signUp({ errors: ['invalid: Password'] }))), 'same');
  assert.strictEqual(A.createOutcome(mk(before), mk(signUp({ errors: ['invalid: Password', 'Email already exists'] }))), 'error');
  assert.deepStrictEqual(A.newErrors(mk(before), mk(signUp({ errors: ['invalid: Password', 'x'] }))), ['x']);
  reset();
  const t = tenant(signUp({ errors: ['invalid: Password'] }), () => verifyNotice());
  try {
    const run = freshRun();
    const res = await A.stepAuth(run, await A.snapshot(1));
    assert.strictEqual(res.status, 'needs_input');
    assert.strictEqual(run.needs[0].type, 'email_verification');
  } finally {
    t.restore();
  }
});

test('review 14: `jobctl continue <run> --owner` (resume opts.owner) is the only unlock; a bare continue is not', async () => {
  const R = require('../lib/runs');
  const done = { url: `https://${HOST}/x/thanks`, title: 'Thanks', heading: 'Thank you', top: true, fields: [], buttons: [], signals: sig({ confirmation: true }) };
  const t = tenant(done, null);
  try {
    const mkRun = (status) => {
      const r = R.create(`https://${HOST}/en-US/External/job/x`, {});
      r.tabId = 1;
      r.status = status;
      R.save(r);
      return r.id;
    };
    const a = mkRun('needs_input');
    await A.resume(a, {});
    assert.ok(!R.load(a).ownerTapAt, 'a bare continue leaves no owner signal');
    const b = mkRun('needs_input');
    await A.resume(b, { owner: true });
    assert.ok(R.load(b).ownerTapAt, 'continue --owner records it');
  } finally {
    t.restore();
  }
});

test('owner 2026-10-09: a Sign In page on a blocked tenant is filled (never pressed) so the owner only taps', async () => {
  reset();
  const t = tenant(signIn(), null);
  try {
    D.saveAccount(site, { email: 'me@example.com', createIgnored: new Date().toISOString(), createIgnoredRun: 'other', viaOwnerClick: true });
    const run = freshRun();
    const res = await A.stepAuth(run, await A.snapshot(1));
    assert.strictEqual(res.status, 'blocked');
    assert.strictEqual(t.fills, 1, 'email + password filled');
    assert.deepStrictEqual(t.clicks, [], 'nothing pressed');
  } finally {
    t.restore();
  }
});

test('owner 2026-10-09: an existing account (signed in before, UMBERMOOR) switches to Sign In instead of pressing Create Account', async () => {
  reset();
  const t = tenant(signUp({}), (ref) => (ref === '7' ? signIn() : null));
  t.cur.buttons.push(btn('Sign In', { ref: '7' }));
  try {
    D.saveAccount(site, { email: 'me@example.com', verified: true });
    const run = freshRun();
    const res = await A.stepAuth(run, await A.snapshot(1));
    assert.strictEqual(res, null, 'carries on');
    assert.deepStrictEqual(t.clicks, ['7'], 'pressed the Sign In link, not Create Account');
    assert.ok(!D.accounts()[site].createPressedAt, 'no create press recorded');
    // Next pass: the Sign In page signs in normally (one press of the Sign In button).
    t.onClick = () => applyForm();
    const next = await A.stepAuth(run, await A.snapshot(1));
    assert.strictEqual(next, null);
    assert.deepStrictEqual(t.clicks, ['7', '9']);
  } finally {
    t.restore();
  }
});

test('owner 2026-10-09: a real account whose stored password is refused resets it by email, then sets a new keyring password', async () => {
  reset();
  const forgotPage = () => ({ url: URL1, title: 'Forgot Password', heading: 'Forgot your password?', top: true, fields: [fld('Email Address', { kind: 'email', ref: '3' })], buttons: [btn('Submit', { ref: '4' })], signals: sig() });
  const sent = () => ({ url: URL1, title: 'Check email', heading: 'Check your email', top: true, fields: [], buttons: [], signals: sig({ verifyEmail: true }) });
  const resetPage = () => ({ url: URL1, title: 'Reset Password', heading: 'Reset Password', top: true, fields: [fld('New Password', { kind: 'password' }), fld('Verify New Password', { kind: 'password' })], buttons: [btn('Submit', { ref: '5' })], signals: sig({ passwordFields: 2 }) });
  const refused = () => ({ ...signIn({ errors: ['The username or password is incorrect'] }), buttons: [btn('Sign In', { aid: 'click_filter', ref: '9' }), btn('Forgot your password?', { ref: '6' })] });
  const t = tenant(signIn(), (ref) => ({ 9: refused(), 6: forgotPage(), 4: sent(), 5: applyForm() })[ref]);
  const stored = [];
  const saved = { set: S.set, generate: S.generate };
  S.set = (site, pw) => stored.push([site, pw]);
  S.generate = () => 'new-Pw-1!';
  try {
    D.saveAccount(site, { email: 'me@example.com', verified: true });
    const run = freshRun();
    const res = await A.stepAuth(run, await A.snapshot(1));
    assert.strictEqual(res.status, 'needs_input');
    assert.strictEqual(run.needs[0].type, 'email_verification');
    assert.strictEqual(run.needs[0].reset, true);
    assert.deepStrictEqual(t.clicks, ['9', '6', '4'], 'one sign-in, Forgot, Submit');
    assert.ok(t.sets.some((x) => x.value === 'me@example.com'), 'email entered on the forgot page');
    assert.ok(D.accounts()[site].resetPending);
    // The emailed link opens the reset page.
    t.cur = resetPage();
    run.authAttempts = 0;
    const next = await A.stepAuth(run, await A.snapshot(1));
    assert.strictEqual(next, null);
    assert.deepStrictEqual(stored, [[site, 'new-Pw-1!']], 'new password in the keyring');
    assert.deepStrictEqual(t.clicks.slice(-1), ['5']);
    assert.strictEqual(D.accounts()[site].resetPending, false);
  } finally {
    Object.assign(S, saved);
    t.restore();
  }
});

test('a reset page the driver did not ask for is never touched', async () => {
  reset();
  const resetPage = { url: URL1, title: 'Reset Password', heading: 'Reset Password', top: true, fields: [fld('New Password', { kind: 'password' }), fld('Verify New Password', { kind: 'password' })], buttons: [btn('Submit', { ref: '5' })], signals: sig({ passwordFields: 2 }) };
  const t = tenant(resetPage, null);
  const saved = { set: S.set };
  let setCalled = false;
  S.set = () => { setCalled = true; };
  try {
    D.saveAccount(site, { email: 'me@example.com', verified: true });
    await A.stepAuth(freshRun(), await A.snapshot(1)).catch(() => null);
    assert.strictEqual(setCalled, false);
    assert.ok(!t.clicks.includes('5'));
  } finally {
    Object.assign(S, saved);
    t.restore();
  }
});

test('nav: a Workday footer button that ignores the plain click is pressed on its automation id (QUARRYHALL); never a Submit', async () => {
  reset();
  const page2 = () => ({ ...applyForm(), heading: 'My Experience', signals: sig({ workdayPage: 'applyFlowMyExperiencePage' }) });
  const form = () => { const f = applyForm(); f.fields = f.fields.map((x) => ({ ...x, value: 'x' })); f.buttons = [btn('Save and Continue', { aid: 'pageFooterNextButton', ref: '7' })]; return f; };
  const t = tenant(form(), () => null, { onPress: (sel) => (/pageFooterNextButton|click_filter/.test(sel) ? page2() : null) });
  try {
    const run = freshRun({ url: `https://${HOST}/x`, submits: {} });
    const res = await A.pressNav(run, await A.snapshot(1), D.profile());
    assert.strictEqual(res, null);
    assert.ok(t.pressed && t.pressed.length >= 1, 'pressed by selector after the plain click did nothing');
    assert.strictEqual(t.cur.heading, 'My Experience');
  } finally {
    t.restore();
  }
});

test('nav: only a disabled Apply -> validation stop naming the empty required field; hCaptcha + "Please try again" -> blocked', async () => {
  reset();
  A.TUNE.navWaitMs = 300;
  const rip = () => ({ url: 'https://ats.rippling.com/x/apply', title: 'Apply', heading: '', top: true, fields: [fld('Location', { value: '' }), fld('Name', { value: 'N', required: false })], buttons: [btn('Apply', { ref: '7', disabled: true })], signals: sig() });
  let t = tenant(rip(), null);
  try {
    const run = freshRun({ url: 'https://ats.rippling.com/x', submits: {} });
    const res = await A.pressNav(run, await A.snapshot(1), D.profile());
    assert.strictEqual(res.status, 'needs_input');
    assert.strictEqual(run.needs[0].type, 'validation');
    assert.deepStrictEqual(run.needs[0].emptyRequired.map((f) => f.label), ['Location']);
    assert.deepStrictEqual(t.clicks, [], 'the disabled button is never pressed');
  } finally {
    t.restore();
  }
  const icims = () => ({ url: 'https://us-careers-cedarhall.icims.com/jobs/1/x/candidate', title: 'Candidate Profile', heading: '', top: true, fields: [fld('City', { value: 'H' }), fld('State', { value: 'VA' })], buttons: [btn('Close hCaptcha attribution notice', { ref: '5' })], signals: sig({ errors: ['Please try again. ⚠️'] }) });
  t = tenant(icims(), null);
  try {
    const run = freshRun({ url: 'https://us-careers-cedarhall.icims.com/jobs/1', submits: {} });
    const res = await A.pressNav(run, await A.snapshot(1), D.profile());
    assert.strictEqual(res.status, 'blocked');
    assert.strictEqual(run.needs[0].type, 'captcha');
  } finally {
    t.restore();
    A.TUNE.navWaitMs = 15000;
  }
});

test('nav: questions that render while waiting for Next are filled first, never pressed past (Acme / Hollowridge 2026-10-09)', async () => {
  reset();
  A.TUNE.navWaitMs = 1500;
  // Loading step: no questions yet, Save and Continue greyed. Then the questions and an enabled button render.
  const loading = () => ({ ...applyForm(), heading: 'Application Questions', fields: [], buttons: [btn('Save and Continue', { aid: 'pageFooterNextButton', ref: '7', disabled: true })] });
  const rendered = () => ({ ...applyForm(), heading: 'Application Questions', fields: [fld('Are you 18 years of age or older?'), fld('Do you require sponsorship?')], buttons: [btn('Save and Continue', { aid: 'pageFooterNextButton', ref: '7' })] });
  const t = tenant(loading(), null);
  let n = 0;
  const page = C.page;
  C.page = async (tabId, fn, args) => {
    if (fn === 'snapshot' && ++n === 3) t.cur = rendered();
    return page(tabId, fn, args);
  };
  try {
    const run = freshRun({ url: `https://${HOST}/x`, submits: {} });
    const res = await A.pressNav(run, await A.snapshot(1), D.profile());
    assert.strictEqual(res, null, 'back to the loop to fill the new questions');
    assert.deepStrictEqual(t.clicks, [], 'Save and Continue not pressed over unanswered questions');
  } finally {
    t.restore();
    A.TUNE.navWaitMs = 15000;
  }
});

test('classify: a Workday step whose text says "Thank you for your application" but still shows Save and Continue is not done (Allison WOTC)', () => {
  const wotc = { ...applyForm(), heading: 'Take Assessment', fields: [], buttons: [btn('Take Assessment'), btn('Back', { aid: 'pageFooterBackButton' }), btn('Save and Continue', { aid: 'pageFooterNextButton' })], signals: sig({ confirmation: true }) };
  assert.notStrictEqual(A.classify(wotc), 'done');
  const real = { ...wotc, url: `https://${HOST}/en-US/External/jobTasks/completed/application`, buttons: [btn('Close')] };
  assert.strictEqual(A.classify(real), 'done');
});

test('classify: a Workday step with one question and its footer Next is a form (DRIFTRIDGE "Are you a U.S. Citizen?")', () => {
  const one = { ...applyForm(), heading: 'Application Questions 2 of 2', fields: [fld('Are you a U.S. Citizen?', { kind: 'combobox' })], buttons: [btn('Save and Continue', { aid: 'pageFooterNextButton' })] };
  assert.strictEqual(A.classify(one), 'form');
});

test('nav: a confirmation page reached while looking for Next goes back to the loop, not a no_navigation stop (Ravenvale)', async () => {
  reset();
  A.TUNE.navWaitMs = 300;
  const conf = () => ({ url: 'https://job-boards.greenhouse.io/embed/job_app/confirmation?for=ravenvalellc&token=1', title: 'Ravenvale', heading: '', top: true, fields: [], buttons: [btn('View more jobs at Ravenvale LLC', { ref: '3' }), btn('Track your application', { ref: '4' })], signals: sig({ confirmation: true }) });
  const t = tenant(conf(), null);
  try {
    const run = freshRun({ url: 'https://job-boards.greenhouse.io/ravenvalellc/jobs/1', submits: {} });
    const res = await A.pressNav(run, await A.snapshot(1), D.profile());
    assert.strictEqual(res, null);
    assert.notStrictEqual(run.status, 'needs_input');
    assert.deepStrictEqual(t.clicks, [], 'nothing pressed on the confirmation page');
  } finally {
    t.restore();
    A.TUNE.navWaitMs = 15000;
  }
});
