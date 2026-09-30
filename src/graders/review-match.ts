import { realpathSync } from 'node:fs'
import { ConfigError } from '../core/errors.ts'
import type { Usage } from '../core/types.ts'
import { Findings, type Finding, type Grader as GraderSpec, type TruthFile } from '../suite/schema.ts'
import { normPath, readArtifact } from './common.ts'
import { askJudge, sumUsage } from './judges.ts'
import { optimalMatching, type Candidate } from './matching.ts'
import { confirmRequest } from './prompts.ts'
import type { Grader, TrialResult } from './types.ts'

// docs/ARCHITECTURE.md § review-match, as code.

type Span = { file: string; start: number; end: number }

// 0 when the ranges overlap, else the count of lines strictly between them.
export function gap(a: Span, b: Span): number {
  if (a.end < b.start) return b.start - a.end - 1
  if (b.end < a.start) return a.start - b.end - 1
  return 0
}

// Harness subjects often cite absolute paths inside their cwd. Unstripped,
// every one of those findings would miss its bug and count as a false positive.
export function findingPath(file: string, workdirs: string[]): string {
  const p = file.replaceAll('\\', '/')
  for (const w of workdirs) {
    const prefix = `${w.replaceAll('\\', '/').replace(/\/+$/, '')}/`
    if (p.startsWith(prefix)) return normPath(p.slice(prefix.length))
  }
  return normPath(p)
}

export type Outcome = 'decoy_hit' | 'duplicate' | 'nit' | 'false_positive'
export type Scored = {
  pairs: { bug: number; finding: number }[] // in truth order
  unmatched: { finding: number; as: Outcome; near?: string }[] // near: the decoy or bug id it fell by
}

export function score(truth: TruthFile, findings: Finding[], window: number, workdirs: string[] = []): Scored {
  const fs: Span[] = findings.map(f => ({ file: findingPath(f.file, workdirs), start: f.line, end: f.end_line ?? f.line }))
  const bs: Span[] = truth.bugs.map(b => ({ file: normPath(b.file), start: b.lines[0], end: b.lines[1] }))
  const ds: Span[] = truth.decoys.map(d => ({ file: normPath(d.file), start: d.lines[0], end: d.lines[1] }))
  const near = (f: Span, t: Span) => f.file === t.file && gap(f, t) <= window

  // The tie-breaks as a cost vector, compared lexicographically:
  //   [total gap, bug i matched (-1) for i in truth order, finding index matched to bug i]
  // so among maximum matchings the smallest total gap wins, then the one that
  // matches the earliest bugs in truth order, then the earliest findings for
  // those bugs. The last two make the optimum unique, hence deterministic.
  const nb = bs.length
  const candidates: Candidate[] = []
  bs.forEach((b, i) =>
    fs.forEach((f, j) => {
      if (!near(f, b)) return
      const cost = new Array<number>(1 + 2 * nb).fill(0)
      cost[0] = gap(f, b)
      cost[1 + i] = -1
      cost[1 + nb + i] = j
      candidates.push({ left: i, right: j, cost })
    }),
  )
  const pairs = optimalMatching(nb, fs.length, candidates)
    .map(p => ({ bug: p.left, finding: p.right }))
    .sort((a, b) => a.bug - b.bug)

  const matchedFindings = new Set(pairs.map(p => p.finding))
  const matchedBugs = new Set(pairs.map(p => p.bug))
  const unmatched: Scored['unmatched'] = []
  fs.forEach((f, j) => {
    if (matchedFindings.has(j)) return
    const decoy = ds.findIndex(d => near(f, d))
    const dup = bs.findIndex((b, i) => matchedBugs.has(i) && near(f, b))
    if (decoy >= 0) unmatched.push({ finding: j, as: 'decoy_hit', near: truth.decoys[decoy]!.id })
    else if (dup >= 0) unmatched.push({ finding: j, as: 'duplicate', near: truth.bugs[dup]!.id })
    // A clean case has no nits: every finding on it claims a bug that is not there.
    else if (truth.kind === 'seeded' && (findings[j]!.severity === 'info' || findings[j]!.severity === 'low')) unmatched.push({ finding: j, as: 'nit' })
    else unmatched.push({ finding: j, as: 'false_positive' })
  })
  return { pairs, unmatched }
}

export function metrics(truth: TruthFile, findings: Finding[], s: Scored, confirmed?: number): Record<string, number | null> {
  const ratio = (a: number, b: number) => (b === 0 ? null : a / b)
  const count = (o: Outcome) => s.unmatched.filter(u => u.as === o).length
  const matched = s.pairs.length
  const fp = count('false_positive')
  const decoys = count('decoy_hit')
  const m: Record<string, number | null> = { recall: ratio(matched, truth.bugs.length) }
  for (const sev of ['critical', 'high', 'medium', 'low'] as const) {
    const of = truth.bugs.filter(b => b.severity === sev).length
    m[`recall_${sev}`] = ratio(s.pairs.filter(p => truth.bugs[p.bug]!.severity === sev).length, of)
  }
  m['precision'] = ratio(matched, matched + fp + decoys)
  m['precision_all'] = ratio(matched, findings.length)
  m['false_positives'] = fp
  m['decoy_hits'] = decoys
  m['duplicates'] = count('duplicate')
  m['nits'] = count('nit')
  m['findings'] = findings.length
  m['matched'] = matched
  m['bugs'] = truth.bugs.length
  if (confirmed !== undefined) {
    m['confirmed'] = confirmed
    m['claims_correct'] = ratio(confirmed, matched)
  }
  return m
}

type Bounds = Extract<GraderSpec, { kind: 'review-match' }>['pass']

const BOUNDS: { bound: keyof Bounds; metric: string; min?: true; na?: string }[] = [
  { bound: 'min_recall', metric: 'recall', min: true, na: 'no bugs' },
  { bound: 'max_false_positives', metric: 'false_positives' },
  { bound: 'max_decoy_hits', metric: 'decoy_hits' },
  { bound: 'max_duplicates', metric: 'duplicates' },
  { bound: 'max_nits', metric: 'nits' },
  { bound: 'max_findings', metric: 'findings' },
  { bound: 'min_claims_correct', metric: 'claims_correct', min: true, na: 'nothing matched' },
]

// A bound on a null metric does not apply (min_recall on a clean case) and
// says so. The check is explicit: JavaScript compares null as 0, so
// `null <= 5` is true and a careless bound would pass on a metric that was
// never measured.
// A grade with no bound that applies has measured nothing, so it fails: with
// `pass: {}`, or only bounds that read n/a, an empty review of a seeded case
// would otherwise pass at recall 0.
export function checkBounds(pass: Bounds, m: Record<string, number | null>): { failed: string[]; na: string[] } {
  const failed: string[] = []
  const na: string[] = []
  let applied = 0
  for (const b of BOUNDS) {
    const limit = pass[b.bound]
    if (limit === undefined) continue
    const v = m[b.metric]
    if (v === null || v === undefined) {
      na.push(`${b.bound}: n/a (${b.na ?? 'not measured'})`)
      continue
    }
    applied++
    const ok = b.min ? v >= limit : v <= limit
    if (!ok) failed.push(`${b.metric} ${round(v)} ${b.min ? '<' : '>'} ${b.bound} ${limit}`)
  }
  if (applied === 0) failed.push('no pass bound applies to this case, so nothing was checked')
  return { failed, na }
}

export const reviewMatch: Grader<'review-match'> = async (spec, trial, ctx) => {
  const truth = ctx.case.truth
  if (!truth) throw new ConfigError(`${ctx.case.id}: review-match needs a truth.yaml`)
  if (spec.pass.min_claims_correct !== undefined && spec.confirm === undefined) {
    throw new ConfigError(`${ctx.case.id}: min_claims_correct needs confirm: <judge>`)
  }
  const judge = spec.confirm === undefined ? undefined : ctx.judge(spec.confirm)

  // An unreadable artifact is scored as no findings, so recall reads 0, and
  // the grade fails regardless: on a clean case "no findings" would otherwise
  // be a perfect score for a reviewer that crashed.
  const read = readFindings(trial, spec.artifact)
  const findings = 'error' in read ? [] : read.findings
  const s = score(truth, findings, spec.window, workdirs(trial.workdir))

  let confirmed: number | undefined
  const unconfirmed: string[] = []
  const spent: Usage[] = []
  if (judge) {
    confirmed = 0
    for (const p of s.pairs) {
      const bug = truth.bugs[p.bug]!
      const v = await askJudge(judge, confirmRequest(bug, findings[p.finding]!), ctx.signal)
      spent.push(v.usage)
      if (v.pass) confirmed++
      else unconfirmed.push(`unconfirmed: ${bug.id}: ${v.rationale}`)
    }
  }

  const m = metrics(truth, findings, s, confirmed)
  const { failed, na } = checkBounds(spec.pass, m)
  const where = (j: number) => `${findings[j]!.file}:${findings[j]!.line} "${findings[j]!.title}"`
  const lines: string[] = 'error' in read ? [read.error] : []
  lines.push(truth.bugs.length ? `matched ${s.pairs.length}/${truth.bugs.length} bugs` : `clean case: ${findings.length} finding(s)`)
  for (const p of s.pairs) lines.push(`  ${truth.bugs[p.bug]!.id} <- ${where(p.finding)}`)
  const missed = truth.bugs.filter((_, i) => !s.pairs.some(p => p.bug === i)).map(b => b.id)
  if (missed.length) lines.push(`missed: ${missed.join(', ')}`)
  const shown = s.unmatched.slice(0, 20)
  for (const u of shown) lines.push(`${u.as.replace('_', ' ')}: ${where(u.finding)}${u.near ? ` (by ${u.near})` : ''}`)
  if (s.unmatched.length > shown.length) lines.push(`... and ${s.unmatched.length - shown.length} more unmatched`)
  lines.push(...unconfirmed)
  for (const f of failed) lines.push(`failed: ${f}`)
  lines.push(...na)
  return { grader: 'review-match', pass: !('error' in read) && failed.length === 0, metrics: m, rationale: lines.join('\n'), ...(spent.length ? { usage: sumUsage(spent) } : {}) }
}

function readFindings(trial: TrialResult, name: string): { findings: Finding[] } | { error: string } {
  const art = readArtifact(trial, name)
  if (!art) return { error: `${name} was not produced` }
  let raw: unknown
  try {
    raw = JSON.parse(art.text)
  } catch (e) {
    return { error: `${name} is not JSON: ${(e as Error).message}` }
  }
  const r = Findings.safeParse(raw)
  if (!r.success) return { error: `${name} is not valid litmus:findings: ${r.error.issues.slice(0, 3).map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` }
  // Matching is bugs × findings on the event loop; no real review is this long.
  if (r.data.findings.length > MAX_FINDINGS) return { error: `${name} has ${r.data.findings.length} findings, more than the ${MAX_FINDINGS} litmus grades` }
  return { findings: r.data.findings }
}

function workdirs(dir: string): string[] {
  try {
    const real = realpathSync(dir)
    return real === dir ? [dir] : [dir, real]
  } catch {
    return [dir] // the workdir is gone; its path can still be stripped
  }
}

const round = (v: number) => Number(v.toFixed(3))

export const MAX_FINDINGS = 1000
