// Driver speed (2026-10-09): the fixed waits that cost seconds on every step. Each test fails on the old code by the
// clock or by a call count. Fake pages and a stubbed browser link; no browser, a scratch data dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-waits-'));
process.env.JOBBOT_DATA = DIR;
process.env.JOBBOT_NO_NOTIFY = '1';
fs.writeFileSync(path.join(DIR, 'profile.json'), JSON.stringify({ profile: { email: 'me@example.com' }, extras: {}, standardAnswers: {}, documents: { resume: 'resume.pdf' }, policy: { autoConsent: true, autoSubmit: false } }));
fs.writeFileSync(path.join(DIR, 'accounts.json'), '{}');

const A = require('../lib/apply');
const C = require('../lib/client');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sig = (o) => ({ confirmation: false, alreadyApplied: false, closed: false, verifyEmail: false, captcha: [], passwordFields: 0, errors: [], embeddedForms: [], securityCode: false, uploading: false, workdayPage: null, visibility: 'visible', focus: true, ...o });
const page = (o) => ({ url: 'https://boards.example.com/job/1', title: 't', heading: 'Engineer', top: true, fields: [], buttons: [], ...o, signals: sig((o && o.signals) || {}) });
const btn = (text, extra) => ({ ref: 'b' + text.length, text, ...(extra || {}) });
const fld = (label, extra) => ({ ref: 'f' + label.length, label, kind: 'text', required: true, value: '', ...(extra || {}) });
const freshRun = (extra) => ({ id: 'run-' + Math.random().toString(36).slice(2, 8), url: 'https://boards.example.com/job/1', tabId: 1, steps: [], uploads: {}, authAttempts: 0, continues: 0, created: new Date().toISOString(), ...(extra || {}) });

/** Stub the browser link. `h(fn, args, state)` may return a result for a page call; calls are counted. */
function browser(initial, h) {
  const b = { cur: initial, calls: {}, sends: [], at: {}, saved: { page: C.page, send: C.send } };
  const count = (k) => (b.calls[k] = (b.calls[k] || 0) + 1);
  C.page = async (tabId, fn, args) => {
    count(fn);
    b.at[fn] = Date.now();
    const custom = h ? await h(fn, args, b) : undefined;
    if (custom !== undefined) return [{ frameId: 0, result: custom }];
    if (fn === 'snapshot') return [{ frameId: 0, result: b.cur }];
    if (fn === 'waitQuiet') return [{ frameId: 0, result: 0 }];
    return [{ frameId: 0, result: { ok: true } }];
  };
  C.send = async (cmd, args) => {
    b.sends.push(cmd);
    b.at['send:' + cmd] = Date.now();
    if (cmd === 'tab') return { url: b.cur.url, status: 'complete' };
    if (cmd === 'spawned') return b.spawned ? b.spawned(args) : [];
    if (cmd === 'open') return { tabId: 7 };
    return {};
  };
  b.restore = () => Object.assign(C, b.saved);
  return b;
}

test('click: no fixed 1.2 s sleep; a quiet click looks for a new tab for ~0.6 s at most', async () => {
  const b = browser(page());
  try {
    const run = freshRun();
    const t0 = Date.now();
    await A.click(run, '0:1');
    const ms = Date.now() - t0;
    assert.ok(ms >= 500 && ms < 1000, `quiet click took ${ms} ms`);
    assert.ok(b.calls.click === 1);
  } finally {
    b.restore();
  }
});

test('click: { tab: false } never looks for a new tab and does not wait', async () => {
  const b = browser(page());
  try {
    const t0 = Date.now();
    await A.click(freshRun(), '0:1', { tab: false });
    assert.ok(Date.now() - t0 < 150);
    assert.ok(!b.sends.includes('spawned'));
  } finally {
    b.restore();
  }
});

test('click: the page moved on by itself, so no new tab is awaited; a new tab is followed at once', async () => {
  const b = browser(page(), (fn, args, st) => {
    if (fn === 'click') st.cur = { ...st.cur, url: 'https://boards.example.com/job/1/apply' };
  });
  try {
    const t0 = Date.now();
    await A.click(freshRun(), '0:1');
    assert.ok(Date.now() - t0 < 400, 'url changed: returned early');
  } finally {
    b.restore();
  }
  const c = browser(page());
  c.spawned = () => [42];
  try {
    const run = freshRun();
    const t0 = Date.now();
    await A.click(run, '0:1');
    assert.strictEqual(run.tabId, 42);
    assert.ok(c.sends.includes('activate') && c.sends.includes('waitLoad'));
    assert.ok(Date.now() - t0 < 400);
  } finally {
    c.restore();
  }
});

test('waitChange: polls every 250 ms and returns a changed page once two looks agree (old: 0.9 s first look)', async () => {
  const a = page({ heading: 'Step 1' });
  const nextPage = page({ heading: 'Step 2' });
  let looks = 0;
  const b = browser(a, (fn, args, st) => {
    if (fn === 'snapshot') {
      looks++;
      st.cur = looks >= 2 ? nextPage : a;
    }
  });
  try {
    const run = freshRun();
    const sigBefore = ['https://boards.example.com/job/1', 'Step 1', '', '', false].join('#');
    const t0 = Date.now();
    const after = await A.waitChange(run, sigBefore, 20000);
    const ms = Date.now() - t0;
    assert.strictEqual(after.heading, 'Step 2');
    assert.ok(ms >= 600 && ms < 1100, `took ${ms} ms`);
  } finally {
    b.restore();
  }
});

test('drive: the loop does not settle again right after a waitChange that saw the page hold still; steps carry timings and tab visibility', async () => {
  const landing = page({ buttons: [btn('Apply now')] });
  const done = page({ heading: 'Thank you', signals: { confirmation: true } });
  const b = browser(landing, (fn, args, st) => {
    if (fn === 'click') st.cur = done;
  });
  try {
    const run = freshRun();
    const rep = await A.drive(run);
    assert.strictEqual(rep.status, 'submitted');
    assert.strictEqual(b.calls.waitQuiet, 1, 'one settle for the first look only');
    const timings = run.steps.filter((s) => s.kind === 'timing');
    assert.strictEqual(timings.length, 2);
    assert.strictEqual(timings[0].step, 'landing');
    assert.strictEqual(timings[0].visibility, 'visible');
    assert.strictEqual(timings[0].focus, true);
    for (const k of ['ms', 'settleMs', 'snapshotMs', 'stepMs']) assert.ok(typeof timings[0][k] === 'number', k);
    assert.ok(!rep.lastSteps.some((x) => /^timing/.test(x)), 'the report does not drown in timing lines');
  } finally {
    b.restore();
  }
});

test('snapshot copies tab visibility and focus from the top frame into the merged signals', async () => {
  const b = browser(page({ signals: { visibility: 'hidden', focus: false } }));
  try {
    const s = await A.snapshot(1);
    assert.strictEqual(s.signals.visibility, 'hidden');
    assert.strictEqual(s.signals.focus, false);
  } finally {
    b.restore();
  }
});

test('an unrecognizable page gets one settle and a ~3.5 s look, not four 2.5 s sleeps (old: 10 s)', async () => {
  const blank = page({ heading: '' });
  const b = browser(blank);
  try {
    const run = freshRun();
    const t0 = Date.now();
    const rep = await A.drive(run);
    const ms = Date.now() - t0;
    assert.strictEqual(rep.status, 'blocked');
    assert.ok(ms >= 3000 && ms < 6500, `took ${ms} ms`);
  } finally {
    b.restore();
  }
});

test('an unknown page that finishes loading mid-wait is picked up at once', async () => {
  const blank = page({ heading: '' });
  const done = page({ heading: 'Thank you', signals: { confirmation: true } });
  let looks = 0;
  const b = browser(blank, (fn, args, st) => {
    if (fn === 'snapshot') {
      looks++;
      st.cur = looks > 3 ? done : blank;
    }
  });
  try {
    const t0 = Date.now();
    const rep = await A.drive(freshRun());
    assert.strictEqual(rep.status, 'submitted');
    assert.ok(Date.now() - t0 < 2500);
  } finally {
    b.restore();
  }
});

/* stepForm: no snapshots it does not need. */
const formPage = (extra) =>
  page({
    url: 'https://boards.example.com/apply',
    fields: [fld('First name', { value: 'N' }), fld('Resume', { kind: 'file', for: 'resume' })],
    buttons: [btn('Next')],
    ...(extra || {}),
  });
const fillResult = { adapter: 'test', company: 'Acme', counts: { filled: 1, review: 0, unknown: 0 }, needs: [], files: [] };

test('stepForm: no upload this pass, no settle; no Workday / hand-answer snapshots before Next', async () => {
  const f = formPage();
  let snapsAtClick = null;
  const b = browser(f, (fn, args, st) => {
    if (fn === 'fill') return fillResult;
    if (fn === 'click') {
      snapsAtClick = st.calls.snapshot;
      st.cur = { ...st.cur, heading: 'Step 2' };
    }
  });
  try {
    const run = freshRun({ uploads: { 'https://boards.example.com/apply#resume': 'resume.pdf' } });
    const snap = await A.snapshot(1);
    b.calls.snapshot = 0;
    await A.stepForm(run, snap);
    assert.strictEqual(b.calls.waitQuiet || 0, 0, 'no settle without an upload on this pass');
    assert.strictEqual(snapsAtClick, 1, `snapshots before the Next press: ${snapsAtClick}`);
  } finally {
    b.restore();
  }
});

test('stepForm: the pass that uploads settles (once) and waits out an "uploading" state by polling', async () => {
  const resumeFile = path.join(DIR, 'resume.pdf');
  fs.writeFileSync(resumeFile, '%PDF-1.4 fake');
  const f = formPage();
  let uploadingLooks = 0;
  const b = browser(f, (fn, args, st) => {
    if (fn === 'fill') return fillResult;
    if (fn === 'upload') return { ok: true };
    if (fn === 'click') st.cur = { ...st.cur, heading: 'Step 2' };
    if (fn === 'snapshot' && st.calls.upload && uploadingLooks < 2) {
      uploadingLooks++;
      return { ...st.cur, signals: sig({ uploading: true }) };
    }
  });
  try {
    const run = freshRun({ resume: resumeFile });
    const snap = await A.snapshot(1);
    const t0 = Date.now();
    await A.stepForm(run, snap);
    assert.strictEqual(b.calls.upload, 1);
    assert.strictEqual(b.calls.waitQuiet, 1);
    assert.ok(Date.now() - t0 < 3500, 'two uploading looks cost ~0.8 s, not 2 s');
  } finally {
    b.restore();
  }
});

test('stepForm: hand answers are only checked against the page when a need is left to filter', async () => {
  const run = (extra) => freshRun({ handAnswers: { Mystery: 'owner typed' }, uploads: { 'https://boards.example.com/apply#resume': 'resume.pdf' }, ...(extra || {}) });
  const f = formPage({ fields: [fld('First name', { value: 'N' }), fld('Mystery', { kind: 'text', value: 'owner typed' }), fld('Resume', { kind: 'file', for: 'resume' })] });
  // No need left after the fill: the hand answers need no look at the page.
  let at = null;
  const quiet = browser(f, (fn, args, st) => {
    if (fn === 'fill') return fillResult;
    if (fn === 'click') {
      at = st.calls.snapshot;
      st.cur = { ...st.cur, heading: 'Step 2' };
    }
  });
  try {
    const snap = await A.snapshot(1);
    quiet.calls.snapshot = 0;
    await A.stepForm(run(), snap);
    assert.strictEqual(at, 1, `snapshots before Next: ${at}`);
  } finally {
    quiet.restore();
  }
  // A need the owner already answered by hand: one look drops it, then the page goes on to Next.
  let nextAt = null;
  const withNeed = browser(f, (fn, args, st) => {
    if (fn === 'fill') return { ...fillResult, needs: [{ ref: '0:f7', label: 'Mystery', kind: 'text', required: true }] };
    if (fn === 'click') {
      nextAt = st.calls.snapshot;
      st.cur = { ...st.cur, heading: 'Step 2' };
    }
  });
  try {
    const snap = await A.snapshot(1);
    withNeed.calls.snapshot = 0;
    const res = await A.stepForm(run(), snap);
    assert.strictEqual(res, null, 'not asked again');
    assert.strictEqual(nextAt, 2, 'one look for the hand answers, one before Next');
  } finally {
    withNeed.restore();
  }
});

test('start: the ATS location read overlaps opening the tab (old: read first, up to 15 s)', async () => {
  const posting = require('../lib/posting');
  const savedPosting = posting.posting;
  let readStarted = 0;
  posting.posting = async () => {
    readStarted = Date.now();
    await sleep(500);
    return { location: 'Smithtown, NC' };
  };
  const done = page({ heading: 'Thank you', signals: { confirmation: true } });
  const b = browser(done);
  try {
    const t0 = Date.now();
    const rep = await A.start('https://boards.example.com/job/1', {});
    assert.strictEqual(rep.status, 'submitted');
    assert.ok(b.at['send:open'] - readStarted < 100, 'the tab opened while the read was in flight');
    const run = JSON.parse(fs.readFileSync(path.join(DIR, 'runs', rep.run, 'run.json'), 'utf8'));
    assert.ok(/Smithtown/.test(run.location), 'the location still lands on the run: ' + run.location);
    assert.ok(Date.now() - t0 >= 0);
  } finally {
    posting.posting = savedPosting;
    b.restore();
  }
});

test('pickWorkdayDates: waits for the calendar by looking, not a fixed 1.7 s', async () => {
  const icon = btn('Calendar', { aid: 'dateIcon', ref: 'i1' });
  const day = btn('10', { aid: 'datePickerSelectedToday', ref: 'd1' });
  const closed = page({ buttons: [icon] });
  const open = page({ buttons: [icon, day] });
  const b = browser(closed, (fn, args, st) => {
    if (fn === 'click') st.cur = args.ref === 'i1' ? open : closed;
  });
  try {
    const run = freshRun();
    const t0 = Date.now();
    const n = await A.pickWorkdayDates(run, await A.snapshot(1));
    assert.strictEqual(n, 1);
    assert.ok(Date.now() - t0 < 900, `took ${Date.now() - t0} ms`);
  } finally {
    b.restore();
  }
});

test('review 15: after a Submit the unknown page gets ~12 s (not 3.5) to turn into the confirmation', async () => {
  const blank = page({ heading: '' });
  const done = page({ heading: 'Thank you', signals: { confirmation: true } });
  const t0 = Date.now();
  const b = browser(blank, (fn, args, st) => {
    if (fn === 'snapshot') st.cur = Date.now() - t0 > 4300 ? done : blank;
  });
  try {
    const rep = await A.drive(freshRun({ submitPressedAt: new Date().toISOString() }));
    assert.strictEqual(rep.status, 'submitted', 'a slow confirmation is a confirmation, not needs_review');
  } finally {
    b.restore();
  }
});

test('review 15: a continue after needs_review keeps the Submit cap on that page; after a hand fix it starts again', async () => {
  const R = require('../lib/runs');
  const done = page({ heading: 'Thank you', signals: { confirmation: true } });
  const b = browser(done);
  try {
    const mk = (status) => {
      const r = R.create('https://boards.example.com/job/1', {});
      r.tabId = 1;
      r.status = status;
      r.submits = { 'https://boards.example.com/apply': 2 };
      R.save(r);
      return r.id;
    };
    const review = mk('needs_review');
    await A.resume(review, {});
    assert.deepStrictEqual(R.load(review).submits, { 'https://boards.example.com/apply': 2 });
    const fixed = mk('needs_input');
    await A.resume(fixed, {});
    assert.deepStrictEqual(R.load(fixed).submits, {});
  } finally {
    b.restore();
  }
});
