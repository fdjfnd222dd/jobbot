'use strict';
/*
 * The owner's data: profile, standard answers, Q&A bank, accounts, run log.
 * All plain JSON under data/ (gitignored). The Q&A bank uses Formhand's own
 * entry shape and matching (core/qa.js), so an answer saved here fills the
 * same question on any ATS through Formhand's adapters.
 */
const fs = require('node:fs');
const path = require('node:path');
const P = require('./paths');

require('../extension/core/matcher.js');
require('../extension/core/standard.js');
require('../extension/core/company.js');
require('../extension/core/qa.js');
const AF = globalThis.AF;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(`could not read ${file}: ${err.message}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function profile() {
  const p = readJson(P.PROFILE);
  p.policy = { autoConsent: false, autoSubmit: true, ...(p.policy || {}) };
  return p;
}

function answers() {
  return readJson(P.ANSWERS, { entries: [] });
}

const companyOf = (name) => (name ? AF.company.make(String(name), [], 'jobbot') : null);

/**
 * Save an answer for `question` (as shown on the page). With the hiring company's name, the
 * company in both question and answer becomes {company}, so "Why do you want to work at Acme?"
 * is reused as "Why do you want to work at {company}?" on the next posting. Returns the entry.
 */
function saveAnswer(question, answer, context, companyName) {
  const bank = answers();
  const comp = companyOf(companyName);
  const q = comp ? AF.company.normalizeText(question, comp) : question;
  const a = comp ? AF.company.templateAnswer(answer, comp) : answer;
  const { entries, entry } = AF.qa.learn(bank.entries, q, a, context);
  bank.entries = entries;
  writeJson(P.ANSWERS, bank);
  const left = comp ? stillNamed(a, companyName) : [];
  return left.length ? { ...entry, warning: `the saved answer still names ${left.join(', ')}: fix it or forget it (it would be reused for other companies)` } : entry;
}

/** Words of a company's name (4+ letters, not generic) still in a stored answer ("Acme" of "Acme Robotics"). */
function stillNamed(text, companyName) {
  const GENERIC = /^(inc|corp|corporation|company|group|holdings|technologies|technology|systems|solutions|labs|robotics|international|global|america|american|united|national|services|federal|bank|university|health)$/i;
  const words = String(companyName || '')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length >= 4 && !GENERIC.test(w));
  // Every distinctive word must be there: "James River Group" is not named by "Example State University".
  const all = words.length && words.every((w) => new RegExp(`(?<![A-Za-z0-9])${w}(?![A-Za-z0-9])`, 'i').test(String(text)));
  return all ? words : [];
}

/** Bank answer for a field { label, section }, rendered for `companyName`, or null. */
function lookup(field, companyName) {
  const comp = companyOf(companyName);
  const raw = { label: field.label, context: field.section || '' };
  const desc = comp ? AF.company.applyToDesc(raw, comp) : raw;
  const hit = AF.qa.lookup(desc, answers().entries, raw);
  if (!hit) return null;
  const answer = AF.company.renderAnswer(hit.entry.answer, comp);
  if (answer == null) return null; // a {company} answer and no company known
  return { answer, confidence: hit.confidence, source: hit.source, id: hit.entry.id };
}

/** Remove bank entries by id (or id prefix). Returns the removed entries. */
function forgetAnswers(ids) {
  const bank = answers();
  const gone = bank.entries.filter((e) => ids.some((id) => e.id === id || String(e.id).startsWith(id)));
  bank.entries = bank.entries.filter((e) => !gone.includes(e));
  writeJson(P.ANSWERS, bank);
  return gone;
}

/** What JB.fill() needs: Formhand profile + bank + standard answers + policy. */
function fillData() {
  const p = profile();
  return {
    profile: p.profile,
    standardAnswers: p.standardAnswers,
    qaEntries: answers().entries,
    policy: p.policy,
  };
}

function accounts() {
  return readJson(P.ACCOUNTS, {});
}

/** A usable account on a site: recorded, and not just a form the owner never submitted (Workday's click). */
function hasAccount(site) {
  const a = accounts()[site];
  return !!a && !a.pendingOwnerClick && !(a.viaOwnerClick && !a.verified);
}

function saveAccount(site, info) {
  const all = accounts();
  all[site] = { ...(all[site] || {}), ...info, updated: new Date().toISOString() };
  writeJson(P.ACCOUNTS, all);
  return all[site];
}

function logApplied(rec) {
  fs.mkdirSync(path.dirname(P.APPLIED), { recursive: true });
  fs.appendFileSync(P.APPLIED, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n');
}

function applied() {
  try {
    return fs
      .readFileSync(P.APPLIED, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch (e) {
    return [];
  }
}

module.exports = { DATA_DIR: P.DATA, AF, readJson, writeJson, profile, answers, saveAnswer, lookup, forgetAnswers, companyOf, stillNamed, fillData, accounts, saveAccount, logApplied, applied, hasAccount };
