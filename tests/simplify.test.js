'use strict';
// Offline tests for the Simplify feed (lib/simplify.js): saved README excerpt, no network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const S = require('../lib/simplify');
const { isUsLocation, ROLE, PLACES } = require('../lib/discover');
const { postingKey } = require('../lib/urls');

const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'simplify-readme.html'), 'utf8');
const rows = S.parse(src);
const by = (co, re) => rows.find((r) => r.company === co && (!re || re.test(r.title)));

test('parse: rows, arrow company, closed dropped, emoji stripped', () => {
  assert.strictEqual(rows.length, 11); // 12 table rows minus the closed one
  assert.ok(!rows.some((r) => r.company === 'Closed Co'));
  const arrow = rows.filter((r) => r.company === 'Umberfield');
  assert.strictEqual(arrow.length, 2); // the second row is a "↳" row: same company as the row above
  assert.strictEqual(arrow[1].title, 'Software Engineer Intern');
  assert.strictEqual(by('Cedarwick').title, 'Intern'); // 🎓 dropped; 🔥 off the company
  assert.strictEqual(by('Anduril').location, 'London, UK');
  assert.strictEqual(by('Umberfield').location, 'San Francisco, CA; NYC'); // SF expanded
  assert.strictEqual(by('Ernst & Young').location, 'Nashville, TN; Dallas, TX; Chicago, IL; Atlanta, GA');
});

test('parse: age', () => {
  assert.strictEqual(S.parseAge('0d'), 0);
  assert.strictEqual(S.parseAge('3d'), 3);
  assert.strictEqual(S.parseAge('1mo'), 30);
  assert.strictEqual(S.parseAge('2w'), 14);
  assert.strictEqual(S.parseAge('nope'), null);
  assert.strictEqual(by('Scale AI').ageDays, 30);
});

test('links: tracking stripped, direct ATS link preferred over simplify.jobs', () => {
  const copperfield = by('Umberfield');
  assert.ok(copperfield.direct);
  assert.ok(!/utm_|ref=Simplify/.test(copperfield.url), copperfield.url);
  assert.match(copperfield.url, /^https:\/\/job-boards\.greenhouse\.io\/embed\/job_app\?for=umberfield&token=7850795003$/);
  const ni = by('Northmoor');
  assert.match(ni.url, /^https:\/\/jobs\.ashbyhq\.com\/northmoor-spatial\/[0-9a-f-]{36}\/application$/); // embed=true gone
  assert.strictEqual(by('Northrop Grumman').url, 'https://ngc.wd1.myworkdayjobs.com/Northrop_Grumman_External_Site/job/United-States-Virginia-Chantilly/XMLNAME-2027-Software-Developer-Intern--Chantilly-VA_R10254863-1');
  // a row whose only link is the simplify.jobs redirect keeps it (cleaned), flagged not direct
  const redir = by('Redirect Only Co');
  assert.ok(!redir.direct);
  assert.match(redir.url, /^https:\/\/simplify\.jobs\/p\/[0-9a-f-]{36}$/);
  assert.strictEqual(S.cleanLink('https://jobs.lever.co/sep/4efbdbce-a753-41b5-8ed7-0661cd193178?utm_source=Simplify&ref=Simplify'), 'https://jobs.lever.co/sep/4efbdbce-a753-41b5-8ed7-0661cd193178/apply');
});

test('filters: fresh, US, role (the shared discover filters)', () => {
  const posts = S.toPostings(rows, 7);
  const names = posts.map((p) => p.company);
  assert.ok(!names.includes('Scale AI')); // 1mo
  assert.ok(!names.includes('Ironvale')); // 14d
  assert.ok(posts.every((p) => p.source === 'simplify' && p.posted));
  assert.strictEqual(S.toPostings(rows, 20).filter((p) => p.company === 'Ironvale').length, 1);
  const wanted = posts.filter((p) => isUsLocation(p.location) && ROLE.test(p.title));
  assert.ok(!wanted.some((p) => p.company === 'Anduril')); // London
  assert.ok(wanted.some((p) => p.company === 'Umberfield'));
  assert.ok(wanted.some((p) => p.company === 'Northrop Grumman')); // "Software Developer" is a ROLE match since 2026-10-12;
  assert.ok(require('../lib/discover').NEVER.test('Examplecorp-Never-Apply Inc')); // the never-list still drops it
  assert.ok(wanted.some((p) => p.company === 'Redirect Only Co'));
  // "Tax ... Technology Group" matches ROLE (technology) since 2026-10-12; the full title filter drops it (tax).
  assert.ok(!require('../lib/discover').titleFits(by('Ernst & Young').title));
  assert.ok(PLACES.find(([n]) => n === 'NYC')[1].test(by('Umberfield').location));
  assert.ok(PLACES[0][1].test(by('Northmoor').location)); // "SF" reaches the OR/CA place via San Francisco
});

test('dedupe: same posting from a board and from Simplify has one postingKey', () => {
  const board = 'https://boards.greenhouse.io/umberfield/jobs/7850795003';
  assert.strictEqual(postingKey(board), postingKey(by('Umberfield').url));
  assert.notStrictEqual(postingKey(board), postingKey(rows.filter((r) => r.company === 'Umberfield')[1].url));
});

test('boardOf: slug extraction per ATS', () => {
  assert.deepStrictEqual(S.boardOf('https://job-boards.greenhouse.io/embed/job_app?for=umberfield&token=1'), { ats: 'greenhouse', slug: 'umberfield' });
  assert.deepStrictEqual(S.boardOf('https://boards.greenhouse.io/andurilindustries/jobs/5255902007'), { ats: 'greenhouse', slug: 'andurilindustries' });
  assert.deepStrictEqual(S.boardOf('https://jobs.lever.co/sep/4efbdbce-a753-41b5-8ed7-0661cd193178/apply'), { ats: 'lever', slug: 'sep' });
  assert.deepStrictEqual(S.boardOf('https://jobs.ashbyhq.com/northmoor-spatial/x/application'), { ats: 'ashby', slug: 'northmoor-spatial' });
  assert.deepStrictEqual(S.boardOf('https://ngc.wd1.myworkdayjobs.com/en-US/Northrop_Grumman_External_Site/job/x'), { ats: 'workday', tenant: 'ngc', wd: 'wd1', site: 'Northrop_Grumman_External_Site' });
  assert.strictEqual(S.boardOf('https://careers.withwaymo.com/jobs?gh_jid=8250220'), null); // custom site: slug unknown
  assert.strictEqual(S.boardOf('https://simplify.jobs/p/abc'), null);
});

test('addBoards: pure, appends only unknown slugs, keeps order and other keys', () => {
  const before = { _about: 'x', greenhouse: ['Umberfield', 'a'], lever: [], ashby: ['silverwick'], workday: [{ tenant: 'ngc', wd: 'wd1', site: 'Northrop_Grumman_External_Site' }] };
  const snapshot = JSON.stringify(before);
  const { boards, added } = S.addBoards(before, [
    by('Umberfield').url, // already there (case-insensitive)
    by('Northmoor').url, // new ashby
    'https://jobs.ashbyhq.com/northmoor-spatial/other/application', // same slug twice: once
    'https://jobs.lever.co/sep/4efbdbce-a753-41b5-8ed7-0661cd193178/apply',
    'https://ngc.wd1.myworkdayjobs.com/Northrop_Grumman_External_Site/job/y', // known tenant
    'https://marvell.wd1.myworkdayjobs.com/MarvellCareers/job/z',
    by('Redirect Only Co').url,
  ]);
  assert.strictEqual(JSON.stringify(before), snapshot); // input untouched
  assert.deepStrictEqual(added, ['ashby:northmoor-spatial', 'lever:sep', 'workday:marvell/MarvellCareers']);
  assert.deepStrictEqual(boards.greenhouse, ['Umberfield', 'a']);
  assert.deepStrictEqual(boards.ashby, ['silverwick', 'northmoor-spatial']);
  assert.deepStrictEqual(boards.lever, ['sep']);
  assert.deepStrictEqual(boards.workday[1], { tenant: 'marvell', wd: 'wd1', site: 'MarvellCareers' });
  assert.strictEqual(boards._about, 'x');
});

test('readme: cache within 1 h, network failure falls back to stale cache or throws', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simp-'));
  const cacheFile = path.join(dir, 'c.md');
  let calls = 0;
  const ok = async () => (calls++, { ok: true, text: async () => src });
  const r1 = await S.readme({ cacheFile, fetch: ok });
  assert.ok(!r1.cached && calls === 1);
  const r2 = await S.readme({ cacheFile, fetch: ok });
  assert.ok(r2.cached && calls === 1);
  const old = new Date(Date.now() - 2 * 3600000);
  fs.utimesSync(cacheFile, old, old);
  const down = async () => { throw new Error('offline'); };
  const r3 = await S.readme({ cacheFile, fetch: down });
  assert.ok(r3.stale && r3.text === src);
  fs.rmSync(cacheFile);
  await assert.rejects(S.readme({ cacheFile, fetch: down }), /offline/);
});

// 2026-10-08: Austin / Portland postings (Flintwick, Brookcrest) were only in the Understudy and
// RoleInbox READMEs, not Simplify or boards.json. Same table shape; RoleInbox dates rows "2026-10-07".
test('other feeds: Understudy row (two apply links, "+1 more") and RoleInbox ISO date age', () => {
  const understudy = '<table><tr><th>Company</th></tr><tr><td><strong>Flintwick University Jobs</strong></td><td>AI SW Intern, Cloud</td><td>Austin, Texas, United States<br>Santa Clara, California, United States</td><td align="center"><a href="https://job-boards.greenhouse.io/flintwickuniversity/jobs/5256686007?utm_source=understudy&amp;ref=understudy-list">Apply</a><br><a href="https://understudy.live/apply/1?utm_source=ghlist">⚡ Auto-apply</a></td><td>0d</td></tr></table>';
  const [u] = S.parse(understudy);
  assert.strictEqual(u.company, 'Flintwick University Jobs');
  assert.match(u.url, /greenhouse.*5256686007/); // the ATS link, not the auto-apply one
  assert.doesNotMatch(u.url, /utm_|ref=/);
  assert.strictEqual(u.ageDays, 0);
  const roleinbox = '| Brookcrest | Summer 2027 Engineering Internship | Portland, OR | [Apply](https://job-boards.greenhouse.io/brookcrest/jobs/6217929004) | 2026-10-06 |';
  const [r] = S.parse(roleinbox);
  assert.strictEqual(r.location, 'Portland, OR');
  assert.strictEqual(S.parseAge('2026-10-06', Date.parse('2026-10-08T15:00:00Z')), 2);
  const p = S.toPostings([{ ...r, ageDays: 2 }], 7, Date.parse('2026-10-08T15:00:00Z'), 'roleinbox')[0];
  assert.strictEqual(p.source, 'roleinbox');
  assert.deepStrictEqual(S.FEEDS.map((f) => f.name), ['simplify', 'understudy', 'roleinbox']);
});

test('realAge: a feed hit takes the ATS age and is skipped when stale; board hits untouched', () => {
  const { realAge } = require('../lib/discover');
  const glean = { source: 'understudy', ageDays: 6 };
  assert.match(realAge(glean, { ageDays: 399.8 }, 7), /stale: posted 400 d ago on the ATS \(feed said 6 d\)/);
  assert.strictEqual(glean.ageDays, 399.8);
  const fresh = { source: 'understudy', ageDays: 1 };
  assert.strictEqual(realAge(fresh, { ageDays: 1.8 }, 7), undefined);
  assert.strictEqual(fresh.ageDays, 1.8);
  const board = { ageDays: 2 };
  assert.strictEqual(realAge(board, { ageDays: 50 }, 7), undefined);
  assert.strictEqual(board.ageDays, 2);
  assert.strictEqual(realAge({ source: 'simplify', ageDays: 3 }, { ageDays: null }, 7), undefined); // no ATS date: keep the feed's
});

test('cityFilter: metro names expand to suburbs, other words are literal, none = null', () => {
  const { cityFilter } = require('../lib/discover');
  const r = cityFilter('portland,dc,remote');
  assert.ok(r.test('Hillsboro, OR') && r.test('McLean, VA') && r.test('US Remote'));
  assert.ok(!r.test('Austin, TX') && !r.test('Seattle, WA'));
  assert.ok(cityFilter('bay area').test('Sunnyvale, California'));
  assert.ok(cityFilter('las vegas').test('Las Vegas, Nevada'));
  assert.strictEqual(cityFilter(undefined), null);
  assert.strictEqual(cityFilter(true), null);
});

test('cityFilter: state-aware Manhattan, LA and SLC suburbs (2026-10-08)', () => {
  const { cityFilter } = require('../lib/discover');
  const nyc = cityFilter('nyc');
  assert.ok(nyc.test('Manhattan, NY') && nyc.test('New York, NY'));
  assert.ok(!nyc.test('Manhattan, Kansas') && !nyc.test('Manhattan, KS'));
  const la = cityFilter('los angeles,salt lake city');
  assert.ok(la.test('Long Beach, CA') && la.test('Beverly Hills, CA') && la.test('El Segundo, CA') && la.test('Lehi, UT'));
  assert.ok(!la.test('Las Vegas, Nevada'));
});

test('cityMatch: title only when the location is vague; Manhattan Beach is LA (code review 2026-10-08)', () => {
  const { cityFilter, cityMatch } = require('../lib/discover');
  const nyc = cityFilter('nyc,dc,bay area');
  assert.ok(cityMatch(nyc, { location: 'United States', title: 'Network Engineering Intern, Summer 2027 (Hybrid, NYC)' }));
  assert.ok(!cityMatch(nyc, { location: 'Phoenix, AZ', title: 'DC/DC Converter Design Intern' }));
  assert.ok(!cityMatch(nyc, { location: 'Denver, CO', title: 'Salesforce (SF) Developer Intern' }));
  assert.ok(!cityFilter('nyc').test('Manhattan Beach, CA'));
  assert.ok(cityFilter('los angeles').test('Manhattan Beach, CA'));
  assert.ok(!cityFilter('los angeles').test('La Jolla, CA'));
});

test('isUsLocation: remote in another country is not US (SailPoint 2026-10-09)', () => {
  assert.strictEqual(isUsLocation('Remote (United Kingdom)'), false);
  assert.strictEqual(isUsLocation('Remote'), true);
  assert.strictEqual(isUsLocation('US - Remote'), true);
  assert.strictEqual(isUsLocation('Remote - US or Canada'), true);
});

test('realAge: a board hit with no list date takes the posting date; identical company/title/location listed once', () => {
  const { realAge, dedupeHits } = require('../lib/discover');
  const mfs = { company: 'mfs', title: 'Summer 2027 Software Engineer Intern', location: 'Boston', ageDays: null, url: 'https://mfs.wd1.myworkdayjobs.com/MFS-Careers/job/Boston/X_MFS-231985' };
  assert.match(realAge(mfs, { ageDays: 10.6 }, 7), /stale: posted 11 d ago/);
  assert.strictEqual(mfs.ageDays, 10.6);
  const dated = { company: 'jci', ageDays: 2.6 };
  assert.strictEqual(realAge(dated, { ageDays: 40 }, 7), undefined, 'a dated board hit keeps its list date');
  const twin = { ...mfs, url: 'https://mfs.wd1.myworkdayjobs.com/MFS-Careers/job/Boston/X_MFS-231983' };
  assert.strictEqual(dedupeHits([mfs, twin]).length, 1);
  assert.strictEqual(dedupeHits([mfs, { ...twin, location: 'Toronto' }]).length, 2);
});

test('addBoards: an Oracle HCM posting adds its host + site with the company name (2026-10-12)', () => {
  const url = 'https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26011734';
  const { boards, added } = S.addBoards({ oracle: [] }, [url, url], { [url]: 'Emerson' });
  assert.deepStrictEqual(boards.oracle, [{ host: 'hdjq.fa.us2.oraclecloud.com', site: 'CX_1', company: 'Emerson' }]);
  assert.deepStrictEqual(added, ['oracle:hdjq.fa.us2.oraclecloud.com/CX_1']);
});
