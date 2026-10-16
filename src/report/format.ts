import type { Comparison, Interval, TrialRecord, Verdict, VerdictKind } from '../core/types.ts'
import type { RunManifest } from '../store/store.ts'
import type { Gate } from './gate.ts'

// Everything a reporter renders once a run is over. Records come from the
// store, which redacted them as they were written.
export type RunReport = {
  manifest: RunManifest
  verdicts: Verdict[]
  comparisons: Comparison[]
  notes: string[]
  trials: TrialRecord[]
  scheduled: string[] // every "<case>@<config>" the run queued, settled or not
  gate: Gate
  exit: number
}

export const VERDICTS: VerdictKind[] = ['PASS', 'FAIL', 'FLAKY', 'ERROR', 'INCONCLUSIVE']

export type Paint = (kind: 'pass' | 'fail' | 'flaky' | 'error' | 'unsure' | 'dim' | 'bold', text: string) => string

const CODES = { pass: 32, fail: 31, flaky: 33, error: 35, unsure: 36, dim: 2, bold: 1 } as const
export const colour: Paint = (kind, text) => `\x1b[${CODES[kind]}m${text}\x1b[0m`
export const plain: Paint = (_, text) => text

const TONE: Record<VerdictKind, Parameters<Paint>[0]> = { PASS: 'pass', FAIL: 'fail', FLAKY: 'flaky', ERROR: 'error', INCONCLUSIVE: 'unsure' }

export const fixed = (x: number) => x.toFixed(2)
export const signed = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}`
const range = (i: Interval, f: (x: number) => string) => `[${f(i.lo)}, ${f(i.hi)}]`

// One line per settled (case, config):
//   PASS          e2e/passes@fake   3/3  rate 1.00 [0.44, 1.00]
export function verdictLine(v: Verdict, paint: Paint, width = 0): string {
  const id = `${v.case}@${v.config}`.padEnd(width)
  const parts = [`${v.successes}/${v.scored}`]
  if (v.expect === 'fail') parts.push('expect fail')
  if (v.success_rate !== null && v.interval) parts.push(`rate ${fixed(v.success_rate)} ${range(v.interval, fixed)}`)
  if (v.errors) parts.push(`${v.errors} error${v.errors === 1 ? '' : 's'}`)
  if (v.unexpected_pass) parts.push('a canary passed')
  if (v.inconclusive_reason) parts.push(`(${v.inconclusive_reason === 'min_trials' ? 'too few scored trials' : 'the interval has not cleared the threshold'})`)
  return `${paint(TONE[v.verdict], v.verdict.padEnd(12))}  ${id}  ${parts.join('  ')}`
}

export function comparisonLines(c: Comparison, paint: Paint): string[] {
  const tone = c.verdict === 'REGRESSION' ? 'fail' : c.verdict === 'IMPROVEMENT' ? 'pass' : c.verdict === 'NO CHANGE' ? 'dim' : 'unsure'
  const delta = c.delta === null || !c.interval ? 'no paired cases' : `Δ ${signed(c.delta)} ${range(c.interval, signed)} over ${c.cases} case${c.cases === 1 ? '' : 's'}, δ ${fixed(c.tolerance)}`
  const out = [`${paint('bold', `${c.a} → ${c.b}`)}  ${paint(tone, c.verdict)}  ${delta}`]
  for (const f of c.flips) out.push(`  flip      ${f.case}: ${f.from} → ${f.to}`)
  for (const w of c.warns) out.push(`  WARN      ${w.metric} ${w.a} → ${w.b} (×${w.ratio.toFixed(2)})`)
  for (const e of c.excluded) out.push(paint('dim', `  excluded  ${e.case}: ${e.reason}`))
  for (const n of c.notes) out.push(paint('dim', `  note      ${n}`))
  return out
}

export function summaryLine(verdicts: Verdict[], paint: Paint): string {
  const counts = VERDICTS.map(k => [k, verdicts.filter(v => v.verdict === k).length] as const).filter(([, n]) => n > 0)
  const n = verdicts.length
  return `${n} verdict${n === 1 ? '' : 's'}${counts.length ? `: ${counts.map(([k, c]) => paint(TONE[k], `${c} ${k}`)).join(' · ')}` : ''}`
}

// Why a pair's trials errored, for the line that names it: a missing key, say,
// which otherwise reaches only trial.json. The distinct first lines of the
// errored trials' reasons (already redacted), each cut at 200 code points,
// the first shown and the rest counted.
export function errorReason(trials: TrialRecord[], v: Verdict): string | undefined {
  const seen = trials.filter(t => t.case === v.case && t.config === v.config && t.status === 'error' && t.reason).map(t => Array.from(t.reason!.split('\n')[0]!).slice(0, 200).join(''))
  const distinct = [...new Set(seen)]
  if (!distinct.length) return undefined
  const more = distinct.length - 1
  return more ? `${distinct[0]} (and ${more} other reason${more === 1 ? '' : 's'})` : distinct[0]
}
