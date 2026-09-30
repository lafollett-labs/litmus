import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { InfraError } from '../../src/core/errors.ts'
import { redactor } from '../../src/core/redact.ts'
import { gradeAll, makeJudges, runExtract } from '../../src/graders/index.ts'
import { oneCase } from '../helpers/cases.ts'
import { ctx, judgeOf, stub, trial, verdict } from '../helpers/grading.ts'

const truth = JSON.stringify({ kind: 'seeded', bugs: [{ id: 'b', file: 'a.go', lines: [3, 3], severity: 'high', category: 'c', summary: 's', proof: 'p', fix: 'fix/b.patch' }] })

const EVERY = `name: c
executor: { kind: model, prompt: hi }
graders:
  - { kind: regex, target: response.txt, pattern: never-said }
  - { kind: json-schema, artifact: findings.json, schema: "litmus:findings" }
  - { kind: file-exists, path: out.txt }
  - { kind: tool-used, tool: Read, min: 0 }
  - { kind: command, run: "test -f out.txt" }
  - { kind: review-match, pass: { min_recall: 1 } }
  - { kind: judge, judge: default, question: "Is it right?", target: response.txt }
`

test('every grader runs, in case order, even after an earlier one fails', async () => {
  const { c } = oneCase(EVERY, { 'truth.yaml': truth, 'fix/b.patch': '' })
  const t = trial({
    artifacts: { 'response.txt': 'a.go:3 is wrong', 'findings.json': JSON.stringify({ findings: [{ file: 'a.go', line: 3, severity: 'high', title: 't', explanation: 'e' }] }) },
    workdir: { 'out.txt': 'ok' },
  })
  const results = await gradeAll(t, ctx(c, { default: judgeOf(stub([verdict(true)])) }))
  assert.deepEqual(
    results.map(r => [r.grader, r.pass]),
    [['regex', false], ['json-schema', true], ['file-exists', true], ['tool-used', true], ['command', true], ['review-match', true], ['judge', true]],
  )
})

test('an InfraError from a judge propagates out of gradeAll, and no later grader runs', async () => {
  const yaml = `name: c
executor: { kind: model, prompt: hi }
graders:
  - { kind: judge, judge: default, question: "Is it right?", target: response.txt }
  - { kind: command, run: "touch graded-after" }
`
  const { c } = oneCase(yaml)
  const t = trial({ artifacts: { 'response.txt': 'x' } })
  await assert.rejects(gradeAll(t, ctx(c, { default: judgeOf(stub([new InfraError('529 overloaded')])) })), InfraError)
  assert.equal(existsSync(join(t.workdir, 'graded-after')), false)
})

test('the index wires the extractor and judges the runner uses', async () => {
  const judges = makeJudges({ default: { provider: 'fake', model: 'm' } }, () => stub(['```json\n{"findings": []}\n```']))
  const { c } = oneCase(`name: c\nexecutor: { kind: model, prompt: hi }\nextract: { with: default }\ngraders: [{ kind: review-match, pass: { max_findings: 100000 } }]\n`, { 'truth.yaml': JSON.stringify({ kind: 'clean' }) })
  const r = await runExtract(trial({ artifacts: { 'final_message.txt': 'LGTM' } }), { case: c, judge: judges, signal: new AbortController().signal, redact: redactor([]) })
  assert.ok(r.trial.artifacts['findings.json'])
  assert.match(r.extractor_hash ?? '', /^[0-9a-f]{64}$/)
})

test('every rationale is redacted where it is produced', async () => {
  const { c } = oneCase('name: c\nexecutor: { kind: model, prompt: hi }\ngraders:\n  - { kind: command, run: "echo sk-ant-live; exit 1" }\n  - { kind: regex, target: response.txt, pattern: nope }\n')
  const rs = await gradeAll(trial({ artifacts: { 'response.txt': 'x' } }), { ...ctx(c), redact: redactor(['sk-ant-live']) })
  assert.match(rs[0]!.rationale ?? '', /\[REDACTED\]/)
  assert.ok(!JSON.stringify(rs).includes('sk-ant-live'))
})

test('a rationale a judge wrote is redacted by gradeAll itself', async () => {
  const { c } = oneCase('name: c\nexecutor: { kind: model, prompt: hi }\ngraders:\n  - { kind: judge, judge: default, question: q, target: response.txt }\n')
  const judges = { default: judgeOf(stub([verdict(true, 'the key sk-ant-judged is in it')])) }
  const rs = await gradeAll(trial({ artifacts: { 'response.txt': 'x' } }), { ...ctx(c, judges), redact: redactor(['sk-ant-judged']) })
  assert.equal(rs[0]!.rationale, 'the key [REDACTED] is in it')
})

test('a cancel rejects gradeAll, never a result set that reads like a failed trial', async () => {
  const { c } = oneCase('name: c\nexecutor: { kind: model, prompt: hi }\ngraders:\n  - { kind: command, run: "sleep 5" }\n  - { kind: command, run: "touch graded-after" }\n')
  const t = trial()
  const ctl = new AbortController()
  const pending = gradeAll(t, { ...ctx(c), signal: ctl.signal })
  setTimeout(() => ctl.abort(new Error('cancelled')), 50)
  await assert.rejects(pending, /cancelled/)
  assert.equal(existsSync(join(t.workdir, 'graded-after')), false)
  const pre = new AbortController()
  pre.abort(new Error('cancelled'))
  await assert.rejects(gradeAll(t, { ...ctx(c), signal: pre.signal }), /cancelled/)
})

test('a cancel that lands inside a judge call rejects with the signal\'s own reason', async () => {
  const { c } = oneCase('name: c\nexecutor: { kind: model, prompt: hi }\ngraders:\n  - { kind: judge, judge: default, question: q, target: response.txt }\n')
  const stuck = judgeOf({ id: 'fake', complete: () => new Promise(() => {}) })
  const ctl = new AbortController()
  const reason = new Error('operator cancel')
  const pending = gradeAll(trial({ artifacts: { 'response.txt': 'x' } }), { ...ctx(c, { default: stuck }), signal: ctl.signal })
  setTimeout(() => ctl.abort(reason), 50)
  await assert.rejects(pending, (e: unknown) => e === reason)
})
