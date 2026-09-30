import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Verdict } from '../../src/core/types.ts'
import { compare, suiteVerdict, type CompareOptions, type CompareSide } from '../../src/stats/compare.ts'
import { choose } from '../../src/stats/intervals.ts'
import { settle, type TrialOutcome } from '../../src/stats/verdict.ts'

const OUTCOME: Record<string, TrialOutcome> = {
  p: { status: 'pass', exit: 'ok' },
  f: { status: 'fail', exit: 'ok' },
  e: { status: 'error', exit: 'infra_error' },
}

// A case's trials as a string, one letter each, settled under the all policy.
function verdict(id: string, trials: string, expect: 'pass' | 'fail' = 'pass'): Verdict {
  const outcomes = [...trials].map(ch => OUTCOME[ch]!)
  return settle({
    case: id,
    config: 'fake',
    policy: 'all',
    threshold: 0.8,
    min_trials: 1,
    expect,
    trials: outcomes.length,
    outcomes,
  })
}

const side = (label: string, rows: [string, string][], metrics?: CompareSide['metrics'], expect: 'pass' | 'fail' = 'pass'): CompareSide => ({
  label,
  verdicts: rows.map(([id, trials]) => verdict(id, trials, expect)),
  ...(metrics ? { metrics } : {}),
})

// n cases, each with the same trials.
const cases = (n: number, trials: string): [string, string][] =>
  Array.from({ length: n }, (_, i) => [`smoke/c${i}`, trials])

const p = (n: number) => 'p'.repeat(n)
const f = (n: number) => 'f'.repeat(n)

test('identical sides with enough trials to resolve the tolerance are NO CHANGE, with no flips', () => {
  const c = compare(side('main', cases(20, p(30))), side('branch', cases(20, p(30))))
  assert.equal(c.verdict, 'NO CHANGE')
  assert.equal(c.a, 'main')
  assert.equal(c.b, 'branch')
  assert.equal(c.cases, 20)
  assert.equal(c.delta, 0)
  assert.equal(c.tolerance, 0.05)
  assert.deepEqual(c.flips, [])
  assert.deepEqual(c.excluded, [])
  assert.deepEqual(c.warns, [])
})

test('identical sides with too few trials to resolve the tolerance are INCONCLUSIVE, not NO CHANGE', () => {
  const c = compare(side('a', cases(5, p(5))), side('b', cases(5, p(5))))
  assert.ok(c.interval!.lo < -0.05 && c.interval!.hi > 0.05)
  assert.equal(c.verdict, 'INCONCLUSIVE')
})

test('a wider tolerance accepts the same thin evidence as NO CHANGE', () => {
  const thin = (tolerance?: number) => compare(side('a', cases(5, p(10))), side('b', cases(5, p(10))), tolerance === undefined ? {} : { tolerance })
  assert.equal(thin().verdict, 'INCONCLUSIVE')
  assert.equal(thin(0.2).tolerance, 0.2)
  assert.equal(thin(0.2).verdict, 'NO CHANGE')
})

test('B losing every one of ten cases is a REGRESSION', () => {
  const c = compare(side('a', cases(10, p(5))), side('b', cases(10, f(5))))
  assert.equal(c.verdict, 'REGRESSION')
  assert.equal(c.delta, -1)
  assert.equal(c.flips.length, 10)
})

test('B winning every one of ten cases is an IMPROVEMENT', () => {
  const c = compare(side('a', cases(10, f(5))), side('b', cases(10, p(5))))
  assert.equal(c.verdict, 'IMPROVEMENT')
  assert.equal(c.delta, 1)
})

test('one case going from one pass to one fail is INCONCLUSIVE, since a single trial pins down nothing', () => {
  const c = compare(side('a', cases(1, 'p')), side('b', cases(1, 'f')))
  assert.equal(c.delta, -1)
  assert.equal(c.verdict, 'INCONCLUSIVE')
})

test('one case going from thirty passes to thirty fails is a REGRESSION on its own', () => {
  const c = compare(side('a', cases(1, p(30))), side('b', cases(1, f(30))))
  assert.equal(c.verdict, 'REGRESSION')
})

test('a small noisy difference over three cases is INCONCLUSIVE', () => {
  const a = side('a', [['smoke/x', 'pppff'], ['smoke/y', 'ppppf'], ['smoke/z', 'ppfff']])
  const b = side('b', [['smoke/x', 'ppppf'], ['smoke/y', 'pppff'], ['smoke/z', 'pffff']])
  const c = compare(a, b)
  assert.ok(Math.abs(c.delta! + 0.2 / 3) < 1e-12)
  assert.equal(c.verdict, 'INCONCLUSIVE')
})

test('a drop smaller than the tolerance is NO CHANGE even while it flips every verdict', () => {
  const c = compare(side('a', cases(10, p(50))), side('b', cases(10, p(49) + 'f')))
  assert.equal(c.verdict, 'NO CHANGE')
  assert.equal(c.flips.length, 10)
  assert.deepEqual(c.flips[0], { case: 'smoke/c0', from: 'PASS', to: 'FLAKY' })
})

test('flips list every changed verdict with its old and new value, in the baseline order', () => {
  const a = side('a', [['smoke/z', 'ppp'], ['smoke/x', 'fff'], ['smoke/w', 'ppp'], ['smoke/y', 'pff']])
  const b = side('b', [['smoke/w', 'ppp'], ['smoke/y', 'ppp'], ['smoke/x', 'pff'], ['smoke/z', 'fff']])
  assert.deepEqual(compare(a, b).flips, [
    { case: 'smoke/z', from: 'PASS', to: 'FAIL' },
    { case: 'smoke/x', from: 'FAIL', to: 'FLAKY' },
    { case: 'smoke/y', from: 'FLAKY', to: 'PASS' },
  ])
})

test('cases only one side ran, or one side could not score, are excluded and sorted, but still flip', () => {
  const a = side('a', [['smoke/only-a', 'ppp'], ['smoke/errs', 'ppp'], ['smoke/fine', 'ppp']])
  const b = side('b', [['smoke/fine', 'ppp'], ['smoke/errs', 'eee'], ['smoke/only-b', 'ppp']])
  const c = compare(a, b)
  assert.deepEqual(c.excluded.map(e => e.case), ['smoke/errs', 'smoke/only-a', 'smoke/only-b'])
  assert.ok(c.excluded.every(e => e.reason.length > 0))
  assert.equal(c.cases, 1)
  assert.deepEqual(c.flips, [{ case: 'smoke/errs', from: 'PASS', to: 'ERROR' }])
})

test('with no case scored on both sides there is no delta and the suite is INCONCLUSIVE', () => {
  const c = compare(side('a', [['smoke/x', 'ppp']]), side('b', [['smoke/y', 'ppp']]))
  assert.equal(c.cases, 0)
  assert.equal(c.delta, null)
  assert.equal(c.interval, null)
  assert.equal(c.verdict, 'INCONCLUSIVE')
})

test('a metric that grows 1.6x warns and one that grows 1.4x does not', () => {
  const c = compare(
    side('a', cases(1, 'p'), { tokens: 1000, cost_usd: 1 }),
    side('b', cases(1, 'p'), { tokens: 1600, cost_usd: 1.4 }),
  )
  assert.deepEqual(c.warns, [{ metric: 'tokens', a: 1000, b: 1600, ratio: 1.6 }])
})

test('a metric that shrinks past the ratio warns too', () => {
  const c = compare(
    side('a', cases(1, 'p'), { tool_calls: 10, wall_clock_ms: 10 }),
    side('b', cases(1, 'p'), { tool_calls: 6, wall_clock_ms: 7 }),
  )
  assert.deepEqual(c.warns, [{ metric: 'tool_calls', a: 10, b: 6, ratio: 0.6 }])
})

test('a metric with a zero baseline or missing from either side never warns', () => {
  const c = compare(
    side('a', cases(1, 'p'), { tokens: 0, findings: 3 }),
    side('b', cases(1, 'p'), { tokens: 500, findings: 9, cost_usd: 2 }),
  )
  assert.deepEqual(c.warns.map(w => w.metric), ['findings'])
})

const mixed: [string, string][] = ['ppppp', 'ppppf', 'pppff', 'ppfff', 'pffff', 'fffff', 'ppppf', 'pppff'].map(
  (trials, i) => [`smoke/c${i}`, trials],
)

test('the interval is deterministic: the same records always give the same interval', () => {
  const interval = () => compare(side('a', cases(8, p(5))), side('b', mixed)).interval
  assert.deepEqual(interval(), interval())
})

test('a side listing one case twice is refused rather than paired arbitrarily', () => {
  const a = side('a', [['smoke/x', 'ppp'], ['smoke/x', 'fff']])
  assert.throws(() => compare(a, side('b', [['smoke/x', 'ppp']])), /appears twice/)
})

test('options outside what the config schema allows are refused, not turned into a verdict', () => {
  const run = (opts: CompareOptions) => () => compare(side('a', cases(1, 'p')), side('b', cases(1, 'p')), opts)
  for (const tolerance of [-0.5, 1, NaN]) assert.throws(run({ tolerance }), /tolerance must be in \[0, 1\)/)
  for (const warnRatio of [0.5, 1, Infinity, NaN]) assert.throws(run({ warnRatio }), /warnRatio must be a finite number above 1/)
})

test('every trial passing on both sides is never a regression, whatever the trial counts', () => {
  // Centred on a posterior mean, 5/5 reads 0.92 and 1/1 reads 0.75, and over 30
  // cases that gap looks certain. MOVER centres on the observed rates.
  const down = compare(side('a', cases(30, p(5))), side('b', cases(30, p(1))))
  assert.notEqual(down.verdict, 'REGRESSION')
  const up = compare(side('a', cases(30, p(1))), side('b', cases(30, p(5))))
  assert.notEqual(up.verdict, 'IMPROVEMENT')
  const many = compare(side('a', cases(200, p(10))), side('b', cases(200, p(3))))
  assert.notEqual(many.verdict, 'REGRESSION')
})

test('a real drop is still a regression when the trial counts differ', () => {
  const c = compare(side('a', cases(30, p(5))), side('b', cases(30, f(3))))
  assert.equal(c.verdict, 'REGRESSION')
})

test('a case whose content changed between the sides is excluded with its reason, and does not flip', () => {
  const a: CompareSide = { ...side('a', [['smoke/x', p(3)], ['smoke/y', p(3)]]), hashes: { 'smoke/x': 'h1', 'smoke/y': 'h2' } }
  const b: CompareSide = { ...side('b', [['smoke/x', f(3)], ['smoke/y', p(3)]]), hashes: { 'smoke/x': 'CHANGED', 'smoke/y': 'h2' }, notes: ['subject changed'] }
  const c = compare(a, b)
  assert.deepEqual(c.excluded, [{ case: 'smoke/x', reason: 'the case changed between the two sides' }])
  assert.deepEqual(c.flips, [])
  assert.equal(c.cases, 1)
  assert.deepEqual(c.notes, ['subject changed'])
})

// Golden: a change to the per-side intervals, the MOVER combination or the
// clamp moves these digits; a refactor that only moves the last bit stays
// within 1e-12.
const near = (got: { lo: number; hi: number }, want: { lo: number; hi: number }) =>
  assert.ok(Math.abs(got.lo - want.lo) < 1e-12 && Math.abs(got.hi - want.hi) < 1e-12, `${JSON.stringify(got)} vs ${JSON.stringify(want)}`)
test('a seeded mixed comparison reproduces its interval to the last digit', () => {
  const mixed = (label: string, pat: string) => side(label, Array.from({ length: 6 }, (_, i): [string, string] => [`s/m${i}`, pat.slice(0, 3 + i)]))
  const c = compare(mixed('a', 'pppppfp'), mixed('b', 'ppfpfpp'))
  near(c.interval!, { lo: -0.4274988756864533, hi: -0.004064142027615551 })
})

test('the suite is the cases it holds: three of ten collapsing from 30/30 to 0/30 is a REGRESSION', () => {
  const b: [string, string][] = cases(10, p(30)).map(([id], i) => [id, i < 3 ? f(30) : p(30)])
  const c = compare(side('a', cases(10, p(30))), side('b', b))
  near(c.interval!, { lo: -0.33003282088134184, hi: -0.25907216404593514 })
  assert.equal(c.verdict, 'REGRESSION')
})

test('the interval is clamped to [-1, 1] and holds delta, even at an all-to-nothing collapse', () => {
  const c = compare(side('a', cases(30, p(5))), side('b', cases(30, f(5))))
  assert.equal(c.delta, -1)
  near(c.interval!, { lo: -1, hi: -0.8652656870791937 })
  assert.equal(c.verdict, 'REGRESSION')
})

test('the NO CHANGE boundary for identical all-pass suites is where the spec says', () => {
  const at = (n: number, t: number) => compare(side('a', cases(n, p(t))), side('b', cases(n, p(t)))).verdict
  assert.deepEqual([at(5, 30), at(6, 30)], ['INCONCLUSIVE', 'NO CHANGE'])
  assert.deepEqual([at(30, 10), at(31, 10)], ['INCONCLUSIVE', 'NO CHANGE'])
  assert.deepEqual([at(108, 5), at(109, 5)], ['INCONCLUSIVE', 'NO CHANGE'])
})

test('the interval does not depend on the order verdicts arrive in', () => {
  const rows: [string, string][] = cases(12, 'ppppf').map(([id], i) => [id, i % 3 ? p(5) : 'ppfff'])
  const a = side('a', rows)
  const b = side('b', cases(12, 'ppppf'))
  const reversed = { ...a, verdicts: [...a.verdicts].reverse() }
  assert.deepEqual(compare(reversed, { ...b, verdicts: [...b.verdicts].reverse() }).interval, compare(a, b).interval)
})

test('a hash on only one side excludes the case rather than trusting it', () => {
  const a = { ...side('a', [['s/x', p(5)]]), hashes: { 's/x': 'h1' } }
  const c = compare(a, side('b', [['s/x', f(5)]]))
  assert.deepEqual(c.excluded, [{ case: 's/x', reason: 'the case hash is missing on b' }])
  assert.deepEqual(c.flips, [])
  assert.equal(c.verdict, 'INCONCLUSIVE')
})

test('a case neither side scored says so', () => {
  const c = compare(side('a', [['s/x', 'e']]), side('b', [['s/x', 'e']]))
  assert.deepEqual(c.excluded, [{ case: 's/x', reason: 'neither side scored any trials' }])
})

test('the suite verdict boundaries are inclusive exactly as the rules say', () => {
  assert.equal(suiteVerdict({ lo: -0.2, hi: -0.05 }, 0.05), 'INCONCLUSIVE') // hi == -δ is not below it
  assert.equal(suiteVerdict({ lo: -0.2, hi: -0.0500001 }, 0.05), 'REGRESSION')
  assert.equal(suiteVerdict({ lo: 0.05, hi: 0.2 }, 0.05), 'INCONCLUSIVE')
  assert.equal(suiteVerdict({ lo: -0.05, hi: 0.05 }, 0.05), 'NO CHANGE') // both ends inclusive
})

test('a WARN needs the ratio strictly outside the band', () => {
  const at = (bTokens: number) => compare(side('a', cases(1, p(5)), { tokens: 100 }), side('b', cases(1, p(5)), { tokens: bTokens })).warns.length
  assert.deepEqual([at(150), at(150.01), at(66)], [0, 1, 1])
  // Exactly on the lower edge: 100/150 and 1/1.5 are the same double.
  const low = compare(side('a', cases(1, p(5)), { tokens: 150 }), side('b', cases(1, p(5)), { tokens: 100 }))
  assert.equal(100 / 150, 1 / 1.5)
  assert.deepEqual(low.warns, [])
})

test('canaries compare on successes, not passes: a canary that starts passing is a REGRESSION', () => {
  const c = compare(side('a', cases(10, f(5)), undefined, 'fail'), side('b', cases(10, p(5)), undefined, 'fail'))
  assert.equal(c.delta, -1)
  assert.equal(c.verdict, 'REGRESSION')
  assert.deepEqual(c.flips[0], { case: 'smoke/c0', from: 'PASS', to: 'FAIL' })
})

test('without case hashes on either side the comparison says the changed-case check was skipped', () => {
  assert.deepEqual(compare(side('a', cases(1, 'p')), side('b', cases(1, 'p'))).notes, ['case hashes unavailable on both sides: a case that changed between them was not detected'])
  const hashed = { 'smoke/c0': 'h' }
  assert.deepEqual(compare({ ...side('a', cases(1, 'p')), hashes: hashed }, { ...side('b', cases(1, 'p')), hashes: hashed }).notes, [])
})

test('a non-finite metric median is skipped, never warned on', () => {
  const c = compare(side('a', cases(1, 'p'), { tokens: NaN, cost_usd: 1 }), side('b', cases(1, 'p'), { tokens: 5, cost_usd: Infinity }))
  assert.deepEqual(c.warns, [])
})

// Calibration, counted exactly: one case, both sides drawn from the same true
// rate, every possible record weighed by its probability. A 95% interval may
// claim a change at most 2.5% of the time in each direction.
test('a single case claims a change no more often than a 95% interval allows, at any trial counts', () => {
  const binom = (n: number, k: number, q: number) => choose(n, k) * q ** k * (1 - q) ** (n - k)
  const trials = (n: number, s: number) => p(s) + f(n - s)
  for (const [na, nb] of [[1, 1], [1, 30], [30, 1], [3, 3], [5, 5], [5, 6], [6, 6], [10, 1], [30, 3], [30, 6], [10, 10], [30, 30]] as const) {
    for (const q of [0.1, 0.5, 0.8, 0.9, 0.95]) {
      let down = 0
      let up = 0
      for (let sa = 0; sa <= na; sa++) {
        for (let sb = 0; sb <= nb; sb++) {
          const v = compare(side('a', [['s/x', trials(na, sa)]]), side('b', [['s/x', trials(nb, sb)]])).verdict
          const w = binom(na, sa, q) * binom(nb, sb, q)
          if (v === 'REGRESSION') down += w
          if (v === 'IMPROVEMENT') up += w
        }
      }
      assert.ok(down <= 0.025 && up <= 0.025, `${na}v${nb} at ${q}: REGRESSION ${down}, IMPROVEMENT ${up}`)
    }
  }
})
