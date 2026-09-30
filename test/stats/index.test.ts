import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compare, settle, type TrialOutcome } from '../../src/stats/index.ts'

test('verdicts settled through the entry point compare into a suite verdict', () => {
  const pass: TrialOutcome = { status: 'pass', exit: 'ok' }
  const fail: TrialOutcome = { status: 'fail', exit: 'ok' }
  const side = (label: string, outcome: TrialOutcome) => ({
    label,
    verdicts: Array.from({ length: 10 }, (_, i) =>
      settle({
        case: `smoke/c${i}`,
        config: label,
        policy: 'all',
        threshold: 0.8,
        min_trials: 1,
        expect: 'pass',
        trials: 5,
        outcomes: Array(5).fill(outcome),
      }),
    ),
  })
  assert.equal(compare(side('opus', pass), side('haiku', fail)).verdict, 'REGRESSION')
})
