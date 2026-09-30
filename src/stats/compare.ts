import type { Comparison, Flip, Interval, SuiteVerdictKind, Verdict, Warn } from '../core/types.ts'
import { clopperPearson, wilson } from './intervals.ts'

type Metrics = Partial<Record<Warn['metric'], number>>

export type CompareSide = {
  label: string
  verdicts: Verdict[] // one per case: a side is a single config
  metrics?: Metrics // the per-trial median of each metric over this side's trials: one number per metric
  // Per-case hash of everything that decides scoring: case.yaml, truth,
  // fixture, change, proof, fix, and the grader and extractor hashes. A case
  // whose hash differs between sides is excluded, never compared.
  hashes?: Record<string, string>
  notes?: string[] // subject or plugin version, reported but not excluding
}

export type CompareOptions = {
  tolerance?: number
  warnRatio?: number
}

// Fixed order, so warns list the same way on every run.
const METRICS: Warn['metric'][] = ['tokens', 'cost_usd', 'wall_clock_ms', 'tool_calls', 'findings']

// Rules in docs/ARCHITECTURE.md § Comparison.
export function compare(a: CompareSide, b: CompareSide, opts: CompareOptions = {}): Comparison {
  const { tolerance = 0.05, warnRatio = 1.5 } = opts
  // The config schema guards these too; compare() is also called directly.
  if (!(tolerance >= 0 && tolerance < 1)) throw new RangeError(`tolerance must be in [0, 1), got ${tolerance}`)
  if (!(Number.isFinite(warnRatio) && warnRatio > 1)) throw new RangeError(`warnRatio must be a finite number above 1, got ${warnRatio}`)
  const byA = byCase(a)
  const byB = byCase(b)

  const flips: Flip[] = []
  const excluded: Comparison['excluded'] = []
  const pairs: [Verdict, Verdict][] = []
  for (const [id, va] of byA) {
    const vb = byB.get(id)
    if (!vb) {
      excluded.push({ case: id, reason: `only ${a.label} ran it` })
      continue
    }
    // A case whose ground truth, fixture or graders changed measures a
    // different thing on each side; pairing it would blame the model for the
    // edit. It is excluded, and so is its flip.
    // A hash on one side only is a gap in the record, not proof the case is
    // unchanged, so it is excluded too rather than trusted.
    const ha = a.hashes?.[id]
    const hb = b.hashes?.[id]
    if (ha !== hb) {
      excluded.push({ case: id, reason: ha === undefined || hb === undefined ? `the case hash is missing on ${ha === undefined ? a.label : b.label}` : 'the case changed between the two sides' })
      continue
    }
    // A flip into or out of ERROR is still listed: a case that stopped
    // scoring is news, even though it cannot move the suite verdict.
    if (va.verdict !== vb.verdict) flips.push({ case: id, from: va.verdict, to: vb.verdict })
    if (va.scored === 0 && vb.scored === 0) excluded.push({ case: id, reason: 'neither side scored any trials' })
    else if (va.scored === 0 || vb.scored === 0) excluded.push({ case: id, reason: `${va.scored === 0 ? a.label : b.label} scored no trials` })
    else pairs.push([va, vb])
  }
  for (const id of byB.keys()) if (!byA.has(id)) excluded.push({ case: id, reason: `only ${b.label} ran it` })
  excluded.sort((x, y) => (x.case < y.case ? -1 : x.case > y.case ? 1 : 0))

  // By case id, so floating-point sums (and so the interval, to the last bit)
  // do not depend on the order a store wrote verdicts in. Flips keep A's order.
  pairs.sort(([x], [y]) => (x.case < y.case ? -1 : x.case > y.case ? 1 : 0))
  const n = pairs.length
  const delta = n === 0 ? null : pairs.reduce((s, [va, vb]) => s + rate(vb) - rate(va), 0) / n
  const interval = n === 0 ? null : mover(pairs)
  // Without hashes on either side, a case whose ground truth changed cannot be
  // told from one whose model did; the comparison says so rather than guessing.
  const unhashed = a.hashes === undefined && b.hashes === undefined ? ['case hashes unavailable on both sides: a case that changed between them was not detected'] : []
  return {
    a: a.label,
    b: b.label,
    cases: n,
    excluded,
    notes: [...new Set([...(a.notes ?? []), ...(b.notes ?? []), ...unhashed])],
    flips,
    delta,
    interval,
    tolerance,
    verdict: suiteVerdict(interval, tolerance),
    warns: warns(a.metrics, b.metrics, warnRatio),
  }
}

// A Map keeps A's insertion order, which is the order flips are reported in.
function byCase(side: CompareSide): Map<string, Verdict> {
  const out = new Map<string, Verdict>()
  for (const v of side.verdicts) {
    // Two verdicts for one case means two configs on one side; pairing either
    // silently would compare the wrong runs.
    if (out.has(v.case)) throw new Error(`case ${v.case} appears twice on side "${side.label}"`)
    out.set(v.case, v)
  }
  return out
}

const rate = (v: Verdict) => v.successes / v.scored

// The suite difference is D = mean over paired cases of (B's rate − A's). Both
// sides run the same cases, so the cases are fixed and only trial noise is
// uncertain. Its 95% interval is MOVER (Zou & Donner): the interval for a sum
// of independent proportions recovered from each proportion's own interval,
//
//   lo = D − √Σ[(p̂B − lB)² + (uA − p̂A)²] / n
//   hi = D + √Σ[(uB − p̂B)² + (p̂A − lA)²] / n
//
// It is deterministic, holds its coverage at unequal trial counts, and pays
// for trial noise once. A per-side interval is Wilson from WILSON_MIN_TRIALS
// trials, and exact (Clopper–Pearson) below: Wilson's coverage at 1 to 5
// trials dips far enough that 30/30 against a single failure read as a
// REGRESSION about one time in twelve with nothing changed.
export const WILSON_MIN_TRIALS = 6

function mover(pairs: [Verdict, Verdict][]): Interval {
  const n = pairs.length
  let d = 0
  let below = 0
  let above = 0
  for (const [va, vb] of pairs) {
    const pa = rate(va)
    const pb = rate(vb)
    const ia = sideInterval(va)
    const ib = sideInterval(vb)
    d += pb - pa
    below += (pb - ib.lo) ** 2 + (ia.hi - pa) ** 2
    above += (ib.hi - pb) ** 2 + (pa - ia.lo) ** 2
  }
  return { lo: Math.max(-1, (d - Math.sqrt(below)) / n), hi: Math.min(1, (d + Math.sqrt(above)) / n) }
}

const sideInterval = (v: Verdict): Interval => (v.scored >= WILSON_MIN_TRIALS ? wilson(v.successes, v.scored)! : clopperPearson(v.successes, v.scored)!)

export function suiteVerdict(ci: Interval | null, tolerance: number): SuiteVerdictKind {
  if (ci === null) return 'INCONCLUSIVE'
  if (ci.hi < -tolerance) return 'REGRESSION'
  if (ci.lo > tolerance) return 'IMPROVEMENT'
  if (-tolerance <= ci.lo && ci.hi <= tolerance) return 'NO CHANGE'
  return 'INCONCLUSIVE'
}

// Both directions warn: a run that suddenly spends over a third fewer tokens or
// tool calls may be an agent quitting early, and every verdict can hold while
// it happens.
function warns(a: Metrics | undefined, b: Metrics | undefined, limit: number): Warn[] {
  const out: Warn[] = []
  for (const metric of METRICS) {
    const va = a?.[metric]
    const vb = b?.[metric]
    // A non-finite median (NaN, Infinity) is a bad record, not a ratio.
    if (va === undefined || vb === undefined || !Number.isFinite(va) || !Number.isFinite(vb) || va <= 0) continue
    const ratio = vb / va
    if (ratio > limit || ratio < 1 / limit) out.push({ metric, a: va, b: vb, ratio })
  }
  return out
}
