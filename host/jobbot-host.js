#!/usr/bin/env node
/*
 * host/jobbot-host.js
 *
 * Native-messaging host. Firefox starts this process when the jobbot
 * extension calls runtime.connectNative('jobbot'), and talks to it over
 * stdin/stdout (4-byte little-endian length + JSON, per the WebExtensions
 * native messaging protocol).
 *
 * It opens a unix socket ($XDG_RUNTIME_DIR/jobbot.sock, mode 0600) so the
 * jobctl CLI can reach the extension: each CLI line { id, cmd, args } is
 * forwarded with a host-wide id, and the extension's reply is routed back to
 * the CLI connection that asked. When Firefox closes the port (browser quit,
 * extension reloaded), stdin ends and this process exits.
 */
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { SOCKET, LOG_DIR } = require('../lib/paths');

fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, 'host.log');
function log(...a) {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${a.join(' ')}\n`);
  } catch (e) {
    /* logging must never kill the host */
  }
}

/* ---------------------------- Firefox side ---------------------------- */

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const body = buf.subarray(4, 4 + len).toString('utf8');
    buf = buf.subarray(4 + len);
    try {
      fromExtension(JSON.parse(body));
    } catch (err) {
      log('bad message from extension', err.message);
    }
  }
});
process.stdin.on('end', () => {
  log('firefox closed the port; exiting');
  cleanup();
  process.exit(0);
});

function toExtension(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

/* ----------------------------- CLI side ------------------------------ */

const pending = new Map(); // host id -> { sock, id }
let seq = 0;

function fromExtension(msg) {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (p.sock.destroyed) return;
  p.sock.write(JSON.stringify({ ...msg, id: p.id }) + '\n');
}

function cleanup() {
  try {
    fs.unlinkSync(SOCKET);
  } catch (e) {
    /* already gone */
  }
}

// A socket file left by a host that crashed: remove it, unless a live host owns it.
function start() {
  const server = net.createServer((sock) => {
    let line = '';
    sock.on('data', (d) => {
      line += d.toString('utf8');
      let i;
      while ((i = line.indexOf('\n')) >= 0) {
        const raw = line.slice(0, i);
        line = line.slice(i + 1);
        if (!raw.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch (err) {
          sock.write(JSON.stringify({ id: null, ok: false, error: 'bad json' }) + '\n');
          continue;
        }
        const hid = `h${++seq}`;
        pending.set(hid, { sock, id: msg.id });
        toExtension({ id: hid, cmd: msg.cmd, args: msg.args || {} });
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      for (const [k, v] of pending) if (v.sock === sock) pending.delete(k);
    });
  });
  server.on('error', (err) => {
    log('socket error', err.message);
    process.exit(1);
  });
  server.listen(SOCKET, () => {
    fs.chmodSync(SOCKET, 0o600);
    log('listening on', SOCKET);
  });
}

const probe = net.connect(SOCKET);
probe.on('connect', () => {
  // Another Firefox (another profile) already hosts jobbot. One browser at a time.
  log('another host already owns the socket; exiting');
  probe.end();
  process.exit(0);
});
probe.on('error', () => {
  cleanup();
  start();
});

process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});
