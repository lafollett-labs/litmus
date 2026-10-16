import type { Comparison, Verdict } from '../core/types.ts'

// What the operator lets through (docs/ARCHITECTURE.md § CLI).
export type Gate = { allowFlaky: boolean; allowInconclusive: boolean }

// ok: passes the gate. blocking: exit 1. infra: exit 3, so CI can tell
// infrastructure trouble from a regression.
export type Standing = 'ok' | 'blocking' | 'infra'

export function standing(v: Verdict, gate: Gate): Standing {
  switch (v.verdict) {
    case 'PASS':
      return 'ok'
    case 'FAIL':
      return 'blocking'
    case 'FLAKY':
      return gate.allowFlaky ? 'ok' : 'blocking'
    case 'ERROR':
      return 'infra'
    case 'INCONCLUSIVE':
      // Too few scored trials is the infrastructure's fault; an interval that
      // has not cleared the threshold is the model's.
      return v.inconclusive_reason === 'min_trials' ? 'infra' : gate.allowInconclusive ? 'ok' : 'blocking'
  }
}

// Inside `run`, only a comparison's REGRESSION blocks: small suites rarely
// have the evidence for NO CHANGE, so INCONCLUSIVE there is reported, not gated.
export function runExit(verdicts: Verdict[], comparisons: Comparison[], gate: Gate): 0 | 1 | 3 {
  const s = verdicts.map(v => standing(v, gate))
  if (s.includes('blocking') || comparisons.some(c => c.verdict === 'REGRESSION')) return 1
  if (s.includes('infra')) return 3
  return 0
}

// A standalone compare is the gate itself, so INCONCLUSIVE blocks there
// unless the operator allows it.
export function compareExit(c: Comparison, allowInconclusive: boolean): 0 | 1 {
  if (c.verdict === 'REGRESSION') return 1
  if (c.verdict === 'INCONCLUSIVE' && !allowInconclusive) return 1
  return 0
}
