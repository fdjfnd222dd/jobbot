'use strict';
// jobctl tabs-clean: a run from an earlier browser session must not keep a reused tab id (2026-10-08).
const test = require('node:test');
const assert = require('node:assert');
const R = require('../lib/runs');

test('tabsInUse keeps a tab only while it is on the run site', () => {
  const runs = [
    { tabId: 3, lastUrl: 'https://fda.fa.us1.oraclecloud.com/hcmUI/CandidateExperience/x' },
    { tabId: 10, lastUrl: 'https://fa-etum-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/y' },
    { tabId: 12, lastUrl: 'https://campus-us-ravenhaven.icims.com/jobs/4109/form' },
  ];
  const tabs = [
    { tabId: 3, url: 'https://edbz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/25016392' },
    { tabId: 10, url: 'https://careers.amd.com/careers-home/jobs/93332' },
    { tabId: 12, url: 'https://campus-us-ravenhaven.icims.com/jobs/4109/eeo' },
  ];
  assert.deepStrictEqual(R.tabsInUse(runs, tabs), [12], 'another Oracle tenant or site is not the run tab');
  assert.deepStrictEqual(R.tabsInUse([{ tabId: 5, url: 'https://a.example.com' }], []), []);
});

test('a run with no recorded site keeps its tab', () => {
  assert.deepStrictEqual(R.tabsInUse([{ tabId: 7 }], [{ tabId: 7, url: 'https://x.example.com' }]), [7]);
});

/* ------------------------------------------------------------------ */
/* agent/background.js against a fake `browser` (no Firefox): page-call frame cache and event-driven loads */
/* ------------------------------------------------------------------ */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const plain = (x) => JSON.parse(JSON.stringify(x)); // results cross the vm realm
const emitter = () => {
  const ls = [];
  return { addListener: (f) => ls.push(f), removeListener: (f) => ls.splice(ls.indexOf(f), 1), fire: (...a) => ls.slice().forEach((f) => f(...a)), count: () => ls.length };
};

/** background.js loaded in a vm with a scripted browser. `world` is what the tests poke at. */
function background() {
  const world = {
    frames: [{ frameId: 0, url: 'https://jobs.example.com/apply' }, { frameId: 5, url: 'https://forms.example.com/embed' }],
    loaded: new Set(), // frame ids that carry the toolkit
    n: { getAllFrames: 0, probe: 0, inject: 0, run: 0 },
    failRuns: 0, // the next N page calls throw
    failMessage: 'Invalid frame IDs: [5].', // what they throw (an error that says the call never started)
    failAfterRun: false, // the throwing call ran the page function first (the page navigated under it)
    lostFrames: new Set(), // frames that answer "no such page function" until the toolkit is injected again
    errorFrames: new Set(), // frames whose result entry is an error (the function ran, the reply did not survive)
    runs: [], // 'frameId:fn' for every page function that really executed
    tabs: new Map(),
  };
  const ev = { created: emitter(), updated: emitter(), removed: emitter(), committed: emitter(), dcl: emitter() };
  world.ev = ev;
  const browser = {
    runtime: { connectNative: () => ({ onMessage: emitter(), onDisconnect: emitter(), postMessage() {} }) },
    browserAction: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    tabs: {
      onCreated: ev.created,
      onUpdated: ev.updated,
      onRemoved: ev.removed,
      create: async ({ url }) => {
        const t = { id: 7, windowId: 1, url: 'about:blank', status: 'loading', active: true };
        world.tabs.set(7, t);
        world.onCreate && world.onCreate(t, url);
        return { ...t };
      },
      update: async (id, { url }) => {
        const t = world.tabs.get(id);
        world.onUpdate && world.onUpdate(t, url);
        return { ...t };
      },
      get: async (id) => ({ ...world.tabs.get(id) }),
    },
    webNavigation: {
      onCommitted: ev.committed,
      onDOMContentLoaded: ev.dcl,
      getAllFrames: async () => {
        world.n.getAllFrames++;
        return world.frames;
      },
    },
    scripting: {
      executeScript: async (o) => {
        const src = o.func ? String(o.func) : '';
        if (o.files) {
          if (o.files.includes('core/matcher.js')) world.n.inject++; // once per frame injected
          o.target.frameIds.forEach((f) => {
            world.loaded.add(f);
            world.lostFrames.delete(f);
          });
          return [];
        }
        if (src.includes('JB.ready')) {
          world.n.probe++;
          return world.frames.filter((f) => world.loaded.has(f.frameId)).map((f) => ({ frameId: f.frameId, result: true }));
        }
        if (src.includes('JB.build = b')) return [];
        if (world.failRuns > 0) {
          world.failRuns--;
          if (world.failAfterRun) o.target.frameIds.forEach((f) => world.runs.push(f + ':' + o.args[0]));
          throw new Error(world.failMessage);
        }
        world.n.run++;
        return o.target.frameIds.map((frameId) => {
          if (world.lostFrames.has(frameId)) return { frameId, result: { __error: 'no such page function: ' + o.args[0] } };
          world.runs.push(frameId + ':' + o.args[0]);
          if (world.errorFrames.has(frameId)) return { frameId, error: 'Frame was removed' };
          return { frameId, result: 'ran:' + o.args[0] };
        });
      },
    },
  };
  const ctx = vm.createContext({ browser, console, setTimeout, clearTimeout, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'agent', 'background.js'), 'utf8'), ctx);
  world.C = vm.runInContext('COMMANDS', ctx);
  return world;
}

test('page calls probe the frames once per page, not once per call', async () => {
  const w = background();
  const a = await w.C.call({ tabId: 1, fn: 'snapshot' });
  assert.deepStrictEqual(plain(a.map((r) => r.frameId)), [0, 5]);
  assert.strictEqual(w.n.getAllFrames, 1);
  assert.strictEqual(w.n.probe, 1);
  assert.strictEqual(w.n.inject, 2, 'both frames got the toolkit');
  await w.C.call({ tabId: 1, fn: 'snapshot' });
  await w.C.call({ tabId: 1, fn: 'set', args: { ref: '1' }, frameIds: [5] });
  assert.strictEqual(w.n.getAllFrames, 1, 'cached ready set: no more getAllFrames');
  assert.strictEqual(w.n.probe, 1, 'cached ready set: no more probe into every frame');
  assert.strictEqual(w.n.run, 3);
  await w.C.call({ tabId: 2, fn: 'snapshot' });
  assert.strictEqual(w.n.getAllFrames, 2, 'another tab has its own entry');
});

test('a navigation or a late iframe in the tab drops its cached frames', async () => {
  const w = background();
  await w.C.call({ tabId: 1, fn: 'snapshot' });
  w.ev.committed.fire({ tabId: 1, frameId: 0, url: 'https://jobs.example.com/next' });
  w.loaded.clear(); // the new document has no toolkit
  await w.C.call({ tabId: 1, fn: 'snapshot' });
  assert.strictEqual(w.n.getAllFrames, 2, 'onCommitted: probed again');
  assert.strictEqual(w.n.inject, 4, 'and re-injected');
  w.frames.push({ frameId: 9, url: 'https://late.example.com/x' });
  w.ev.dcl.fire({ tabId: 1, frameId: 9 });
  const r = await w.C.call({ tabId: 1, fn: 'snapshot' });
  assert.deepStrictEqual(plain(r.map((x) => x.frameId)), [0, 5, 9], 'onDOMContentLoaded: the late frame is found');
  w.ev.removed.fire(1);
  await w.C.call({ tabId: 1, fn: 'snapshot' });
  assert.strictEqual(w.n.getAllFrames, 4, 'closing the tab forgets it');
});

test('a probe that was in flight when the page changed does not cache its stale answer', async () => {
  const w = background();
  w.frames = [{ frameId: 0, url: 'https://jobs.example.com/apply' }];
  const probing = w.C.call({ tabId: 1, fn: 'snapshot' });
  w.ev.committed.fire({ tabId: 1, frameId: 0 }); // lands while getAllFrames / probe are awaited
  await probing;
  await w.C.call({ tabId: 1, fn: 'snapshot' });
  assert.strictEqual(w.n.getAllFrames, 2, 'second call probed again instead of trusting the stale set');
});

test('a failed call on cached frames re-probes and retries once; a fresh failure is thrown', async () => {
  const w = background();
  await w.C.call({ tabId: 1, fn: 'snapshot' });
  w.failRuns = 1; // the cached frame set is stale (frame gone)
  const r = await w.C.call({ tabId: 1, fn: 'snapshot' });
  assert.deepStrictEqual(plain(r.map((x) => x.result)), ['ran:snapshot', 'ran:snapshot']);
  assert.strictEqual(w.n.getAllFrames, 2, 'the retry re-probed');
  w.failRuns = 1;
  await w.C.call({ tabId: 1, fn: 'snapshot' }); // cached again, fails, retried
  const w2 = background();
  w2.failRuns = 1;
  await assert.rejects(w2.C.call({ tabId: 1, fn: 'snapshot' }), /Invalid frame IDs/, 'no cache to blame: the error is the caller\'s');
});

test('a call that may have run is never replayed: a throw after the function executed surfaces as it is (click, upload)', async () => {
  const w = background();
  await w.C.call({ tabId: 1, fn: 'snapshot' }); // warm cache
  w.runs.length = 0;
  w.failRuns = 1;
  w.failAfterRun = true; // the click ran, the page navigated, the reply never came
  w.failMessage = 'Frame with ID 0 was removed.';
  await assert.rejects(w.C.call({ tabId: 1, fn: 'click', args: { ref: '3' } }), /was removed/);
  assert.deepStrictEqual(plain(w.runs), ['0:click', '5:click'], 'executed once per frame, not replayed');
  // The cache is dropped, so the NEXT call re-probes (and may run again: that is a new call).
  const probes = w.n.getAllFrames;
  await w.C.call({ tabId: 1, fn: 'snapshot' });
  assert.strictEqual(w.n.getAllFrames, probes + 1);
});

test('an unknown error with a warm cache is not guessed to be "never started"', async () => {
  const w = background();
  await w.C.call({ tabId: 1, fn: 'snapshot' });
  w.runs.length = 0;
  w.failRuns = 1;
  w.failAfterRun = true;
  w.failMessage = 'something nobody has seen';
  await assert.rejects(w.C.call({ tabId: 1, fn: 'pressSelector', args: { selector: 'a.next' } }), /nobody has seen/);
  assert.strictEqual(w.runs.length, 2, 'once per frame');
});

test('a frame whose result entry is an error (it may have run) is reported, not replayed; the other frame answers', async () => {
  const w = background();
  await w.C.call({ tabId: 1, fn: 'snapshot' });
  w.runs.length = 0;
  w.errorFrames.add(5);
  const r = plain(await w.C.call({ tabId: 1, fn: 'click', args: { ref: '2' } }));
  assert.deepStrictEqual(r.map((x) => [x.frameId, x.result, x.error]), [[0, 'ran:click', undefined], [5, undefined, 'Frame was removed']]);
  assert.deepStrictEqual(plain(w.runs), ['0:click', '5:click'], 'each frame executed once');
});

test('frames that lost the toolkit (no such page function) are re-injected and re-run alone; frames that ran keep their result', async () => {
  const w = background();
  await w.C.call({ tabId: 1, fn: 'snapshot' });
  w.runs.length = 0;
  const injected = w.n.inject;
  w.lostFrames.add(5); // the frame navigated to a document without the toolkit; the event has not arrived
  w.loaded.delete(5);
  const r = plain(await w.C.call({ tabId: 1, fn: 'click', args: { ref: '2' } }));
  assert.deepStrictEqual(r.map((x) => [x.frameId, x.result]), [[0, 'ran:click'], [5, 'ran:click']]);
  assert.deepStrictEqual(plain(w.runs), ['0:click', '5:click'], 'frame 0 ran once; frame 5 ran once, after it was injected');
  assert.strictEqual(w.n.inject, injected + 1, 'only the frame without the toolkit was injected');
});

test('asking for a frame the cache does not know re-probes before giving up', async () => {
  const w = background();
  await w.C.call({ tabId: 1, fn: 'snapshot' });
  w.frames.push({ frameId: 9, url: 'https://late.example.com/x' }); // appeared, event not delivered yet
  const r = await w.C.call({ tabId: 1, fn: 'snapshot', frameIds: [9] });
  assert.deepStrictEqual(plain(r.map((x) => x.frameId)), [9]);
  await assert.rejects(w.C.call({ tabId: 1, fn: 'snapshot', frameIds: [77] }), /no frame of this tab accepts scripts/);
});

test('open waits for the real page (tabs.onUpdated), not the blank placeholder, and does not sleep first', async () => {
  const w = background();
  w.onCreate = (t, url) => {
    setTimeout(() => { t.status = 'complete'; w.ev.updated.fire(t.id, { status: 'complete' }, { ...t }); }, 10); // about:blank settles
    setTimeout(() => { t.url = url; t.status = 'loading'; w.ev.updated.fire(t.id, { status: 'loading' }, { ...t }); }, 30);
    setTimeout(() => { t.status = 'complete'; w.ev.updated.fire(t.id, { status: 'complete' }, { ...t }); }, 90);
  };
  const t0 = Date.now();
  const info = await w.C.open({ url: 'https://jobs.example.com/apply' });
  const took = Date.now() - t0;
  assert.strictEqual(info.url, 'https://jobs.example.com/apply');
  assert.strictEqual(info.status, 'complete');
  assert.ok(took >= 85 && took < 280, `resolved on the complete event: ${took} ms`);
  assert.strictEqual(w.ev.updated.count(), 0, 'listener removed');
});

test('goto resolves on the load event; a navigation that never starts loading resolves after the grace period', async () => {
  const w = background();
  w.tabs.set(3, { id: 3, windowId: 1, url: 'https://a.example.com/', status: 'complete', active: true });
  w.onUpdate = (t, url) => {
    setTimeout(() => { t.url = url; t.status = 'loading'; w.ev.updated.fire(t.id, { status: 'loading' }, { ...t }); }, 20);
    setTimeout(() => { t.status = 'complete'; w.ev.updated.fire(t.id, { status: 'complete' }, { ...t }); }, 60);
  };
  let t0 = Date.now();
  const info = await w.C.goto({ tabId: 3, url: 'https://b.example.com/' });
  let took = Date.now() - t0;
  assert.strictEqual(info.url, 'https://b.example.com/');
  assert.ok(took >= 55 && took < 280, `old code slept 500 ms first: ${took} ms`);
  // Same-document navigation: no loading event ever comes.
  w.onUpdate = (t, url) => { t.url = url; };
  t0 = Date.now();
  const same = await w.C.goto({ tabId: 3, url: 'https://b.example.com/#step2' });
  took = Date.now() - t0;
  assert.strictEqual(same.url, 'https://b.example.com/#step2');
  assert.ok(took >= 950 && took < 1500, `grace period: ${took} ms`);
});

test('waitLoad returns at once for a loaded tab, on the event for a loading one, and at the cap for a stuck one', async () => {
  const w = background();
  w.tabs.set(4, { id: 4, windowId: 1, url: 'https://a.example.com/', status: 'complete', active: true });
  let t0 = Date.now();
  await w.C.waitLoad({ tabId: 4 });
  assert.ok(Date.now() - t0 < 100, 'already complete');
  const t = w.tabs.get(4);
  t.status = 'loading';
  setTimeout(() => { t.status = 'complete'; w.ev.updated.fire(4, { status: 'complete' }, { ...t }); }, 60);
  t0 = Date.now();
  assert.strictEqual((await w.C.waitLoad({ tabId: 4 })).status, 'complete');
  assert.ok(Date.now() - t0 < 250, 'resolved on the event, not a 250 ms poll tick');
  t.status = 'loading';
  t0 = Date.now();
  assert.strictEqual((await w.C.waitLoad({ tabId: 4, timeout: 200 })).status, 'loading');
  assert.ok(Date.now() - t0 >= 190 && Date.now() - t0 < 500, 'capped');
  assert.strictEqual(w.ev.updated.count(), 0, 'listeners removed');
});

test('waitLoad on a tab that is closed meanwhile rejects at once (no 30 s wait) and leaves no listeners behind', async () => {
  const w = background();
  w.tabs.set(5, { id: 5, windowId: 1, url: 'https://a.example.com/', status: 'loading', active: true });
  const base = w.ev.removed.count(); // background.js keeps its own onRemoved listener
  setTimeout(() => w.ev.removed.fire(5, { windowId: 1, isWindowClosing: false }), 40);
  const t0 = Date.now();
  await assert.rejects(w.C.waitLoad({ tabId: 5 }), /tab 5 was closed/);
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
  assert.strictEqual(w.ev.updated.count(), 0, 'onUpdated listener removed');
  assert.strictEqual(w.ev.removed.count(), base, 'onRemoved listener removed');
  // Another tab closing does not end the wait.
  const t = w.tabs.get(5);
  setTimeout(() => w.ev.removed.fire(99), 20);
  setTimeout(() => { t.status = 'complete'; w.ev.updated.fire(5, { status: 'complete' }, { ...t }); }, 80);
  assert.strictEqual((await w.C.waitLoad({ tabId: 5 })).status, 'complete');
});
