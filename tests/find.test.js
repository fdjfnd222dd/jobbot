'use strict';
// Offline tests for `jobctl find` (lib/find.js): slug guesses, title ranking, city, board matching, search order.
const test = require('node:test');
const assert = require('node:assert');
const F = require('../lib/find');

test('slugGuesses: suffixes, joined / dashed / first word', () => {
  assert.deepStrictEqual(F.slugGuesses('Acme Robotics, Inc.').slice(0, 3), ['acmerobotics', 'acme-robotics', 'acme']);
  assert.strictEqual(F.slugGuesses('Palo Alto Networks')[0], 'paloaltonetworks');
  assert.ok(F.slugGuesses('Palo Alto Networks').includes('palo-alto-networks'));
  assert.ok(F.slugGuesses('Palo Alto Networks').includes('palo'));
  assert.strictEqual(F.slugGuesses('Foo Technologies LLC')[0], 'foo');
  assert.ok(F.slugGuesses('Foo Technologies LLC').includes('footechnologiesllc'));
  assert.strictEqual(F.slugGuesses('Ernst & Young')[0], 'ernstandyoung');
  assert.ok(F.slugGuesses('Labs Inc').includes('labsinc')); // all words are suffixes: keep them rather than guess nothing
});

test('titleScore: noise ignored, intern required, ranking', () => {
  const s = F.titleScore;
  assert.strictEqual(s('Software Engineer Intern', 'Software Engineer Intern'), 1);
  assert.strictEqual(s('Software Engineer Intern, Summer 2027', 'Software Engineering Internship (Summer 2027)'), 1);
  assert.strictEqual(s('Software Engineer Intern', 'Software Engineer'), 0); // query says intern, title does not
  assert.ok(s('Software Engineer', 'Software Engineer Intern') > 0.9); // query without intern: no requirement
  assert.ok(s('Network Engineer Intern', 'Network Engineering Intern - Backbone') > 0.8);
  assert.ok(s('Network Engineer Intern', 'Software Engineer Intern') < 0.6);
  assert.ok(s('Security Intern', 'Marketing Intern') < 0.2);
});

test('cityState and rank: city boosts and penalises', () => {
  assert.strictEqual(F.cityState('NYC', 'New York, NY'), 'match');
  assert.strictEqual(F.cityState('Boston', 'Boston, MA; Remote'), 'match');
  assert.strictEqual(F.cityState('Boston', 'Austin, TX'), 'mismatch');
  assert.strictEqual(F.cityState('Boston', 'Remote - US'), 'unknown');
  assert.strictEqual(F.cityState('Boston', '3 Locations'), 'unknown');
  assert.strictEqual(F.cityState(undefined, 'Austin, TX'), 'unknown');
  const ps = [
    { title: 'SRE Intern', location: 'Austin, TX', url: 'https://x/1' },
    { title: 'SRE Intern', location: 'Boston, MA', url: 'https://x/2' },
    { title: 'Chef', location: 'Boston, MA', url: 'https://x/3' },
  ];
  const r = F.rank(ps, 'SRE Intern', 'Boston');
  assert.deepStrictEqual(r.map((p) => p.url), ['https://x/2', 'https://x/1']); // chef dropped
  assert.ok(r[0].score > r[1].score);
  assert.strictEqual(F.rank(ps, 'SRE Intern')[0].score, 1);
});

test('boardMatches: from a boards object', () => {
  const boards = {
    greenhouse: ['embervale', 'palo', 'yarrowwick'],
    ashby: ['paloaltonetworks', 'notion'],
    lever: ['spotify'],
    workday: [{ tenant: 'nvidia', wd: 'wd5', site: 'NVIDIAExternalCareerSite' }],
  };
  assert.deepStrictEqual(F.boardMatches(boards, 'Palo Alto Networks'), [{ ats: 'greenhouse', slug: 'palo' }, { ats: 'ashby', slug: 'paloaltonetworks' }]);
  assert.deepStrictEqual(F.boardMatches(boards, 'Yarrowwick, Inc.'), [{ ats: 'greenhouse', slug: 'yarrowwick' }]);
  assert.deepStrictEqual(F.boardMatches(boards, 'NVIDIA Corporation'), [{ ats: 'workday', tenant: 'nvidia', wd: 'wd5', site: 'NVIDIAExternalCareerSite' }]);
  assert.deepStrictEqual(F.boardMatches(boards, 'Zzz'), []);
  assert.deepStrictEqual(F.workdaySites('acme').slice(0, 3), ['External', 'Acme', 'Acme_Careers']);
});

const job = (title, url, location) => ({ ats: 'x', company: 'Acme', title, location: location || 'Boston, MA', url, posted: '' });
const base = (extra) => {
  const calls = [];
  const rec = (name, fn) => async (...a) => (calls.push(`${name}:${a[0].tenant ? a[0].tenant + '.' + a[0].wd + '/' + a[0].site : a[0]}`), fn(...a));
  const none = async () => { throw new Error('404'); };
  return { calls, fetchers: { greenhouse: rec('gh', none), ashby: rec('ashby', none), lever: rec('lever', none), workday: rec('wd', none), posting: async (u) => ({ url: u, text: 'x' }), ...(extra ? extra(rec) : {}) } };
};

test('find: configured board hit is strong, nothing else is tried, nothing saved', async () => {
  const b = base((rec) => ({ greenhouse: rec('gh', async () => [job('Network Engineer Intern', 'https://boards.greenhouse.io/acme/jobs/1'), job('Chef', 'https://boards.greenhouse.io/acme/jobs/2')]) }));
  const saved = [];
  const r = await F.find('Acme Inc', 'Network Engineer Intern', { boards: { greenhouse: ['acme'] }, fetchers: { ...b.fetchers, posting: async (u) => ({ url: u, text: 'y' }) }, saveBoards: (u) => (saved.push(u), []) });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.confidence, 'strong');
  assert.deepStrictEqual(b.calls, ['gh:acme']);
  assert.deepStrictEqual(saved, []);
  assert.strictEqual(r.best.postingUrl, 'https://boards.greenhouse.io/acme/jobs/1');
  assert.strictEqual(r.posting.text, 'y');
});

test('find: order is config, Greenhouse, Ashby, Lever, Workday; a guessed hit saves the board and stops early', async () => {
  const b = base((rec) => ({ lever: rec('lever', async (s) => (s === 'acme' ? [job('SRE Intern', 'https://jobs.lever.co/acme/11111111-1111-1111-1111-111111111111'), job('SRE Intern, Platform', 'https://jobs.lever.co/acme/22222222-2222-2222-2222-222222222222')] : (() => { throw new Error('404'); })())) }));
  const saved = [];
  const r = await F.find('Acme', 'SRE Intern', { boards: { greenhouse: [], ashby: [] }, fetchers: b.fetchers, saveBoards: (u) => (saved.push(...u), ['lever:acme']) });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.best.ats, 'x');
  assert.ok(r.best.url.endsWith('/apply')); // normalised through urls.applyUrl
  assert.strictEqual(r.candidates.length, 1);
  assert.deepStrictEqual(r.boardsAdded, ['lever:acme']);
  assert.strictEqual(saved.length, 1);
  const first = (p) => b.calls.findIndex((c) => c.startsWith(p));
  assert.ok(first('gh:') < first('ashby:') && first('ashby:') < first('lever:'));
  assert.ok(!b.calls.some((c) => c.startsWith('wd:'))); // strong lever hit: Workday never touched
});

test('find: Workday reached last; dead hosts skip their sites; found tenant is saved', async () => {
  const hit = job('Cloud Intern', 'https://acme.wd5.myworkdayjobs.com/External/job/Boston/Cloud-Intern_R1');
  const b = base((rec) => ({ workday: rec('wd', async (w) => { if (w.wd === 'wd5' && w.site === 'Acme') return [hit]; throw new Error(w.wd === 'wd5' ? '404' : 'fetch failed'); }) }));
  const saved = [];
  const r = await F.find('Acme', 'Cloud Intern', { boards: {}, fetchers: b.fetchers, saveBoards: (u) => (saved.push(...u), []) });
  assert.strictEqual(r.found, true);
  assert.deepStrictEqual(saved, [hit.url]);
  const wd = b.calls.filter((c) => c.startsWith('wd:'));
  assert.ok(wd.includes('wd:acme.wd5/External') && wd.includes('wd:acme.wd5/Acme'));
  assert.strictEqual(wd.filter((c) => c.startsWith('wd:acme.wd1/')).length, 1); // dead host: one try only
  assert.ok(b.calls.findIndex((c) => c.startsWith('lever:')) < b.calls.findIndex((c) => c.startsWith('wd:')));
});

test('find: not found lists everything tried; weak match reported as weak; intern required', async () => {
  const b = base((rec) => ({ greenhouse: rec('gh', async () => [job('Software Engineer', 'https://boards.greenhouse.io/acme/jobs/9'), job('Staff Chef Intern', 'https://boards.greenhouse.io/acme/jobs/8')]) }));
  const r = await F.find('Acme', 'Software Engineer Intern', { boards: {}, fetchers: b.fetchers, saveBoards: () => [] });
  assert.strictEqual(r.found, false);
  assert.ok(r.tried.some((t) => t.startsWith('greenhouse:acme (2 postings)')));
  assert.ok(r.tried.some((t) => t.startsWith('lever:acme (404')));
  assert.ok(r.tried.some((t) => t.startsWith('workday:acme.wd5/')));
  assert.match(r.message, /not found/);
  assert.ok(!r.candidates.some((c) => c.title === 'Software Engineer')); // no intern, no match
});

test('rank: off-term titles sit just below the asked term', () => {
  const r = F.rank([{ title: 'Security Intern Spring 2027', url: 'a' }, { title: 'Security Intern Summer 2027', url: 'b' }], 'Security Intern');
  assert.deepStrictEqual(r.map((p) => p.url), ['b', 'a']);
});

test('find: city picks the right location among equal titles', async () => {
  const b = base((rec) => ({ greenhouse: rec('gh', async () => [job('SWE Intern', 'https://boards.greenhouse.io/acme/jobs/1', 'Austin, TX'), job('SWE Intern', 'https://boards.greenhouse.io/acme/jobs/2', 'New York, NY')]) }));
  const r = await F.find('Acme', 'SWE Intern', { city: 'NYC', boards: { greenhouse: ['acme'] }, fetchers: b.fetchers });
  assert.ok(r.best.postingUrl.endsWith('/2'));
  assert.strictEqual(r.best.city, 'match');
  assert.strictEqual(r.candidates[0].city, 'mismatch');
});
