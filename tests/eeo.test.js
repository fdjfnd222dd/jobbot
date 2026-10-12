'use strict';
// Fernhaven 2026-10-09: race "Asian" went out although the owner's answer is decline. The driver now stops instead.
const test = require('node:test');
const assert = require('node:assert');
const E = require('../lib/eeo');

const decline = { race: 'decline', hispanic: 'decline', gender: 'male', veteran: 'not', disability: 'no' };
const flag = (fields, sa) => E.conflicts(fields, sa || decline).map((c) => `${c.question}:${c.value}`);

test('Oracle race checkboxes and the lone Hispanic box (the Fernhaven page)', () => {
  assert.deepStrictEqual(flag([{ label: 'Select the races you identify with.', value: 'Asian', kind: 'checkboxes', ref: '0:46' }]), ['race:Asian']);
  assert.deepStrictEqual(flag([{ label: 'I am Hispanic or Latino.', value: 'checked', kind: 'checkbox' }]), ['hispanic:I am Hispanic or Latino.']);
  assert.deepStrictEqual(flag([{ label: 'I am Hispanic or Latino.', value: '', kind: 'checkbox' }]), [], 'unticked: nothing said');
});

test('answers that match the owner pass; ones that differ are flagged', () => {
  const ok = [
    { label: 'Gender', value: 'Male', kind: 'combobox' },
    { label: 'Veteran Status', value: 'I am not a protected veteran', kind: 'select' },
    { label: 'Please identify your race', value: 'Decline to self-identify', kind: 'select' },
    { label: 'Disability Status', value: 'No, I do not have a disability and have not had one in the past', kind: 'radio' },
    { label: 'Full Name', value: 'Pat Example', kind: 'text' },
  ];
  assert.deepStrictEqual(flag(ok), []);
  assert.deepStrictEqual(flag([{ label: 'Gender', value: 'Female', kind: 'select' }, { label: 'Race / Ethnicity', value: 'Two or More Races', kind: 'select' }]), ['gender:Female', 'race:Two or More Races']);
  // The same page is fine for an owner whose stored race is "two".
  assert.deepStrictEqual(flag([{ label: 'Race / Ethnicity', value: 'Two or More Races', kind: 'select' }], { race: 'two' }), []);
});

test('no stored answer, or a question that is not self-ID: nothing to check', () => {
  assert.deepStrictEqual(flag([{ label: 'Gender', value: 'Female', kind: 'select' }], {}), []);
  assert.deepStrictEqual(flag([{ label: 'Preferred race distance', value: '5K', kind: 'text' }]), []);
});

// Kestrelvale 2026-10-10: work authorization went to "No" on a misclick; Cedarhall 2026-10-09: "Yes – North Korea".
test('work authorization, sponsorship and sanctioned countries are checked too', () => {
  const sa = { ...decline, workAuth: 'citizen', sponsorship: 'no' };
  const auth = 'Are you currently authorized to work in the United States?';
  const visa = 'Will you now or in the future require visa sponsorship (i.e. H-1B)?';
  assert.deepStrictEqual(flag([{ label: auth, value: 'No', kind: 'radio' }], sa), ['workAuth:No']);
  assert.deepStrictEqual(flag([{ label: visa, value: 'Yes', kind: 'radio' }], sa), ['sponsorship:Yes']);
  assert.deepStrictEqual(flag([{ label: auth, value: 'Yes', kind: 'radio' }, { label: visa, value: 'No', kind: 'radio' }], sa), []);
  assert.deepStrictEqual(flag([{ label: 'Are you related to a government official?', value: 'Yes – North Korea', kind: 'select' }], sa), ['country:Yes – North Korea']);
  assert.deepStrictEqual(flag([{ label: 'Have you lived in Russia?', value: 'No', kind: 'radio' }], sa), [], 'the country is in the question, not the answer');
});
