'use strict';
// Talks to the extension through the native host's unix socket.
const net = require('node:net');
const { SOCKET } = require('./paths');

let conn = null;
let seq = 0;
let buf = '';
const waiting = new Map();

function connect() {
  if (conn) return Promise.resolve(conn);
  return new Promise((resolve, reject) => {
    const s = net.connect(SOCKET);
    s.on('connect', () => {
      conn = s;
      resolve(s);
    });
    s.on('error', (err) => {
      conn = null;
      const e = new Error(
        err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
          ? 'browser not connected: start it with `jobctl browser` (or open Firefox with the jobbot extension)'
          : err.message
      );
      e.code = 'NOT_CONNECTED';
      for (const w of waiting.values()) w.reject(e);
      waiting.clear();
      reject(e);
    });
    s.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (e) {
          continue;
        }
        const w = waiting.get(msg.id);
        if (!w) continue;
        waiting.delete(msg.id);
        clearTimeout(w.timer);
        if (msg.ok) w.resolve(msg.result);
        else w.reject(new Error(msg.error));
      }
    });
    s.on('close', () => {
      conn = null;
    });
  });
}

/** Send one command; resolves with the extension's result. */
async function send(cmd, args, timeoutMs) {
  const s = await connect();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`timeout waiting for ${cmd}`));
    }, timeoutMs || 90000);
    waiting.set(id, { resolve, reject, timer });
    s.write(JSON.stringify({ id, cmd, args: args || {} }) + '\n');
  });
}

function close() {
  if (conn) conn.end();
  conn = null;
}

/**
 * A page error as one readable line. Firefox's Error.stack has no message, and the extension used to send only the
 * stack, so a ref that went stale after a re-render came back as "byRef@moz-extension://.../page.js:137:11"
 * (Oracle address autocomplete, Workday, 2026-10-09). A stale ref now says what to do; other stack-only errors
 * name the function and line.
 */
function pageError(raw, ref) {
  const text = String(raw || '');
  const first = text.split('\n')[0];
  if (/not found on this page|^\s*byRef@/.test(first)) {
    return `stale ref${ref ? ' ' + ref : ''}: the page re-rendered since the last snapshot; run \`jobctl snap --brief\` and use the new ref`;
  }
  const frame = first.match(/^([\w$.<>/]*)@\S*?([\w-]+\.js):(\d+):\d+$/);
  if (frame) return `page error in ${frame[1] || 'page script'} (${frame[2]}:${frame[3]}), no message`;
  return text.replace(/\s*\[at [^\]]*\]$/, '').split('\n')[0] || text;
}

/** Call JB.<fn> in a tab's frames. Returns [{ frameId, result }] with page errors surfaced. */
async function page(tabId, fn, args, frameIds, timeoutMs) {
  const res = await send('call', { tabId, fn, args, frameIds }, timeoutMs);
  return res.map((r) => {
    if (r.result && r.result.__error) return { frameId: r.frameId, error: pageError(r.result.__error, args && args.ref) };
    return r;
  });
}

/** A page error that means the ref went stale (pageError's message, or the page script's own words). */
const STALE = /^stale ref|not found on this page/;

/**
 * A stale ref's field in a fresh snapshot: the one field whose label matches the need's (same kind preferred).
 * Null when no field or more than one matches, so a wrong field is never filled (iCIMS once wrote "No" into a Year
 * box through a shifted ref, 2026-10-08).
 */
function relabel(fields, need) {
  const key = (s) => String(s || '').toLowerCase().replace(/\*/g, '').replace(/\s+/g, ' ').trim();
  const want = key(need && need.label);
  if (!want) return null;
  const same = (fields || []).filter((f) => key(f.label) === want);
  const kind = same.filter((f) => !need.kind || f.kind === need.kind);
  const pick = kind.length === 1 ? kind : same.length === 1 ? same : [];
  return pick[0] || null;
}

module.exports = { send, page, close, pageError, relabel, STALE };
