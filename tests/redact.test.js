'use strict';
// 2026-10-08: `jobctl snap` printed an iCIMS sign-up password in plain text. snapshot() masks it now.
const test = require('node:test');
const assert = require('node:assert');
const { redactSecrets } = require('../lib/apply');

test('redactSecrets masks password values, keeps everything else', () => {
  const out = redactSecrets([
    { ref: '1', label: 'Password', kind: 'password', value: 'hunter2' },
    { ref: '2', label: 'Password (Re-enter)', kind: 'text', type: 'password', value: 'hunter2' },
    { ref: '3', label: 'Login', kind: 'text', value: 'a@b.c' },
    { ref: '4', label: 'Password', kind: 'password', value: '' },
  ]);
  assert.strictEqual(out[0].value, '<redacted>');
  assert.strictEqual(out[1].value, '<redacted>');
  assert.strictEqual(out[2].value, 'a@b.c');
  assert.strictEqual(out[3].value, ''); // empty stays empty, so "still blank" checks keep working
  assert.ok(!JSON.stringify(out).includes('hunter2'));
});

// 2026-10-08 YARROWMERE iCIMS: login + password boxes inside the full Candidate Profile form, one "Submit Profile".
test('isCombinedSignupForm: iCIMS profile page yes, plain sign-up no', () => {
  const { isCombinedSignupForm } = require('../lib/apply');
  const f = (label, kind) => ({ label, kind: kind || 'text', required: true, value: '' });
  const auth = [f('Login'), f('Password', 'password'), f('Password (Re-enter)', 'password')];
  const icims = { fields: auth.concat([f('First Name'), f('Last Name'), f('Email'), f('Number'), f('Address'), f('City')]), buttons: [{ text: 'Submit Profile' }] };
  const plain = { fields: auth.concat([f('Email')]), buttons: [{ text: 'Create Account' }] };
  const workday = { fields: auth.concat([f('First Name'), f('Last Name'), f('Phone'), f('Country')]), buttons: [{ text: 'Create Account' }] };
  assert.strictEqual(isCombinedSignupForm(icims), true);
  assert.strictEqual(isCombinedSignupForm(plain), false);
  assert.strictEqual(isCombinedSignupForm(workday), false); // has its own create-account button: the auth flow handles it
});
