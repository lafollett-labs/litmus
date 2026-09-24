import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RUN_ID, assertName, caseId, parseTrialKey, runId, trialKey } from '../../src/core/ids.ts'
import { ConfigError } from '../../src/core/errors.ts'

test('a trial key round-trips through parse', () => {
  const ref = { suite: 'code-review', case: 'go-token-expiry', config: 'opus-5.5', trial: 3 }
  const key = trialKey(ref)
  assert.equal(key, 'code-review/go-token-expiry@opus-5.5#3')
  assert.deepEqual(parseTrialKey(key), ref)
})

test('a malformed trial key parses to undefined rather than a partial ref', () => {
  for (const bad of ['code-review/go@opus', 'code-review@opus#1', 'a/b@c#0', 'a/b@c#-1', 'A/b@c#1', 'a/b/c@d#1', '']) {
    assert.equal(parseTrialKey(bad), undefined, bad)
  }
})

test('a trial number past the safe-integer range is refused both ways, so a key always names one trial', () => {
  assert.equal(parseTrialKey(`a/b@c#${Number.MAX_SAFE_INTEGER}`)?.trial, Number.MAX_SAFE_INTEGER)
  assert.equal(parseTrialKey('a/b@c#9007199254740993'), undefined)
  assert.equal(parseTrialKey(`a/b@c#${'9'.repeat(400)}`), undefined)
  for (const trial of [0, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
    assert.throws(() => trialKey({ suite: 'a', case: 'b', config: 'c', trial }), RangeError, String(trial))
  }
})

test('case ids join suite and case with a slash', () => {
  assert.equal(caseId('smoke', 'always-passes'), 'smoke/always-passes')
})

test('names reject the trial-key delimiters and a leading dash or dot', () => {
  for (const bad of ['a/b', 'a@b', 'a#b', '-flag', '.hidden', 'Upper', '']) {
    assert.throws(() => assertName('case', bad), ConfigError, bad)
  }
  assert.equal(assertName('config', 'opus-5.5_bedrock'), 'opus-5.5_bedrock')
})

test('a run id is a colon-free UTC stamp that sorts chronologically', () => {
  const a = runId(new Date('2026-09-24T15:04:05.123Z'), 'a1b2')
  const b = runId(new Date('2026-09-24T15:04:06.000Z'), '0000')
  assert.equal(a, '2026-09-24T15-04-05Z-a1b2')
  assert.ok(a < b)
  assert.match(runId(), RUN_ID)
  assert.match(a, RUN_ID)
})
