import type { Comparison, Flip, Interval, SuiteVerdictKind, Verdict, Warn } from '../core/types.ts'
import { normal } from './distributions.ts'
import { mulberry32 } from './prng.ts'

type Metrics = Partial<Record<Warn['metric'], number>>

export type CompareSide = {
  label: string
  verdicts: Verdict[] // one per case: a side is a single config
  metrics?: Metrics // per-case medians for this side
  // Per-case hash of everything that decides scoring: case.yaml, truth,
  // fixture, change, proof, fix, and the grader and extractor hashes. A case
  // whose hash differs between sides is excluded, never compared.
  hashes?: Record<string, string>
  notes?: string[] // subject or plugin version, reported but not excluding
}

export type CompareOptions = {
  tolerance?: number
  resamples?: number
  seed?: number
  warnRatio?: number
}

// Fixed order, so warns list the same way on every run.
const METRICS: Warn['metric'][] = ['tokens', 'cost_usd', 'wall_clock_ms', 'tool_calls', 'findings']

// Rules in docs/ARCHITECTURE.md § Comparison.
export function compare(a: CompareSide, b: CompareSide, opts: CompareOptions = {}): Comparison {
  const { tolerance = 0.05, resamples = 2000, seed = 1, warnRatio = 1.5 } = opts
  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new RangeError(`resamples must be a positive integer, got ${resamples}`)
  }
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
    const ha = a.hashes?.[id]
    const hb = b.hashes?.[id]
    if (ha !== undefined && hb !== undefined && ha !== hb) {
      excluded.push({ case: id, reason: 'the case changed between the two sides' })
      continue
    }
    // A flip into or out of ERROR is still listed: a case that stopped
    // scoring is news, even though it cannot move the suite verdict.
    if (va.verdict !== vb.verdict) flips.push({ case: id, from: va.verdict, to: vb.verdict })
    if (va.scored === 0 || vb.scored === 0) excluded.push({ case: id, reason: `${va.scored === 0 ? a.label : b.label} scored no trials` })
    else pairs.push([va, vb])
  }
  for (const id of byB.keys()) if (!byA.has(id)) excluded.push({ case: id, reason: `only ${b.label} ran it` })
  excluded.sort((x, y) => (x.case < y.case ? -1 : x.case > y.case ? 1 : 0))

  const n = pairs.length
  // The observed difference, which is also where the bootstrap centres each
  // case, so delta always sits inside its own interval.
  const delta = n === 0 ? null : pairs.reduce((s, [va, vb]) => s + rate(vb) - rate(va), 0) / n
  const interval = n === 0 ? null : bootstrap(pairs, resamples, seed)
  return {
    a: a.label,
    b: b.label,
    cases: n,
    excluded,
    notes: [...new Set([...(a.notes ?? []), ...(b.notes ?? [])])],
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

// Two levels, because either alone reads too tight. Resampling cases captures
// how much the difference varies across cases; a per-case draw captures how
// little a handful of trials pins each rate down. With cases alone, a single
// case resamples to the same difference every time, so 1/1 against 0/1 would
// read as a certain REGRESSION.
//
// Each case's draw is centred on its observed difference, so two sides with
// the same record contribute zero whatever their trial counts. Its spread
// comes from Jeffreys-smoothed rates, p̃ = (s + ½)/(n + 1), with variance
// p̃(1 − p̃)/n per side. Smoothing keeps an all-pass record from claiming zero
// variance. Centring on a posterior mean instead would pull 1/1 to 0.75 and
// 5/5 to 0.92, and 30 cases of that gap read as a confident regression
// between two sides that never failed.
function bootstrap(pairs: [Verdict, Verdict][], resamples: number, seed: number): Interval {
  const rng = mulberry32(seed)
  const n = pairs.length
  const diffs = pairs.map(([va, vb]) => rate(vb) - rate(va))
  const sds = pairs.map(([va, vb]) => Math.sqrt(smoothedVariance(va) + smoothedVariance(vb)))
  const means = new Float64Array(resamples)
  for (let r = 0; r < resamples; r++) {
    let sum = 0
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rng() * n)
      sum += Math.max(-1, Math.min(1, diffs[j]! + sds[j]! * normal(rng)))
    }
    means[r] = sum / n
  }
  means.sort()
  // Nearest rank, rounded outward: floor for the 2.5th percentile, ceil for the
  // 97.5th. The interval is never narrower than the percentiles it names, so
  // rounding can push a borderline suite toward INCONCLUSIVE but never
  // manufacture a REGRESSION.
  return {
    lo: means[Math.floor(0.025 * (resamples - 1))]!,
    hi: means[Math.ceil(0.975 * (resamples - 1))]!,
  }
}

function smoothedVariance(v: Verdict): number {
  const p = (v.successes + 0.5) / (v.scored + 1)
  return (p * (1 - p)) / v.scored
}

function suiteVerdict(ci: Interval | null, tolerance: number): SuiteVerdictKind {
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
    if (va === undefined || vb === undefined || va <= 0) continue
    const ratio = vb / va
    if (ratio > limit || ratio < 1 / limit) out.push({ metric, a: va, b: vb, ratio })
  }
  return out
}
