'use strict';
// lib/location.js + lib/tracker.js: every tracker row gets a location in one shape (owner, 2026-10-08).
// Inputs are real ATS strings from this session's postings.
const test = require('node:test');
const assert = require('node:assert');
const { normLocation } = require('../lib/location');
const { trackerRow, reqIdOf } = require('../lib/tracker');

test('normLocation: ATS spellings become "City, ST" / "Remote", several joined with " / "', () => {
  const cases = {
    'San Francisco, California, United States': 'San Francisco, CA',
    'USA - Everett, WA; USA - Saint Charles, MO': 'Everett, WA / Saint Charles, MO',
    'IL - Chicago; TX - Richardson': 'Chicago, IL / Richardson, TX',
    'US-WA-Seattle': 'Seattle, WA',
    'Remote (United Kingdom)': 'Remote',
    'US Remote': 'Remote',
    'NYC - 1211 Ave of the Americas': 'New York, NY',
    'Washington - Seattle Campus': 'Seattle, WA',
    '4555 Great America Pkwy, Santa Clara, CA, 95054, US': 'Santa Clara, CA',
    'Chicago': 'Chicago, IL',
    'San Francisco, California; Seattle, Washington': 'San Francisco, CA / Seattle, WA',
    'Chicago IL USA': 'Chicago, IL',
    'San Mateo, CA United States': 'San Mateo, CA',
    'RTP, North Carolina, US': 'RTP, NC',
    '': '',
  };
  for (const [raw, want] of Object.entries(cases)) assert.strictEqual(normLocation(raw), want, raw);
  assert.strictEqual(normLocation('A, VA; B, VA; C, VA; D, VA; E, VA; F, VA'), 'A, VA / B, VA / C, VA / D, VA / +2 more');
});

test('trackerRow: the fields the tracker page shows, location included', () => {
  const run = { company: 'Valemere', role: 'Database Engineer Intern - Summer 2027', ats: 'greenhouse', location: 'Chicago, IL', resume: '/x/PatExample_Resume_Valemere.pdf', postingUrl: 'https://job-boards.greenhouse.io/embed/job_app?for=valemere&token=4741016005' };
  const row = trackerRow(run, { profile: { gradMonth: '12', gradYear: '2027' } }, '2026-10-08');
  assert.strictEqual(row.docId, 'valemere-4741016005');
  assert.deepStrictEqual(row.data, { company: 'Valemere', role: 'Database Engineer Intern - Summer 2027', location: 'Chicago, IL', reqId: '4741016005', applied: '2026-10-08', status: 'applied', via: 'Greenhouse', contact: '', notes: 'Applied with jobbot. Resume PatExample_Resume_Valemere.pdf, grad Dec 2027.', followUp: '', updated: '2026-10-08' });
  assert.strictEqual(trackerRow({ ...run, location: '' }, {}, '2026-10-08', { location: 'US-WA-Seattle' }).data.location, 'Seattle, WA', '--location is normalized too');
  assert.strictEqual(reqIdOf('https://uscareers-driftmere.icims.com/jobs/30465/login'), '30465');
  assert.strictEqual(reqIdOf('https://jobs.ashbyhq.com/silverwick/06d64648-b84b-48ae-94a2-d9c06dfdcb5d'), '');
});

test('onePlace: Ashby "<City> Office" (Embercrest 2026-10-09)', () => {
  const { onePlace } = require('../lib/location');
  assert.strictEqual(onePlace('San Francisco Office'), 'San Francisco, CA');
  assert.strictEqual(onePlace('New York Office'), 'New York, NY');
});

test('jobctl row --location / --req are kept on the run, so rows --unlogged carries them (Hollowridge / Flinthall 2026-10-09)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-row-'));
  const id = '20261009-200659-ats-rippling';
  fs.mkdirSync(path.join(data, 'runs', id), { recursive: true });
  fs.writeFileSync(path.join(data, 'profile.json'), JSON.stringify({ profile: {}, extras: {}, standardAnswers: {}, policy: {} }));
  fs.writeFileSync(path.join(data, 'answers.json'), '[]');
  const run = { id, status: 'submitted', company: 'Flinthall', role: 'SWE Intern', url: 'https://ats.rippling.com/x/jobs/1/apply', location: '', created: '2026-10-09T20:06:59Z', updated: '2026-10-09T20:08:00Z' };
  fs.writeFileSync(path.join(data, 'runs', id, 'run.json'), JSON.stringify(run));
  const jobctl = (...a) => execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'jobctl'), ...a], { env: { ...process.env, JOBBOT_DATA: data }, encoding: 'utf8' });
  jobctl('row', id, '--location', 'Newport News, VA', '--req', 'R-1');
  const saved = JSON.parse(fs.readFileSync(path.join(data, 'runs', id, 'run.json'), 'utf8'));
  assert.strictEqual(saved.location, 'Newport News, VA');
  assert.strictEqual(trackerRow(saved, {}, '2026-10-09').data.reqId, 'R-1');
  fs.rmSync(data, { recursive: true, force: true });
});
