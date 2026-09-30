import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wilson } from '../../src/stats/intervals.ts'
import { minTrialsToPass, settle, type SettleInput, type TrialOutcome } from '../../src/stats/verdict.ts'

const OUTCOME: Record<string, TrialOutcome> = {
  p: { status: 'pass', exit: 'ok' },
  f: { status: 'fail', exit: 'ok' },
  m: { status: 'fail', exit: 'model_failure' },
  e: { status: 'error', exit: 'infra_error' },
  c: { status: 'cancelled', exit: 'ok' },
}

// Trials as a string, one letter each: 'ppf' is two passes and a graded fail.
function run(trials: string, over: Partial<SettleInput> = {}) {
  const outcomes = [...trials].map(ch => OUTCOME[ch]!)
  return settle({
    case: 'smoke/c',
    config: 'fake',
    policy: 'all',
    threshold: 0.8,
    min_trials: 1,
    expect: 'pass',
    trials: outcomes.length,
    outcomes,
    ...over,
  })
}

const rate = (trials: string, threshold = 0.8) => run(trials, { policy: 'rate', threshold })

test('every scored trial passing is PASS under the all policy', () => {
  assert.equal(run('ppppp').verdict, 'PASS')
})

test('no scored trial passing is FAIL under the all policy', () => {
  assert.equal(run('ffffm').verdict, 'FAIL')
})

test('three passes out of five is FLAKY under the all policy', () => {
  assert.equal(run('pppff').verdict, 'FLAKY')
})

test('an infra error neither passes nor fails a case that still scored enough trials', () => {
  const v = run('ppe', { min_trials: 2 })
  assert.equal(v.verdict, 'PASS')
  assert.equal(v.scored, 2)
  assert.equal(v.errors, 1)
})

test('a cancelled trial counts as neither scored nor an error', () => {
  const v = run('ppcc', { trials: 4 })
  assert.equal(v.verdict, 'PASS')
  assert.equal(v.trials, 4)
  assert.equal(v.scored, 2)
  assert.equal(v.errors, 0)
})

test('a case whose every trial errored or was cancelled is ERROR with no statistics, under either policy', () => {
  for (const policy of ['all', 'rate'] as const) {
    const v = run('eec', { policy })
    assert.equal(v.verdict, 'ERROR', policy)
    assert.equal(v.scored, 0)
    assert.equal(v.errors, 2)
    assert.equal(v.success_rate, null)
    assert.equal(v.interval, null)
    assert.equal(v.k, null)
    assert.equal(v.pass_at_k, null)
    assert.equal(v.pass_pow_k, null)
  }
})

test('errors that leave fewer scored trials than min_trials make the case INCONCLUSIVE, under either policy', () => {
  for (const policy of ['all', 'rate'] as const) {
    assert.equal(run('pee', { policy, min_trials: 2 }).verdict, 'INCONCLUSIVE', policy)
  }
})

test('a canary expected to fail that passes every trial is FAIL, flagged as an unexpected pass', () => {
  const v = run('ppppp', { expect: 'fail' })
  assert.equal(v.verdict, 'FAIL')
  assert.equal(v.unexpected_pass, true)
  assert.equal(v.passes, 5)
  assert.equal(v.successes, 0)
  assert.equal(v.success_rate, 0)
})

test('a canary expected to fail that the graders reject every trial is PASS, with no unexpected pass', () => {
  const v = run('fffff', { expect: 'fail' })
  assert.equal(v.verdict, 'PASS')
  assert.equal(v.unexpected_pass, false)
  assert.equal(v.successes, 5)
})

test('a canary that passes even one trial is FAIL rather than FLAKY, under either policy', () => {
  for (const policy of ['all', 'rate'] as const) {
    const v = run('p' + 'f'.repeat(29), { expect: 'fail', policy })
    assert.equal(v.verdict, 'FAIL', policy)
    assert.equal(v.unexpected_pass, true)
    assert.equal(v.successes, 29)
  }
})

test('a canary trial that ended in model failure is not a success, since no grader judged it', () => {
  const v = run('ffmm', { expect: 'fail' })
  assert.equal(v.successes, 2)
  assert.equal(v.unexpected_pass, false)
  assert.equal(v.verdict, 'FLAKY')
  assert.equal(run('mmmm', { expect: 'fail' }).verdict, 'FAIL')
})

test('a canary that passes once is FAIL even when errors left too few scored trials', () => {
  const v = run('pee', { expect: 'fail', min_trials: 2 })
  assert.equal(v.verdict, 'FAIL')
  assert.equal(v.inconclusive_reason, null)
})

test('an INCONCLUSIVE verdict says whether errors or an unresolved interval caused it', () => {
  assert.equal(run('pee', { min_trials: 2 }).inconclusive_reason, 'min_trials')
  assert.equal(rate('ppppp').inconclusive_reason, 'interval')
  assert.equal(run('ppp').inconclusive_reason, null)
})

test('sixteen straight passes clear a 0.8 threshold under the rate policy, and fifteen cannot', () => {
  assert.equal(rate('p'.repeat(16)).verdict, 'PASS')
  assert.equal(rate('p'.repeat(15)).verdict, 'INCONCLUSIVE')
})

test('five straight passes cannot yet clear a 0.8 threshold under the rate policy', () => {
  assert.equal(rate('ppppp').verdict, 'INCONCLUSIVE')
})

test('a failure on record still passes under the rate policy when the whole interval clears the threshold', () => {
  const v = rate('p'.repeat(29) + 'f')
  assert.ok(v.interval!.lo >= 0.8)
  assert.equal(v.verdict, 'PASS')
})

test('ten straight failures are FAIL under the rate policy', () => {
  assert.equal(rate('f'.repeat(10)).verdict, 'FAIL')
})

test('a mixed record whose whole interval sits below the threshold is FAIL under the rate policy', () => {
  const v = rate('ppppp' + 'fffff')
  assert.ok(v.interval!.hi < 0.8)
  assert.equal(v.verdict, 'FAIL')
})

test('a mixed record whose interval straddles the threshold is INCONCLUSIVE, never FLAKY, under the rate policy', () => {
  const v = rate('pppppppp' + 'ff')
  assert.ok(v.interval!.lo < 0.8 && v.interval!.hi >= 0.8)
  assert.equal(v.verdict, 'INCONCLUSIVE')
})

test('two straight failures cannot yet sink a 0.5 threshold under the rate policy', () => {
  const v = rate('ff', 0.5)
  assert.ok(v.interval!.hi >= 0.5)
  assert.equal(v.verdict, 'INCONCLUSIVE')
})

test('an unbroken run needs sixteen trials to clear a 0.8 threshold', () => {
  assert.equal(minTrialsToPass(0.8), 16)
  assert.equal(minTrialsToPass(0), 1)
  assert.ok(wilson(15, 15)!.lo < 0.8 && wilson(16, 16)!.lo >= 0.8)
})

test('a threshold of one or more is rejected, since no finite run reaches it', () => {
  for (const t of [1, 1.2, -0.1, Number.NaN]) {
    assert.throws(() => minTrialsToPass(t), RangeError, String(t))
  }
})

test('a settled case carries its success rate, Wilson interval and pass@3 and pass^3', () => {
  const v = run('pppff', { trials: 6 })
  assert.equal(v.trials, 6)
  assert.equal(v.scored, 5)
  assert.equal(v.passes, 3)
  assert.equal(v.successes, 3)
  assert.equal(v.success_rate, 0.6)
  assert.deepEqual(v.interval, wilson(3, 5))
  assert.equal(v.k, 3)
  assert.equal(v.pass_pow_k, 0.1)
  assert.equal(v.pass_at_k, 1)
})

test('k shrinks to the scored count when fewer than three trials scored', () => {
  const v = run('pfe')
  assert.equal(v.k, 2)
  assert.equal(v.pass_at_k, 1)
  assert.equal(v.pass_pow_k, 0)
})

test('INCONCLUSIVE at exactly min_trials scored is the interval, not too few trials', () => {
  const v = settle({ case: 's/c', config: 'f', policy: 'rate', threshold: 0.8, min_trials: 5, expect: 'pass', trials: 5, outcomes: Array.from({ length: 5 }, () => ({ status: 'pass' as const, exit: 'ok' as const })) })
  assert.equal(v.verdict, 'INCONCLUSIVE')
  assert.equal(v.inconclusive_reason, 'interval')
})

test('min_trials is capped by the trials scheduled, so one requested trial can still settle', () => {
  const v = settle({ case: 's/c', config: 'f', policy: 'all', threshold: 0.8, min_trials: 5, expect: 'pass', trials: 1, outcomes: [{ status: 'pass', exit: 'ok' }] })
  assert.equal(v.verdict, 'PASS')
})

test('minTrialsToPass is exact and instant even for a threshold a hair below 1', () => {
  assert.deepEqual([0.5, 0.8, 0.9, 0.95, 0.99].map(t => minTrialsToPass(t)), [4, 16, 35, 73, 381])
  const t0 = Date.now()
  assert.equal(minTrialsToPass(0.999999999999), 3841543802248)
  assert.ok(Date.now() - t0 < 50)
})

test('a lower bound exactly on the threshold clears it under the rate policy', () => {
  const threshold = wilson(16, 16)!.lo
  const v = settle({ case: 's/c', config: 'f', policy: 'rate', threshold, min_trials: 1, expect: 'pass', trials: 16, outcomes: Array.from({ length: 16 }, () => ({ status: 'pass' as const, exit: 'ok' as const })) })
  assert.equal(v.verdict, 'PASS')
})
