import type { Exit, TrialStatus, Verdict, VerdictKind } from '../core/types.ts'
import { passAtK, passPowK, wilson } from './intervals.ts'

export type TrialOutcome = { status: TrialStatus; exit: Exit }

export type SettleInput = {
  case: string
  config: string
  policy: 'all' | 'rate'
  threshold: number // rate policy only
  min_trials: number // the effective value (suite/load.ts effectiveMinTrials), never the raw configured one
  expect: 'pass' | 'fail'
  trials: number // scheduled
  outcomes: TrialOutcome[]
}

// Rules in docs/ARCHITECTURE.md § Verdicts. Everything is computed on
// successes rather than passes, so a canary that starts passing loses
// successes and reads as a drop, the same as any other regression.
export function settle(raw: SettleInput): Verdict {
  // Capped by the trials scheduled: a run that asked for fewer can still settle.
  const input = { ...raw, min_trials: Math.min(raw.min_trials, raw.trials) }
  const { outcomes, expect } = input
  // A cancelled trial never ran to an outcome, so it is neither scored nor an
  // error; counting it as either would let Ctrl-C decide a verdict.
  const passes = outcomes.filter(o => o.status === 'pass').length
  const fails = outcomes.filter(o => o.status === 'fail').length
  const errors = outcomes.filter(o => o.status === 'error').length
  const scored = passes + fails
  // A canary succeeds only when graders ran and rejected the known-bad output.
  // A model failure also ends in 'fail', but the graders never judged anything,
  // so it proves nothing about them.
  const successes = expect === 'pass' ? passes : outcomes.filter(o => o.status === 'fail' && o.exit === 'ok').length

  const interval = wilson(successes, scored)
  const k = scored === 0 ? null : Math.min(3, scored)
  const verdict = decide(input, passes, successes, scored, interval)
  return {
    case: input.case,
    config: input.config,
    verdict,
    inconclusive_reason: verdict !== 'INCONCLUSIVE' ? null : scored < input.min_trials ? 'min_trials' : 'interval',
    policy: input.policy,
    expect,
    unexpected_pass: expect === 'fail' && passes > 0,
    trials: input.trials,
    scored,
    errors,
    passes,
    successes,
    success_rate: scored === 0 ? null : successes / scored,
    interval,
    k,
    pass_at_k: k === null ? null : passAtK(scored, successes, k),
    pass_pow_k: k === null ? null : passPowK(scored, successes, k),
  }
}

function decide(
  input: SettleInput,
  passes: number,
  successes: number,
  scored: number,
  ci: Verdict['interval'],
): VerdictKind {
  // Infra errors say nothing about the subject, so they never count toward a
  // verdict; too few scored trials is a question left open, not a FAIL.
  if (scored === 0 || ci === null) return 'ERROR'
  // Before the min_trials guard, and never FLAKY: a canary that passes even
  // once means the grader sometimes waves known-bad output through. One pass
  // is already proof; waiting for more trials would only hide it.
  if (input.expect === 'fail' && passes > 0) return 'FAIL'
  if (scored < input.min_trials) return 'INCONCLUSIVE'

  if (input.policy === 'all') {
    if (successes === scored) return 'PASS'
    if (successes === 0) return 'FAIL'
    return 'FLAKY'
  }

  // No FLAKY under rate: a capability suite expects a mixed record, so the
  // only open question is whether the interval has cleared the threshold yet.
  if (ci.lo >= input.threshold) return 'PASS'
  if (ci.hi < input.threshold) return 'FAIL'
  return 'INCONCLUSIVE'
}

// The fewest trials at which even an unbroken run can PASS under the rate
// policy. Below it a case is INCONCLUSIVE however it performs (5/5 at 0.8 is),
// so config loading can refuse a trial count that could never pass.
//
// n/n's Wilson lower bound is n/(n + z²), so the answer is near z²t/(1−t); it
// is found by bisection on wilson itself, so rounding can never disagree with
// settle(), in about 60 steps however close t is to 1. A threshold that would
// need more than MAX_TRIALS unbroken passes is refused: no run is that long.
export const MAX_TRIALS = 10_000_000

export function minTrialsToPass(threshold: number, z?: number): number {
  if (!(threshold >= 0 && threshold < 1)) {
    throw new RangeError(`threshold ${threshold} is outside [0, 1); no finite run can reach it`)
  }
  if (z !== undefined && !(Number.isFinite(z) && z > 0)) throw new RangeError(`z ${z} must be a finite positive number`)
  const zz = (z ?? 1.959963984540054) ** 2
  const passes = (n: number) => wilson(n, n, z)!.lo >= threshold
  let hi = Math.max(1, Math.ceil((zz * threshold) / (1 - threshold)))
  if (!(hi <= MAX_TRIALS)) throw new RangeError(`threshold ${threshold} needs more than ${MAX_TRIALS} unbroken trials to pass`)
  while (!passes(hi)) {
    hi *= 2
    if (hi > 2 * MAX_TRIALS) throw new RangeError(`threshold ${threshold} needs more than ${MAX_TRIALS} unbroken trials to pass`)
  }
  let lo = 0 // never passes: wilson is undefined at 0, and a pass needs a trial
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (mid > 0 && passes(mid)) hi = mid
    else lo = mid
  }
  return hi
}
