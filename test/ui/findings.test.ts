import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reviewMatch } from '../../src/graders/review-match.ts'
import type { TruthFile } from '../../src/suite/schema.ts'
import { findingsOf } from '../../ui/src/findings.ts'
import { oneCase } from '../helpers/cases.ts'
import { ctx, spec, trial } from '../helpers/grading.ts'

// The Findings panel reads review-match's rationale back. This runs the real
// grader, so a change to its line format breaks here, not in the browser.
test('the Findings panel reads every outcome out of a real review-match grade', async () => {
  const bug = (id: string, lines: [number, number]) => ({ id, file: 'a.go', lines, severity: 'high' as const, category: 'correctness', summary: `${id} breaks`, proof: 'go test', fix: `fix/${id}.patch` })
  const truth: TruthFile = { kind: 'seeded', bugs: [bug('found', [10, 12]), bug('missed', [40, 41])], decoys: [{ id: 'bait', file: 'a.go', lines: [70, 70], summary: 'deliberate' }] }
  const { c } = oneCase('name: c\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: review-match, pass: { min_recall: 0.001, max_findings: 100 } }]\n', { 'truth.yaml': JSON.stringify(truth), 'fix/found.patch': '', 'fix/missed.patch': '' })
  const f = (line: number, severity: 'high' | 'low' = 'high') => ({ file: 'a.go', line, severity, title: `at ${line}`, explanation: 'why' })
  const findings = [f(11), f(200), f(70), f(300, 'low')]
  const g = await reviewMatch(spec({ kind: 'review-match', pass: { min_recall: 0.001, max_findings: 100 } }), trial({ artifacts: { 'findings.json': JSON.stringify({ findings }) } }), ctx(c))
  const v = findingsOf(g)!
  assert.deepEqual(v.matched, [{ bug: 'found', at: 'a.go:11 "at 11"' }])
  assert.deepEqual(v.missed, ['missed'])
  assert.equal(v.decoyHits.length, 1)
  assert.equal(v.falsePositives.length + v.nits.length, 2, g.rationale ?? '')
  assert.equal(v.metrics['matched'], 1)
  assert.equal(findingsOf({ grader: 'regex', pass: true }), undefined)
})
