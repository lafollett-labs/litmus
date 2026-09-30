import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reviewMatch } from '../../src/graders/review-match.ts'
import type { TruthFile } from '../../src/suite/schema.ts'
import { findingsOf } from '../../ui/src/findings.ts'
import { oneCase } from '../helpers/cases.ts'
import { ctx, spec, trial } from '../helpers/grading.ts'

// The Findings panel renders review-match's details. This runs the real
// grader, so what the panel shows is what the grader decided, count for count.
test('the Findings panel shows every outcome of a real review-match grade, past the rationale\'s cap of 20', async () => {
  const bug = (id: string, lines: [number, number]) => ({ id, file: 'a.go', lines, severity: 'high' as const, category: 'correctness', summary: `${id} breaks`, proof: 'go test', fix: `fix/${id}.patch` })
  const truth: TruthFile = { kind: 'seeded', bugs: [bug('found', [10, 12]), bug('missed', [40, 41])], decoys: [{ id: 'bait', file: 'a.go', lines: [70, 70], summary: 'deliberate' }] }
  const { c } = oneCase('name: c\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: review-match, pass: { min_recall: 0.001, max_findings: 100 } }]\n', { 'truth.yaml': JSON.stringify(truth), 'fix/found.patch': '', 'fix/missed.patch': '' })
  const f = (line: number, severity: 'high' | 'low' = 'high', title = `at ${line}`) => ({ file: 'a.go', line, severity, title, explanation: 'why' })
  const noise = Array.from({ length: 30 }, (_, i) => f(200 + i * 10))
  const findings = [f(11), f(70), f(300, 'low'), f(12, 'high', 'again'), ...noise]
  const g = await reviewMatch(spec({ kind: 'review-match', pass: { min_recall: 0.001, max_findings: 100 } }), trial({ artifacts: { 'findings.json': JSON.stringify({ findings }) } }), ctx(c))
  const v = findingsOf(g)!
  assert.deepEqual(v.matched, [{ bug: 'found', file: 'a.go', line: 11, title: 'at 11' }])
  assert.deepEqual(v.missed, ['missed'])
  assert.deepEqual(v.decoyHits.map(d => [d.line, d.near]), [[70, 'bait']])
  assert.deepEqual(v.duplicates.map(d => [d.line, d.near]), [[12, 'found']])
  assert.deepEqual(v.nits.map(n => n.line), [300])
  // Every outcome is shown, not only the 20 the rationale lists, and each count agrees with the metrics.
  assert.equal(v.falsePositives.length, 30)
  assert.equal(v.falsePositives.length, g.metrics!['false_positives'])
  assert.equal(v.decoyHits.length, g.metrics!['decoy_hits'])
  assert.equal(v.nits.length, g.metrics!['nits'])
  assert.equal(v.duplicates.length, g.metrics!['duplicates'])
  assert.equal(findingsOf({ grader: 'regex', pass: true }), undefined)
})
