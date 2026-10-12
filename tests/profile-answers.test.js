// Home-address, "how did you hear" and Discipline answers from the profile (friction 2026-10-08: State 12,
// Country 12, ZIP/County/City 9, how heard 6, Discipline 6 needs_input stops). Fake profile, never data/.
const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib/apply');

const p = {
  profile: { state: 'VA', country: 'United States', postalCode: '00000', city: 'Springfield', major: 'Information Technology' },
  extras: { howHeard: 'LinkedIn' },
};
const ans = (n, prof = p) => {
  const r = A.profileAnswer(n, prof);
  return r && r.value;
};

test('State: the option the form lists (Oracle code, iCIMS full name), full name as text', () => {
  assert.strictEqual(ans({ label: 'State *', kind: 'combobox', options: ['VA', 'NC', 'MD', 'WV'] }), 'VA');
  assert.strictEqual(ans({ label: 'State/Province', kind: 'select', options: ['West Virginia', 'Virginia', 'Vermont'] }), 'Virginia');
  assert.strictEqual(ans({ label: 'Province', kind: 'select', options: ['Virginia (VA)', 'Vermont (VT)'] }), 'Virginia (VA)');
  assert.strictEqual(ans({ label: 'State', kind: 'text' }), 'Virginia');
  assert.strictEqual(ans({ label: 'State', kind: 'text', placeholder: 'e.g. CA' }), 'VA');
  assert.strictEqual(ans({ label: 'State (2-letter abbreviation)', kind: 'text' }), null, 'not a plain State label');
  assert.strictEqual(ans({ label: 'State', kind: 'text' }, { profile: { state: 'Virginia' } }), 'Virginia');
  assert.strictEqual(ans({ label: 'State', kind: 'select', options: ['VA', 'NC'] }, { profile: { state: 'Virginia' } }), 'VA');
  assert.strictEqual(ans({ label: 'State', kind: 'select', options: ['Ontario', 'Quebec'] }), null, 'not listed: ask');
  assert.strictEqual(ans({ label: 'State', kind: 'combobox', options: [] }), null, 'unread list: no fuzzy guess');
});

test('Country: the exact United States option, whatever it is called', () => {
  assert.strictEqual(ans({ label: 'Country', kind: 'combobox', options: ['Canada', 'United States of America', 'United Kingdom'] }), 'United States of America');
  assert.strictEqual(ans({ label: 'Country*', kind: 'select', options: ['Mexico', 'USA'] }), 'USA');
  assert.strictEqual(ans({ label: 'Country', kind: 'select', options: ['US', 'CA'] }), 'US');
  assert.strictEqual(ans({ label: 'Country', kind: 'select', options: ['United States Minor Outlying Islands', 'United States'] }), 'United States');
  assert.strictEqual(ans({ label: 'Country', kind: 'select', options: ['United States Minor Outlying Islands', 'Canada'] }), null);
  assert.strictEqual(ans({ label: 'Country', kind: 'text' }), 'United States');
});

test('ZIP / Postal Code: the profile postal code; County only when the profile has one', () => {
  assert.strictEqual(ans({ label: 'Zip/Postal Code', kind: 'text' }), '00000');
  assert.strictEqual(ans({ label: 'ZIP Code *', kind: 'text' }), '00000');
  assert.strictEqual(ans({ label: 'Postal Code *', kind: 'text' }), '00000');
  assert.strictEqual(A.profileAnswer({ label: 'County *', kind: 'combobox', options: ['Arlington', 'Fairfax'] }, p), null, 'no county in the profile: never guessed');
  const withCounty = { profile: { ...p.profile, county: 'Fairfax' } };
  assert.strictEqual(ans({ label: 'County *', kind: 'combobox', options: ['Arlington County', 'Fairfax County'] }, withCounty), 'Fairfax County');
  assert.strictEqual(ans({ label: 'County', kind: 'text' }, withCounty), 'Fairfax');
});

test('home address only: employer / reference / education / emergency blocks get nothing', () => {
  const st = { label: 'State', kind: 'select', options: ['VA', 'NC'] };
  assert.strictEqual(A.profileAnswer({ ...st, section: 'Employer' }, p), null);
  assert.strictEqual(A.profileAnswer({ ...st, section: 'References (1)' }, p), null);
  assert.strictEqual(A.profileAnswer({ ...st, section: 'Work Experience' }, p), null);
  assert.strictEqual(A.profileAnswer({ ...st, section: 'Education' }, p), null);
  assert.strictEqual(A.profileAnswer({ label: 'Country', kind: 'text', section: 'Emergency Contact' }, p), null);
  assert.strictEqual(A.profileAnswer({ label: 'Zip Code', kind: 'text', section: 'Previous Employer' }, p), null);
  assert.strictEqual(ans({ ...st, section: 'Address' }), 'VA');
});

test('How did you hear about us: LinkedIn, else its category, else any non-person option (owner 2026-10-09)', () => {
  const k2 = ['LinkedIn', 'Indeed', 'Company Website', 'Referral', 'Other'];
  assert.strictEqual(ans({ label: 'How did you hear about us?', kind: 'select', options: k2 }), 'LinkedIn');
  assert.strictEqual(ans({ label: 'How did you hear about this job?*', kind: 'combobox', options: ['Glassdoor', 'Linkedin', 'Other'] }), 'Linkedin');
  assert.strictEqual(ans({ label: 'How did you hear about this job posting?*', kind: 'select', options: ['Social Media - LinkedIn', 'Social Media - Twitter'] }), 'Social Media - LinkedIn');
  const pinecrest = ['Browsing Pinecrest.com web site', 'Job Board - Other', 'Job Posting', 'Social Networking', 'Social Networking - Other', 'University Careers Posting'];
  assert.strictEqual(ans({ label: 'How did you hear about us?', kind: 'select', options: pinecrest }), 'Social Networking');
  assert.strictEqual(ans({ label: "How'd you hear about Thornhaven?", kind: 'select', options: ['Friend', 'Job Board', 'Other'] }), 'Job Board');
  // Owner 2026-10-09: any option rather than a stop (never a person-source).
  assert.strictEqual(ans({ label: 'How did you hear about us?', kind: 'select', options: ['Friend', 'Job Board - Other', 'Other'] }), 'Job Board - Other');
  assert.strictEqual(ans({ label: 'How did you first learn about Elmstone as an employer? *', kind: 'text' }), 'LinkedIn');
  assert.strictEqual(A.profileAnswer({ label: 'How did you hear about us? If referral, name of employee', kind: 'text' }, p), null);
  assert.strictEqual(A.profileAnswer({ label: 'How did you hear about us?', kind: 'text' }, { profile: {} }), null, 'no standing answer');
});

test('Discipline: the real major, an IT-prefixed variant, else Other, never a different major', () => {
  const gh = ['Accounting', 'Computer Science', 'Information Systems', 'Mathematics', 'Other'];
  assert.strictEqual(ans({ label: 'Discipline*', kind: 'combobox', options: gh }), 'Other');
  assert.strictEqual(ans({ label: 'Discipline', kind: 'select', options: ['Computer Science', 'Information Technology', 'Other'] }), 'Information Technology');
  assert.strictEqual(ans({ label: 'Major', kind: 'select', options: ['Computer Science', 'Information Technology and Management', 'Other'] }), 'Information Technology and Management');
  assert.strictEqual(ans({ label: 'Undergrad Discipline(s) *', kind: 'combobox', options: ['Computer Science', 'Other'] }), 'Other');
  assert.strictEqual(A.profileAnswer({ label: 'Discipline', kind: 'select', options: ['Computer Science', 'Information Systems', 'Engineering'] }, p), null, 'Capstone course: neither IT nor Other');
  assert.strictEqual(A.profileAnswer({ label: 'Discipline', kind: 'combobox', options: [] }, p), null, 'unread list: "Information Systems" is a fuzzy trap');
  assert.strictEqual(ans({ label: 'Major', kind: 'text' }), 'Information Technology');
});
