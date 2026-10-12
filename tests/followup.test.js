'use strict';
// lib/followup.js: `--continue` on jobctl answer / answer-batch / code (one Claude turn per stop, Fable audit 2026-10-08).
const test = require('node:test');
const assert = require('node:assert');
const { parse, answered, combine, exitCode } = require('../lib/followup');

test('--continue is a plain switch: never swallows the answer-batch file, the value or "-"', () => {
  assert.deepStrictEqual(parse(['answer-batch', '--continue', 'data/a.json']), { args: ['answer-batch', 'data/a.json'], flags: { continue: true } });
  assert.deepStrictEqual(parse(['answer-batch', '-', '--continue', '--run', 'r1']), { args: ['answer-batch', '-'], flags: { continue: true, run: 'r1' } });
  assert.deepStrictEqual(parse(['answer', '0:12', '--continue', 'Yes']), { args: ['answer', '0:12', 'Yes'], flags: { continue: true } });
  assert.deepStrictEqual(parse(['code', '49PLtSMJ', '--continue', '--no-submit']), { args: ['code', '49PLtSMJ'], flags: { continue: true, 'no-submit': true } });
  assert.deepStrictEqual(parse(['continue', 'r1']), { args: ['continue', 'r1'], flags: {} }, 'the continue command itself is unchanged');
});

test('continue only when every answer went in', () => {
  assert.strictEqual(answered({ ok: true, answered: 3, failed: [], warnings: [] }).ok, true);
  const batch = answered({ ok: false, answered: 2, failed: [{ ref: '0:7', ok: false, error: 'no option matches' }] });
  assert.strictEqual(batch.ok, false);
  assert.match(batch.reason, /1 answer\(s\) failed: 0:7/);
  assert.strictEqual(answered({ ok: true, savedAs: 'Q' }).ok, true, 'jobctl answer');
  assert.match(answered({ ok: false, error: 'not found' }).reason, /not found/);
  assert.match(answered({ ok: false, boxes: 8, filled: 7 }).reason, /filled 7 of 8 code boxes/, 'jobctl code');
  assert.strictEqual(answered(null).ok, false);
});

test('combined output and exit code follow the continue status', () => {
  const ok = { ok: true, answered: 2, failed: [], warnings: [] };
  for (const [status, code] of [['submitted', 0], ['closed', 0], ['needs_input', 10], ['needs_review', 10], ['blocked', 11], ['ready_to_submit', 12], ['weird', 1]]) {
    const r = combine(ok, { status, run: 'r1' });
    assert.strictEqual(r.code, code, status);
    assert.deepStrictEqual(r.json, { answered: ok, run: { status, run: 'r1' } });
    assert.strictEqual(exitCode(status), code);
  }
  const bad = { ok: false, answered: 1, failed: [{ ref: '0:3', ok: false }], warnings: [] };
  const r = combine(bad, null);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.json.continued, false);
  assert.strictEqual(r.json.answered, bad);
  assert.ok(!('run' in r.json));
  assert.match(r.json.reason, /0:3/);
});

test('--full / --brief / --save / --logged / --unlogged are switches: the URL or run ids after them stay arguments', () => {
  assert.deepStrictEqual(parse(['apply', '--full', 'https://x.example/job/1']), { args: ['apply', 'https://x.example/job/1'], flags: { full: true } });
  assert.deepStrictEqual(parse(['rows', '--unlogged']), { args: ['rows'], flags: { unlogged: true } });
  assert.deepStrictEqual(parse(['rows', '--logged', 'r1', 'r2']), { args: ['rows', 'r1', 'r2'], flags: { logged: true } });
  assert.deepStrictEqual(parse(['session', 'report', '--save']), { args: ['session', 'report'], flags: { save: true } });
  assert.deepStrictEqual(parse(['queue', 'add', 'https://x.example/1', '--note', 'from the list']), { args: ['queue', 'add', 'https://x.example/1'], flags: { note: 'from the list' } });
});
