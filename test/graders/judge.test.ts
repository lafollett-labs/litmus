import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, InfraError } from '../../src/core/errors.ts'
import type { TranscriptEntry } from '../../src/core/types.ts'
import { judge } from '../../src/graders/judge.ts'
import { ctx, judgeOf, spec, stub, trial, verdict } from '../helpers/grading.ts'

const ask = (target = 'final_message.txt') => spec({ kind: 'judge', judge: 'default', question: 'Does the review mention the expiry bug?', target })

test('the judge sees the question and the target, and its yes is a pass', async () => {
  const p = stub([verdict(true, 'it names the >= comparison')])
  const r = await judge(ask(), trial({ artifacts: { 'final_message.txt': 'The expiry check uses >=.' } }), ctx(undefined, { default: judgeOf(p) }))
  assert.deepEqual(r, { grader: 'judge', pass: true, rationale: 'it names the >= comparison', usage: { input_tokens: 1, output_tokens: 1 } })
  const sent = p.calls[0]?.messages[0]?.content ?? ''
  assert.match(sent, /Question: Does the review mention the expiry bug\?/)
  assert.match(sent, /<material source="final_message.txt">\nThe expiry check uses >=\.\n<\/material>/)
  assert.match(p.calls[0]?.system ?? '', /yes-or-no/)
})

test('a no is a fail, with the judge rationale', async () => {
  const r = await judge(ask(), trial({ artifacts: { 'final_message.txt': 'LGTM' } }), ctx(undefined, { default: judgeOf(stub([verdict(false, 'no mention')])) }))
  assert.equal(r.pass, false)
  assert.equal(r.rationale, 'no mention')
})

test('the transcript target renders the whole session for the judge', async () => {
  const p = stub([verdict(true)])
  const entries: TranscriptEntry[] = [
    { t: 0, kind: 'message', role: 'user', text: 'review it' },
    { t: 1, kind: 'tool_call', id: '1', tool: 'Bash', input: { command: 'rm -rf /' } },
    { t: 2, kind: 'denied', tool: 'Bash', reason: 'allow_shell is false' },
  ]
  await judge(ask('transcript'), trial({ transcript: entries }), ctx(undefined, { default: judgeOf(p) }))
  const sent = p.calls[0]?.messages[0]?.content ?? ''
  assert.match(sent, /\[user\]\nreview it/)
  assert.match(sent, /\[tool_call Bash\] \{"command":"rm -rf \/"\}/)
  assert.match(sent, /\[denied Bash\] allow_shell is false/)
})

test('canary: a garbage judge reply does not pass', async () => {
  const r = await judge(ask(), trial({ artifacts: { 'final_message.txt': 'x' } }), ctx(undefined, { default: judgeOf(stub(['PASS!!! 10/10'])) }))
  assert.equal(r.pass, false)
  assert.match(r.rationale ?? '', /unparseable/)
})

test('canary: a missing target fails without asking the judge', async () => {
  const p = stub([verdict(true)])
  const r = await judge(ask(), trial(), ctx(undefined, { default: judgeOf(p) }))
  assert.equal(r.pass, false)
  assert.equal(p.calls.length, 0)
})

test('an unknown judge is a config error, and a provider failure propagates', async () => {
  await assert.rejects(judge(ask(), trial(), ctx()), ConfigError)
  const failing = ctx(undefined, { default: judgeOf(stub([new InfraError('429')])) })
  await assert.rejects(judge(ask(), trial({ artifacts: { 'final_message.txt': 'x' } }), failing), InfraError)
})
