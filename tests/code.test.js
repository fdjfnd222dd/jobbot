'use strict';
// lib/code.js: emailed codes into split boxes (Greenhouse 8, Oracle 6), real labels from 2026-10-08.
const test = require('node:test');
const assert = require('node:assert');
const { codeBoxes } = require('../lib/code');

test('Greenhouse 8 boxes, Oracle 6 boxes, a single box, and nothing to fill', () => {
  const gh = [{ ref: '0:84', kind: 'email', label: 'Email' }, { ref: '0:85', kind: 'text', label: 'Security code' },
    ...[86, 87, 88, 89, 90, 91, 92].map((n) => ({ ref: '0:' + n, kind: 'text', label: 'A verification code was sent to x@y.com. To submit your application, enter the 8-character code to confirm you\'re a human.' }))];
  assert.deepStrictEqual(codeBoxes(gh, '49PLtSMJ').map((b) => b.value).join(''), '49PLtSMJ');
  assert.strictEqual(codeBoxes(gh, '49PLtSMJ')[0].ref, '0:85');
  const oracle = [1, 2, 3, 4, 5, 6].map((d) => ({ ref: '0:' + (164 + d), kind: 'text', label: `Enter verification code digit ${d} of six.` }));
  assert.deepStrictEqual(codeBoxes(oracle, '125812').map((b) => b.ref + '=' + b.value), ['0:165=1', '0:166=2', '0:167=5', '0:168=8', '0:169=1', '0:170=2']);
  assert.deepStrictEqual(codeBoxes([{ ref: '0:3', kind: 'text', label: 'Verification Code' }], '125812'), [{ ref: '0:3', value: '125812' }]);
  assert.deepStrictEqual(codeBoxes([{ ref: '0:1', kind: 'text', label: 'First Name' }], '1234'), []);
  assert.deepStrictEqual(codeBoxes(oracle.slice(0, 4), '125812'), [], 'fewer boxes than characters: refuse');
});

test('code review: a made-up PIN or card code is never a code box; box count must match', () => {
  const oracle = [1, 2, 3, 4, 5, 6].map((d) => ({ ref: '0:' + d, kind: 'text', label: `Enter verification code digit ${d} of six.` }));
  const withPin = [{ ref: '0:0', kind: 'password', label: 'Create a 4-digit PIN' }, ...oracle];
  assert.deepStrictEqual(codeBoxes(withPin, '125812').map((b) => b.ref), ['0:1', '0:2', '0:3', '0:4', '0:5', '0:6']);
  assert.deepStrictEqual(codeBoxes([{ ref: '0:9', kind: 'text', label: 'Card security code (CVV)' }], '123'), []);
  assert.deepStrictEqual(codeBoxes(oracle, '1258'), [], 'more boxes than characters: refuse');
});
