import { test } from 'node:test'
import assert from 'node:assert/strict'
import { choose, median, passAtK, passPowK, wilson } from '../../src/stats/intervals.ts'

const near = (actual: number, expected: number, eps = 1e-4) =>
  assert.ok(Math.abs(actual - expected) < eps, `${actual} is not within ${eps} of ${expected}`)

test('three passes out of five matches the hand-computed Wilson interval', () => {
  const ci = wilson(3, 5)!
  near(ci.lo, 0.2307)
  near(ci.hi, 0.8824)
})

test('an unbroken run of failures or passes pins that side of the interval exactly', () => {
  for (const n of [1, 5, 7, 10, 16, 30]) {
    assert.equal(wilson(0, n)!.lo, 0, `0/${n}`)
    assert.equal(wilson(n, n)!.hi, 1, `${n}/${n}`)
    assert.ok(wilson(0, n)!.hi < 1, `0/${n} still leaves room above`)
    assert.ok(wilson(n, n)!.lo > 0, `${n}/${n} still leaves room below`)
  }
})

test('the interval is null when nothing was scored', () => {
  assert.equal(wilson(0, 0), null)
})

test('more successes than trials is a caller bug, not an interval', () => {
  assert.throws(() => wilson(6, 5), RangeError)
  assert.throws(() => wilson(-1, 5), RangeError)
})

test('choose is exact for trial-sized n and zero when k exceeds n', () => {
  assert.equal(choose(5, 3), 10)
  assert.equal(choose(5, 0), 1)
  assert.equal(choose(30, 15), 155117520)
  assert.equal(choose(2, 3), 0)
})

test('three of five successes gives pass^3 of one in ten and a certain pass@3', () => {
  assert.equal(passPowK(5, 3, 3), 0.1)
  assert.equal(passAtK(5, 3, 3), 1)
})

test('pass@k and pass^k agree at k of one, where both are the success rate', () => {
  assert.equal(passAtK(5, 2, 1), 0.4)
  assert.equal(passPowK(5, 2, 1), 0.4)
})

test('a k outside one to n is rejected rather than estimated', () => {
  for (const k of [0, 6]) {
    assert.throws(() => passAtK(5, 3, k), RangeError, `pass@${k}`)
    assert.throws(() => passPowK(5, 3, k), RangeError, `pass^${k}`)
  }
})

test('the median sorts numerically and averages the middle pair of an even count', () => {
  assert.equal(median([10, 9, 1]), 9)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([]), null)
})

test('the median leaves its input in place', () => {
  const xs = [3, 1, 2]
  median(xs)
  assert.deepEqual(xs, [3, 1, 2])
})

test('Wilson 3/5 agrees with R prop.test(correct = FALSE) to 1e-12', () => {
  const ci = wilson(3, 5)!
  assert.ok(Math.abs(ci.lo - 0.2307242812760128) < 1e-12, String(ci.lo))
  assert.ok(Math.abs(ci.hi - 0.882379225767352) < 1e-12, String(ci.hi))
})
