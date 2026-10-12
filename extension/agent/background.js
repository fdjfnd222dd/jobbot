/*
 * agent/background.js
 *
 * The browser half of jobbot. It holds one native-messaging port to the
 * `jobbot` host (host/jobbot-host.js), which relays commands from the jobctl
 * CLI over a unix socket. Every command is { id, cmd, args } and gets exactly
 * one reply { id, ok, result } or { id, ok: false, error }.
 *
 * This file only moves tabs around and runs code in pages. All form logic
 * lives in the page: Formhand's engine (core/, adapters/, copied in by
 * scripts/sync-formhand.sh) plus agent/page.js, which exposes globalThis.JB.
 *
 * Persistent MV2 background on purpose: an MV3 event page can be suspended,
 * which would drop the native port in the middle of an application.
 */
'use strict';

const HOST = 'jobbot';

// Same dependency order as Formhand's background.js, minus its storage runner,
// plus the agent toolkit last.
const FILES = [
  'core/matcher.js',
  'core/standard.js',
  'core/qa.js',
  'core/company.js',
  'core/embed.js',
  'core/filler.js',
  'core/widgets.js',
  'core/feedback.js',
  'core/storage.js',
  'adapters/generic.js',
  'adapters/greenhouse.js',
  'adapters/avature.js',
  'adapters/phenom.js',
  'adapters/workday.js',
  'adapters/eightfold.js',
  'core/autofill.js',
  'core/learn.js',
  'agent/page.js',
];
const isOptional = (f) => f.startsWith('adapters/') && f !== 'adapters/generic.js';

// Tab-group lanes; keep in step with LANES in lib/lanes.js.
const LANES = {
  owner: { title: 'NEEDS YOU', color: 'red' },
  work: { title: 'JOBBOT WORKING', color: 'green' },
  done: { title: 'DONE', color: 'grey' },
};

let port = null;
let retry = 1000;
// A stamp per extension start: pages injected by an older build get the fresh code
// after `jobctl reload` (page.js edits take effect without restarting Firefox).
const BUILD = String(Date.now());

/* ------------------------------------------------------------------ */
/* Native port                                                          */
/* ------------------------------------------------------------------ */

function setBadge(text, color) {
  try {
    browser.browserAction.setBadgeText({ text });
    browser.browserAction.setBadgeBackgroundColor({ color });
    browser.browserAction.setTitle({ title: text ? 'Jobbot: not connected to jobctl host' : 'Jobbot: connected' });
  } catch (e) {
    /* cosmetic */
  }
}

function connect() {
  try {
    port = browser.runtime.connectNative(HOST);
  } catch (err) {
    console.error('[jobbot] connectNative failed', err);
    return scheduleReconnect();
  }
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener((p) => {
    console.warn('[jobbot] host disconnected', p && p.error);
    port = null;
    setBadge('off', '#b00020');
    scheduleReconnect();
  });
  setBadge('', '#2e7d32');
  retry = 1000;
}

function scheduleReconnect() {
  setTimeout(connect, retry);
  retry = Math.min(retry * 2, 30000);
}

function reply(id, ok, payload) {
  if (!port) return;
  try {
    port.postMessage(ok ? { id, ok: true, result: payload === undefined ? null : payload } : { id, ok: false, error: String(payload) });
  } catch (err) {
    console.error('[jobbot] reply failed', err);
  }
}

async function onMessage(msg) {
  const { id, cmd, args } = msg || {};
  const fn = COMMANDS[cmd];
  if (!fn) return reply(id, false, `unknown command: ${cmd}`);
  try {
    reply(id, true, await fn(args || {}));
  } catch (err) {
    reply(id, false, (err && err.message) || err);
  }
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                 */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tabs opened by a page (an "Apply" link with target=_blank), newest last.
const spawned = [];
browser.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId != null) spawned.push({ tabId: tab.id, opener: tab.openerTabId, at: Date.now() });
  if (spawned.length > 50) spawned.shift();
});

/**
 * Resolve with the tab once it is 'complete'. Event driven (tabs.onUpdated), not a 250 ms poll:
 * returns at once when it already is, else on the 'complete' event, else after `timeout` ms.
 * A tab that is closed meanwhile (tabs.onRemoved) rejects at once: waiting out the timeout on a tab that no
 * longer exists only stalled the caller (up to 30 s) before it learned the page was gone.
 */
async function waitComplete(tabId, timeout) {
  const first = await browser.tabs.get(tabId);
  if (first.status === 'complete') return first;
  return new Promise((resolve, reject) => {
    let done = false;
    const gone = () => new Error(`tab ${tabId} was closed`);
    const end = () => {
      done = true;
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(cap);
    };
    const finish = async () => {
      if (done) return;
      end();
      try {
        resolve(await browser.tabs.get(tabId));
      } catch (err) {
        reject(gone()); // closed between the event and the read
      }
    };
    const onUpdated = (id, change) => {
      if (id === tabId && change.status === 'complete') finish();
    };
    const onRemoved = (id) => {
      if (id !== tabId || done) return;
      end();
      reject(gone());
    };
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
    const cap = setTimeout(finish, timeout || 30000);
    // It may have closed while the first read above was in flight (before onRemoved was listening).
    browser.tabs.get(tabId).catch(() => onRemoved(tabId));
  });
}

/**
 * Start a navigation (`start()` returns the tab: tabs.create / tabs.update / tabs.goBack) and wait for
 * it to finish. The old code slept 300-500 ms "so the load has started", then polled every 250 ms.
 * Here the tabs.onUpdated listener is attached BEFORE the navigation starts, so the 'loading' ->
 * 'complete' pair is seen exactly; a tab that never starts loading (same-document navigation, a
 * no-op goBack) is accepted once `grace` ms pass and it reads 'complete'. A fresh tab's initial
 * about:blank 'complete' is not the page: it is skipped when a real URL was asked for.
 */
async function navigate(start, { url, timeout, grace }) {
  const seen = new Map(); // tabId -> { loading: a load started since we began }
  let wake = null;
  const onUpdated = (id, change) => {
    const s = seen.get(id) || { loading: false };
    if (change.status === 'loading') s.loading = true;
    seen.set(id, s);
    if (wake && change.status) wake(id);
  };
  browser.tabs.onUpdated.addListener(onUpdated);
  try {
    const tab = await start();
    const tabId = tab.id;
    const began = Date.now();
    const real = (t) => t.status === 'complete' && !(t.url === 'about:blank' && url && url !== 'about:blank');
    return await new Promise((resolve) => {
      let done = false;
      let running = false;
      let again = false;
      const finish = async () => {
        if (done) return;
        done = true;
        clearTimeout(cap);
        clearTimeout(graceTimer);
        try {
          resolve(await browser.tabs.get(tabId));
        } catch (err) {
          resolve(tab); // tab closed meanwhile
        }
      };
      // One look at the tab: true when the navigation is over. A load we saw start ends when the tab reads
      // 'complete'; one that never started (same-document navigation, no-op goBack) is accepted after `grace`.
      const step = async () => {
        const s = seen.get(tabId) || { loading: false };
        const t = await browser.tabs.get(tabId);
        return real(t) && (s.loading || Date.now() - began >= grace);
      };
      // Events that land while a look is in flight trigger one more look (none is dropped).
      const check = async () => {
        if (done) return;
        if (running) {
          again = true;
          return;
        }
        running = true;
        try {
          do {
            again = false;
            if (await step()) return finish();
          } while (again && !done);
        } catch (err) {
          return finish(); // tab gone
        } finally {
          running = false;
        }
      };
      wake = (id) => id === tabId && check();
      const cap = setTimeout(finish, timeout || 45000);
      const graceTimer = setTimeout(check, grace);
      check();
    });
  } finally {
    browser.tabs.onUpdated.removeListener(onUpdated);
  }
}

function tabInfo(t) {
  return { tabId: t.id, windowId: t.windowId, url: t.url, title: t.title, status: t.status, active: t.active, groupId: t.groupId != null ? t.groupId : -1 };
}

/* ------------------------------------------------------------------ */
/* Injection                                                            */
/* ------------------------------------------------------------------ */

async function framesOf(tabId) {
  const frames = (await browser.webNavigation.getAllFrames({ tabId })) || [];
  return frames.filter((f) => /^https?:|^file:/.test(f.url));
}

// Which frames already have the toolkit (JB) loaded.
async function loadedFrames(tabId) {
  try {
    const res = await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (b) => !!(globalThis.JB && globalThis.JB.ready && globalThis.JB.build === b),
      args: [BUILD],
    });
    return new Set(res.filter((r) => r.result).map((r) => r.frameId));
  } catch (err) {
    return new Set();
  }
}

async function injectFrame(tabId, frameId) {
  const target = { tabId, frameIds: [frameId] };
  let batch = [];
  const flush = async () => {
    if (batch.length) await browser.scripting.executeScript({ target, files: batch });
    batch = [];
  };
  for (const file of FILES) {
    if (!isOptional(file)) {
      batch.push(file);
      continue;
    }
    await flush();
    try {
      await browser.scripting.executeScript({ target, files: [file] });
    } catch (err) {
      console.warn('[jobbot] adapter failed to load', file, err);
    }
  }
  await flush();
  await browser.scripting.executeScript({ target, func: (b) => { globalThis.JB.build = b; }, args: [BUILD] });
}

// The frames of each tab known to carry the toolkit, so a page call does not re-probe every frame
// (getAllFrames + an executeScript round trip into all of them) before each command. A tab's entry is
// dropped when a document in it is replaced (webNavigation.onCommitted / onDOMContentLoaded: a new page,
// a late iframe), when the tab closes, and after any failed call. `gen` counts those drops, so a probe
// that was in flight when the page changed cannot store its stale answer afterwards.
const readyCache = new Map(); // tabId -> number[] (frame ids)
const gen = new Map(); // tabId -> number

function forgetFrames(tabId) {
  readyCache.delete(tabId);
  gen.set(tabId, (gen.get(tabId) || 0) + 1);
}

browser.webNavigation.onCommitted.addListener((d) => forgetFrames(d.tabId));
browser.webNavigation.onDOMContentLoaded.addListener((d) => forgetFrames(d.tabId));
browser.tabs.onRemoved.addListener((tabId) => {
  forgetFrames(tabId);
  gen.delete(tabId);
});

/** Make sure every frame of the tab has the toolkit; returns their ids. `fresh` skips the cache. */
async function ensureInjected(tabId, fresh) {
  if (!fresh && readyCache.has(tabId)) return readyCache.get(tabId);
  const seen = gen.get(tabId) || 0;
  const frames = await framesOf(tabId);
  const have = await loadedFrames(tabId);
  const out = [];
  for (const f of frames) {
    if (have.has(f.frameId)) {
      out.push(f.frameId);
      continue;
    }
    try {
      await injectFrame(tabId, f.frameId);
      out.push(f.frameId);
    } catch (err) {
      // about:blank-ish or privileged frames: skip quietly
    }
  }
  if ((gen.get(tabId) || 0) === seen) readyCache.set(tabId, out);
  return out;
}

// Errors from scripting.executeScript that mean the function never started: the frame / tab / receiver is not
// there (a stale cached frame id, a frame gone before the injection, no host permission). Only these may be
// retried. Anything else (a frame that "was removed" mid-call, a lost reply, an unknown failure) may come from a
// call that already ran and made the page navigate: replaying a click, a pressSelector or an upload would do it twice.
const NOT_STARTED = /invalid frame id|no frame|no matching frame|invalid tab id|no tab with id|no window matching|receiving end does not exist|could not establish connection|missing host permission|cannot access (?:contents|a chrome)/i;

/**
 * Run JB[fn](args) in the given frames (default: every frame) and collect results.
 *
 * The page function must not run twice in a frame. A second pass with a fresh frame probe happens only for what
 * provably never ran: the cached frame set was stale (a frame we were asked for is not in it, nothing accepts
 * scripts, executeScript failed with a NOT_STARTED error), or a frame answered "no such page function" (the toolkit
 * was not there, so nothing executed). That retry covers only the frames that did not run; the other frames'
 * results are kept. A frame whose call errored in any other way is reported as it is, never replayed.
 */
async function callPage(tabId, fn, args, frameIds) {
  const asked = frameIds && frameIds.length ? frameIds : null;
  const ran = new Map(); // frameId -> { frameId, result, error }: the function ran (or may have) in that frame
  let redo = null; // frames the function demonstrably did not run in; the retry goes to these only
  const out = () => Array.from(ran.values());
  for (let attempt = 0; ; attempt++) {
    const cached = attempt === 0 && readyCache.has(tabId);
    const ready = await ensureInjected(tabId, attempt > 0);
    const wanted = (redo || asked || []).filter((f) => !ran.has(f));
    const targets = redo || asked ? wanted.filter((f) => ready.includes(f)) : ready.filter((f) => !ran.has(f));
    const missing = (redo || asked) && targets.length < wanted.length;
    if (!targets.length || missing) {
      forgetFrames(tabId);
      if (cached) continue;
      if (!targets.length) {
        if (ran.size) return out(); // the frames that did not run are gone: answer with the ones that did
        throw new Error('no frame of this tab accepts scripts (privileged page?)');
      }
    }
    let res;
    try {
      res = await browser.scripting.executeScript({
        target: { tabId, frameIds: targets },
        func: (name, a) => {
          const JB = globalThis.JB;
          if (!JB || typeof JB[name] !== 'function') return { __error: 'no such page function: ' + name };
          return Promise.resolve()
            .then(() => JB[name](a))
            // Firefox's e.stack has no message: send the message, plus the first stack frame for debugging.
            .catch((e) => ({ __error: e && e.message ? `${e.message}${e.stack ? ` [at ${String(e.stack).split('\n')[0].replace(/moz-extension:\/\/[^/]+\//, '')}]` : ''}` : String((e && e.stack) || e) }));
        },
        args: [fn, args || {}],
      });
    } catch (err) {
      forgetFrames(tabId);
      if (cached && NOT_STARTED.test(String((err && err.message) || err))) continue; // never started: safe to run again
      if (ran.size) {
        for (const f of targets) ran.set(f, { frameId: f, result: undefined, error: String((err && err.message) || err) });
        return out();
      }
      throw err;
    }
    const lost = [];
    for (const r of res) {
      if (!r.error && r.result && /^no such page function/.test(r.result.__error || '')) lost.push(r);
      else ran.set(r.frameId, { frameId: r.frameId, result: r.result, error: r.error ? String(r.error) : undefined });
    }
    // A frame that errored may have run the function: report it, and drop the frame cache so the next call re-probes.
    if (res.some((r) => r.error)) forgetFrames(tabId);
    if (lost.length) {
      forgetFrames(tabId);
      if (cached) {
        redo = lost.map((r) => r.frameId);
        continue;
      }
      for (const r of lost) ran.set(r.frameId, { frameId: r.frameId, result: r.result, error: undefined });
    }
    return out();
  }
}

/* ------------------------------------------------------------------ */
/* Commands                                                             */
/* ------------------------------------------------------------------ */

const COMMANDS = {
  async ping() {
    const info = await browser.runtime.getBrowserInfo();
    return { extension: browser.runtime.getManifest().version, browser: `${info.name} ${info.version}` };
  },

  async open({ url, active }) {
    return tabInfo(await navigate(() => browser.tabs.create({ url, active: active !== false }), { url, timeout: 45000, grace: 1000 }));
  },

  async goto({ tabId, url }) {
    return tabInfo(await navigate(() => browser.tabs.update(tabId, { url }), { url, timeout: 45000, grace: 1000 }));
  },

  async back({ tabId }) {
    return tabInfo(
      await navigate(
        async () => {
          await browser.tabs.goBack(tabId);
          return browser.tabs.get(tabId);
        },
        { timeout: 30000, grace: 700 }
      )
    );
  },

  async tab({ tabId }) {
    return tabInfo(await browser.tabs.get(tabId));
  },

  async tabs() {
    return (await browser.tabs.query({})).map(tabInfo);
  },

  async activate({ tabId }) {
    const t = await browser.tabs.update(tabId, { active: true });
    await browser.windows.update(t.windowId, { focused: true });
    return tabInfo(t);
  },

  async close({ tabId }) {
    await browser.tabs.remove(tabId);
    return true;
  },

  async waitLoad({ tabId, timeout }) {
    return tabInfo(await waitComplete(tabId, timeout));
  },

  /** Tabs opened by `opener` since `since` (ms epoch). */
  async spawned({ opener, since }) {
    return spawned.filter((s) => s.opener === opener && s.at >= (since || 0)).map((s) => s.tabId);
  },

  async frames({ tabId }) {
    return framesOf(tabId);
  },

  async inject({ tabId }) {
    return ensureInjected(tabId, true);
  },

  async call({ tabId, fn, args, frameIds }) {
    return callPage(tabId, fn, args, frameIds);
  },

  async screenshot({ tabId, quality }) {
    const t = await browser.tabs.update(tabId, { active: true });
    await sleep(250);
    return browser.tabs.captureVisibleTab(t.windowId, { format: 'jpeg', quality: quality || 55 });
  },

  /** Restart the extension (picks up edited agent/ files). The port drops and reconnects. */
  async reload() {
    setTimeout(() => browser.runtime.reload(), 200);
    return { build: BUILD };
  },

  /**
   * Move a tab into its lane's tab group (lib/lanes.js): red "NEEDS YOU" first in the strip, green "JOBBOT WORKING",
   * grey "DONE". Groups are found by title in the tab's window, made on first use; Firefox drops an emptied group itself.
   */
  async lane({ tabId, lane }) {
    const spec = LANES[lane];
    if (!spec) throw new Error(`unknown lane: ${lane}`);
    if (!browser.tabs.group || !browser.tabGroups) return { lane, mode: 'none' }; // Firefox < 138: no groups
    const tab = await browser.tabs.get(tabId);
    const groups = await browser.tabGroups.query({ windowId: tab.windowId });
    const found = groups.find((g) => g.title === spec.title);
    if (found && tab.groupId === found.id) return { lane, mode: 'group', groupId: found.id };
    const groupId = await browser.tabs.group(found ? { tabIds: [tabId], groupId: found.id } : { tabIds: [tabId], createProperties: { windowId: tab.windowId } });
    if (!found) await browser.tabGroups.update(groupId, { title: spec.title, color: spec.color, collapsed: false });
    // Waiting on the owner goes leftmost, where he looks first.
    if (lane === 'owner') await browser.tabGroups.move(groupId, { index: 0 }).catch(() => {});
    return { lane, mode: 'group', groupId };
  },

  /** Every tab group (lanes are found by title; lib/lanes.js handoffs reads where the owner dragged a tab). */
  async groups() {
    if (!browser.tabGroups) return [];
    return (await browser.tabGroups.query({})).map((g) => ({ groupId: g.id, windowId: g.windowId, title: g.title, color: g.color }));
  },

  async notify({ title, message }) {
    await browser.notifications.create({ type: 'basic', iconUrl: 'icons/icon-96.png', title: title || 'Jobbot', message: message || '' });
    return true;
  },
};

connect();
