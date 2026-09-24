import { test } from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigError, InfraError } from '../../src/core/errors.ts'
import { checkBounds, gap, reviewMatch, score } from '../../src/graders/review-match.ts'
import type { Provider } from '../../src/providers/index.ts'
import { CaseFile, type Finding, type TruthFile } from '../../src/suite/schema.ts'
import { oneCase } from '../helpers/cases.ts'
import { ctx, judgeOf, spec, stub, trial, verdict } from '../helpers/grading.ts'

type Sev = Finding['severity']
const bug = (id: string, file: string, lines: [number, number], severity: 'critical' | 'high' | 'medium' | 'low' = 'high') => ({
  id, file, lines, severity, category: 'correctness', summary: `${id}: the mechanism`, proof: 'go test ./...', fix: `fix/${id}.patch`,
})
const decoy = (id: string, file: string, lines: [number, number]) => ({ id, file, lines, summary: `${id} is deliberate` })
const seeded = (bugs: ReturnType<typeof bug>[], decoys: ReturnType<typeof decoy>[] = []): TruthFile => ({ kind: 'seeded', bugs, decoys })
const clean = (decoys: ReturnType<typeof decoy>[] = []): TruthFile => ({ kind: 'clean', bugs: [], decoys })
const f = (file: string, line: number, severity: Sev = 'high', end_line?: number): Finding => ({
  file, line, severity, title: `${file}:${line}`, explanation: 'why', ...(end_line === undefined ? {} : { end_line }),
})
const T = 'internal/auth/token.go'

// A loaded case with this truth, and a trial whose findings.json holds these findings.
function graded(truth: TruthFile, findings: Finding[] | string | null, pass: Record<string, number> = {}, extra: Record<string, unknown> = {}, judge?: Provider) {
  const files: Record<string, string> = { 'truth.yaml': JSON.stringify(truth) }
  for (const b of truth.bugs) files[b.fix] = ''
  const { c } = oneCase('name: c\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: review-match }]\n', files)
  const artifacts = findings === null ? {} : { 'findings.json': typeof findings === 'string' ? findings : JSON.stringify({ findings }) }
  const s = spec({ kind: 'review-match', pass, ...extra })
  return reviewMatch(s, trial({ artifacts }), ctx(c, judge ? { strict: judgeOf(judge, 'strict') } : {}))
}

test('gap is 0 for overlapping or adjacent ranges, else the lines strictly between', () => {
  const s = (start: number, end: number) => ({ file: T, start, end })
  assert.equal(gap(s(10, 12), s(12, 20)), 0)
  assert.equal(gap(s(1, 1), s(2, 2)), 0)
  assert.equal(gap(s(1, 1), s(3, 3)), 1)
  assert.equal(gap(s(30, 31), s(10, 12)), 17)
  assert.equal(gap(s(10, 12), s(30, 31)), 17)
})

test('the case greedy gets wrong: a maximum matching scores both bugs', () => {
  // A (line 14) is 3 lines from bug 1 and 5 from bug 2; B (line 8) is 1 from
  // bug 1 and 11 from bug 2, out of reach. Greedy gives A to bug 1 and strands
  // B and bug 2: recall 0.5. The maximum matching is A–2, B–1: recall 1.
  const truth = seeded([bug('one', T, [10, 10]), bug('two', T, [20, 20])])
  const A = f(T, 14)
  const B = f(T, 8)
  assert.deepEqual(score(truth, [A, B], 5).pairs, [{ bug: 0, finding: 1 }, { bug: 1, finding: 0 }])
})

test('the greedy case, graded: recall 1.0 and a pass at min_recall 1', async () => {
  const r = await graded(seeded([bug('one', T, [10, 10]), bug('two', T, [20, 20])]), [f(T, 14), f(T, 8)], { min_recall: 1 })
  assert.equal(r.pass, true, r.rationale ?? '')
  assert.equal(r.metrics?.['recall'], 1)
  assert.equal(r.metrics?.['false_positives'], 0)
  assert.equal(r.metrics?.['precision'], 1)
})

test('tie-break: among maximum matchings the smallest total gap wins', () => {
  // One bug, two findings: the one on the line beats the one two lines off,
  // whichever comes first in the file.
  const s = score(seeded([bug('b', T, [10, 10])]), [f(T, 13), f(T, 10)], 5)
  assert.deepEqual(s.pairs, [{ bug: 0, finding: 1 }])
  // ...and total gap outranks truth order: 7 lines from bug 1, 1 line from bug 2.
  const t = score(seeded([bug('one', T, [10, 10]), bug('two', T, [20, 20])]), [f(T, 18)], 10)
  assert.deepEqual(t.pairs, [{ bug: 1, finding: 0 }])
})

test('tie-break: with equal gaps, the earliest bug in truth order is matched', () => {
  const one = bug('one', T, [10, 12])
  const two = bug('two', T, [12, 14])
  assert.deepEqual(score(seeded([one, two]), [f(T, 12)], 5).pairs, [{ bug: 0, finding: 0 }])
  assert.deepEqual(score(seeded([two, one]), [f(T, 12)], 5).pairs, [{ bug: 0, finding: 0 }]) // "two", now listed first
})

test('tie-break: with equal gaps and bugs, the earliest finding is matched', () => {
  const s = score(seeded([bug('b', T, [10, 10])]), [f(T, 10), f(T, 10)], 5)
  assert.deepEqual(s.pairs, [{ bug: 0, finding: 0 }])
})

test('findings match only within the window and in the same normalized file', () => {
  const truth = seeded([bug('b', T, [10, 12])])
  assert.equal(score(truth, [f(T, 18)], 5).pairs.length, 1) // gap 5
  assert.equal(score(truth, [f(T, 19)], 5).pairs.length, 0) // gap 6
  assert.equal(score(truth, [f(T, 3, 'high', 4)], 5).pairs.length, 1) // a range ending 5 lines before
  assert.equal(score(truth, [f('internal/auth/other.go', 10)], 5).pairs.length, 0)
  assert.equal(score(truth, [f(`./${T}`, 10), f('internal\\auth\\token.go', 11)], 0).pairs.length, 1)
  assert.equal(score(truth, [f('internal\\auth\\token.go', 11)], 0).pairs.length, 1)
})

test('an absolute path inside the workdir, or its realpath, is stripped to the tree path', async () => {
  const truth = seeded([bug('b', T, [10, 10])])
  const t = trial()
  const real = realpathSync(t.workdir)
  assert.equal(score(truth, [f(join(t.workdir, T), 10)], 0, [t.workdir, real]).pairs.length, 1)
  assert.equal(score(truth, [f(join(real, T), 10)], 0, [t.workdir, real]).pairs.length, 1)
  assert.equal(score(truth, [f(`/elsewhere/${T}`, 10)], 0, [t.workdir, real]).unmatched[0]?.as, 'false_positive')
})

test('an absolute path is stripped when graded end to end', async () => {
  const truth = seeded([bug('b', T, [10, 10])])
  const files: Record<string, string> = { 'truth.yaml': JSON.stringify(truth), 'fix/b.patch': '' }
  const { c } = oneCase('name: c\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: review-match }]\n', files)
  const t = trial()
  const findings = JSON.stringify({ findings: [f(join(realpathSync(t.workdir), T), 10)] })
  const withFindings = trial({ artifacts: { 'findings.json': findings } })
  const r = await reviewMatch(spec({ kind: 'review-match', pass: { min_recall: 1 } }), { ...withFindings, workdir: t.workdir }, ctx(c))
  assert.equal(r.pass, true, r.rationale ?? '')
})

test('decoy geometry: within the window of a decoy is a decoy hit at any severity; beyond it, a false positive', () => {
  const truth = seeded([bug('b', T, [10, 12])], [decoy('ctc', T, [60, 62])])
  const s = score(truth, [f(T, 66, 'info'), f(T, 70), f('other.go', 61), f(T, 58, 'critical')], 5)
  assert.deepEqual(s.unmatched.map(u => [u.finding, u.as, u.near]), [
    [0, 'decoy_hit', 'ctc'],
    [1, 'false_positive', undefined],
    [2, 'false_positive', undefined],
    [3, 'decoy_hit', 'ctc'],
  ])
})

test('a finding near both a bug and a decoy matches the bug; a second one is a decoy hit, not a duplicate', () => {
  const truth = seeded([bug('b', T, [10, 12])], [decoy('ctc', T, [15, 16])])
  const s = score(truth, [f(T, 13), f(T, 14)], 5)
  assert.deepEqual(s.pairs, [{ bug: 0, finding: 0 }])
  assert.deepEqual(s.unmatched.map(u => u.as), ['decoy_hit'])
})

test('a second report of a matched bug is a duplicate: not a false positive, not a nit, not in precision', async () => {
  const truth = seeded([bug('b', T, [10, 12])])
  const r = await graded(truth, [f(T, 11), f(T, 12, 'low'), f(T, 14, 'critical')], { max_false_positives: 0, max_nits: 0 })
  assert.equal(r.pass, true, r.rationale ?? '')
  assert.equal(r.metrics?.['duplicates'], 2)
  assert.equal(r.metrics?.['false_positives'], 0)
  assert.equal(r.metrics?.['nits'], 0)
  assert.equal(r.metrics?.['precision'], 1) // 1 / (1 + 0 + 0)
  assert.equal(r.metrics?.['precision_all'], 1 / 3) // duplicates stay in findings
  const capped = await graded(truth, [f(T, 11), f(T, 12)], { max_duplicates: 0 })
  assert.equal(capped.pass, false)
  assert.match(capped.rationale ?? '', /failed: duplicates 1 > max_duplicates 0/)
})

test('hand-computed metrics for a mixed review', async () => {
  // Bugs: a (high), b (high), c (medium). Decoy d. Findings:
  //   0 on a        → match
  //   1 on c        → match
  //   2 near d      → decoy hit
  //   3 far, low    → nit
  //   4 far, medium → false positive
  //   5 on a again  → duplicate
  const truth = seeded(
    [bug('a', T, [10, 11]), bug('b', T, [40, 41]), bug('c', 'cmd/main.go', [5, 5], 'medium')],
    [decoy('d', T, [80, 82])],
  )
  const findings = [f(T, 10), f('cmd/main.go', 7), f(T, 84), f(T, 200, 'low'), f('cmd/main.go', 90, 'medium'), f(T, 12)]
  const r = await graded(truth, findings)
  assert.deepEqual(r.metrics, {
    recall: 2 / 3,
    recall_high: 1 / 2,
    recall_medium: 1,
    precision: 2 / 4, // matched / (matched + false positives + decoy hits)
    precision_all: 2 / 6,
    false_positives: 1,
    decoy_hits: 1,
    duplicates: 1,
    nits: 1,
    findings: 6,
    matched: 2,
    bugs: 3,
  })
  assert.equal(r.pass, true) // no bounds set: none apply
  assert.match(r.rationale ?? '', /matched 2\/3 bugs/)
  assert.match(r.rationale ?? '', /missed: b/)
})

test('each bound fails on its own metric', async () => {
  const truth = seeded([bug('a', T, [10, 10]), bug('b', T, [50, 50])], [decoy('d', T, [80, 80])])
  const findings = [f(T, 10), f(T, 81), f(T, 200), f(T, 300, 'low'), f(T, 11)]
  const cases: [Record<string, number>, RegExp][] = [
    [{ min_recall: 1 }, /recall 0.5 < min_recall 1/],
    [{ max_false_positives: 0 }, /false_positives 1 > max_false_positives 0/],
    [{ max_decoy_hits: 0 }, /decoy_hits 1 > max_decoy_hits 0/],
    [{ max_duplicates: 0 }, /duplicates 1 > max_duplicates 0/],
    [{ max_nits: 0 }, /nits 1 > max_nits 0/],
    [{ max_findings: 4 }, /findings 5 > max_findings 4/],
  ]
  for (const [pass, why] of cases) {
    const r = await graded(truth, findings, pass)
    assert.equal(r.pass, false, JSON.stringify(pass))
    assert.match(r.rationale ?? '', why)
  }
  const loose = await graded(truth, findings, { min_recall: 0.5, max_false_positives: 1, max_decoy_hits: 1, max_duplicates: 1, max_nits: 1, max_findings: 5 })
  assert.equal(loose.pass, true, loose.rationale ?? '')
})

test('severity recall is reported only for severities the truth has', async () => {
  const r = await graded(seeded([bug('a', T, [10, 10], 'critical'), bug('b', T, [50, 50], 'low')]), [f(T, 50, 'low')])
  assert.equal(r.metrics?.['recall_critical'], 0)
  assert.equal(r.metrics?.['recall_low'], 1)
  assert.equal('recall_high' in (r.metrics ?? {}), false)
  assert.equal('recall_medium' in (r.metrics ?? {}), false)
})

test('a clean case: every finding is a false positive or a decoy hit, whatever its severity', async () => {
  const truth = clean([decoy('d', T, [20, 22])])
  const r = await graded(truth, [f(T, 5, 'info'), f(T, 50, 'low'), f(T, 21, 'info')])
  assert.equal(r.metrics?.['false_positives'], 2)
  assert.equal(r.metrics?.['nits'], 0)
  assert.equal(r.metrics?.['decoy_hits'], 1)
  assert.equal(r.metrics?.['precision'], 0)
  assert.equal(r.metrics?.['recall'], null)
})

test('a clean case with min_recall set does not fail on recall; the bound reads n/a', async () => {
  const r = await graded(clean(), [], { min_recall: 1, max_false_positives: 0 })
  assert.equal(r.pass, true, r.rationale ?? '')
  assert.match(r.rationale ?? '', /min_recall: n\/a \(no bugs\)/)
  const noisy = await graded(clean(), [f(T, 5)], { min_recall: 1, max_false_positives: 0 })
  assert.equal(noisy.pass, false)
  assert.doesNotMatch(noisy.rationale ?? '', /failed: recall/)
})

test('ratios with a zero denominator are null, never 0 and never NaN', async () => {
  const none = await graded(clean(), [])
  assert.equal(none.metrics?.['recall'], null)
  assert.equal(none.metrics?.['precision'], null)
  assert.equal(none.metrics?.['precision_all'], null)
  const missedAll = await graded(seeded([bug('a', T, [10, 10])]), [])
  assert.equal(missedAll.metrics?.['recall'], 0)
  assert.equal(missedAll.metrics?.['precision'], null)
})

test('a null metric never satisfies or fails a bound by comparing as 0', () => {
  // null >= 0.5 is false and null <= 5 is true in JavaScript; neither may decide a bound.
  assert.deepEqual(checkBounds({ min_recall: 0 }, { recall: null }), { failed: [], na: ['min_recall: n/a (no bugs)'] })
  assert.deepEqual(checkBounds({ min_claims_correct: 0.5 }, { claims_correct: null }), { failed: [], na: ['min_claims_correct: n/a (nothing matched)'] })
  assert.deepEqual(checkBounds({ min_recall: 0 }, { recall: 0 }), { failed: [], na: [] })
})

test('canary: a missing findings artifact fails, even on a clean case that would otherwise be perfect', async () => {
  const seededMissing = await graded(seeded([bug('a', T, [10, 10])]), null, { min_recall: 0 })
  assert.equal(seededMissing.pass, false)
  assert.equal(seededMissing.metrics?.['recall'], 0)
  assert.match(seededMissing.rationale ?? '', /findings\.json was not produced/)
  const cleanMissing = await graded(clean(), null, { max_false_positives: 0 })
  assert.equal(cleanMissing.pass, false)
})

test('canary: findings that are not JSON, or not litmus:findings, fail', async () => {
  const prose = await graded(clean(), 'No issues found.', {})
  assert.equal(prose.pass, false)
  assert.match(prose.rationale ?? '', /not JSON/)
  const wrong = await graded(clean(), JSON.stringify({ findings: [{ ...f(T, 1), severity: 'nit' }] }), {})
  assert.equal(wrong.pass, false)
  assert.match(wrong.rationale ?? '', /not valid litmus:findings/)
})

test('canary: an empty findings list does not pass a min_recall', async () => {
  const r = await graded(seeded([bug('a', T, [10, 10])]), [], { min_recall: 1 })
  assert.equal(r.pass, false)
  assert.match(r.rationale ?? '', /failed: recall 0 < min_recall 1/)
})

test('canary: every finding labelled low still hits max_nits on a seeded case, and false positives on a clean one', async () => {
  const spray = Array.from({ length: 8 }, (_, i) => f(T, 100 + 20 * i, 'low'))
  const s = await graded(seeded([bug('a', T, [10, 10])]), [f(T, 10, 'low'), ...spray], { min_recall: 1, max_nits: 5 })
  assert.equal(s.metrics?.['matched'], 1) // a low finding on the bug still finds it
  assert.equal(s.metrics?.['nits'], 8)
  assert.equal(s.pass, false)
  assert.match(s.rationale ?? '', /failed: nits 8 > max_nits 5/)
  const c = await graded(clean(), spray, { max_false_positives: 1 })
  assert.equal(c.metrics?.['false_positives'], 8)
  assert.equal(c.pass, false)
})

test('confirm: each matched pair is put to the judge, and claims_correct is confirmed / matched', async () => {
  const truth = seeded([bug('a', T, [10, 10]), bug('b', T, [50, 50])])
  const judge = stub([verdict(true, 'states the >= boundary'), verdict(false, 'blames the wrong comparison')])
  const r = await graded(truth, [f(T, 10), f(T, 50), f(T, 300)], { min_claims_correct: 1 }, { confirm: 'strict' }, judge)
  assert.equal(judge.calls.length, 2) // matched pairs only, never the false positive
  assert.match(judge.calls[0]?.messages[0]?.content ?? '', /mechanism: a: the mechanism/)
  assert.match(judge.calls[0]?.messages[0]?.content ?? '', /"explanation": "why"/)
  assert.equal(r.metrics?.['confirmed'], 1)
  assert.equal(r.metrics?.['claims_correct'], 0.5)
  assert.equal(r.pass, false)
  assert.match(r.rationale ?? '', /unconfirmed: b: blames the wrong comparison/)
  assert.match(r.rationale ?? '', /failed: claims_correct 0.5 < min_claims_correct 1/)
})

test('canary: a garbage confirm reply counts as unconfirmed', async () => {
  const r = await graded(seeded([bug('a', T, [10, 10])]), [f(T, 10)], { min_claims_correct: 1 }, { confirm: 'strict' }, stub(['Totally right!']))
  assert.equal(r.metrics?.['claims_correct'], 0)
  assert.equal(r.pass, false)
})

test('confirm with nothing matched asks nothing, and min_claims_correct reads n/a', async () => {
  const judge = stub([])
  const r = await graded(seeded([bug('a', T, [10, 10])]), [f(T, 300)], { min_claims_correct: 1 }, { confirm: 'strict' }, judge)
  assert.equal(judge.calls.length, 0)
  assert.equal(r.metrics?.['claims_correct'], null)
  assert.match(r.rationale ?? '', /min_claims_correct: n\/a \(nothing matched\)/)
})

test('a confirm judge that fails propagates its InfraError', async () => {
  await assert.rejects(graded(seeded([bug('a', T, [10, 10])]), [f(T, 10)], {}, { confirm: 'strict' }, stub([new InfraError('503')])), InfraError)
})

test('an unknown confirm judge, or min_claims_correct without confirm, is a config error', async () => {
  await assert.rejects(graded(seeded([bug('a', T, [10, 10])]), null, {}, { confirm: 'nobody' }), ConfigError)
  const unchecked = { kind: 'review-match' as const, artifact: 'findings.json', window: 5, pass: { min_claims_correct: 1 } }
  await assert.rejects(reviewMatch(unchecked, trial(), ctx(oneCase('name: c\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: regex, pattern: x }]\n', { 'truth.yaml': JSON.stringify(clean()) }).c)), ConfigError)
  const parsed = CaseFile.safeParse({ name: 'c', executor: { kind: 'model', prompt: 'x' }, graders: [{ kind: 'review-match', pass: { min_claims_correct: 1 } }] })
  assert.equal(parsed.success, false)
})
