'use strict';
// Every path jobbot uses, in one place.
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.JOBBOT_DATA || path.join(ROOT, 'data');
const RUNTIME = process.env.XDG_RUNTIME_DIR || os.tmpdir();

module.exports = {
  ROOT,
  DATA,
  EXTENSION: path.join(ROOT, 'extension'),
  SOCKET: process.env.JOBBOT_SOCKET || path.join(RUNTIME, 'jobbot.sock'),
  LOG_DIR: path.join(DATA, 'logs'),
  RUNS: path.join(DATA, 'runs'),
  RESUMES: path.join(DATA, 'resumes'),
  PROFILE: path.join(DATA, 'profile.json'),
  ANSWERS: path.join(DATA, 'answers.json'),
  ACCOUNTS: path.join(DATA, 'accounts.json'),
  APPLIED: path.join(DATA, 'applied.jsonl'),
  FIREFOX_PROFILE: path.join(DATA, 'firefox-profile'),
  QUEUE: path.join(DATA, 'queue.json'), // lib/queue.js: postings to apply to next (survives /clear)
  LOGGED: path.join(DATA, 'logged.json'), // lib/queue.js: run id -> when its tracker row was written
  SCORECARD: path.join(DATA, 'sessions', 'scorecard.jsonl'), // one line per session (lib/hiccups.js)
  DISCOVER_FUNNEL: path.join(DATA, 'discover-funnel.jsonl'), // one line per discover (lib/discover.js)
};
