import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { InfraError } from '../../src/core/errors.ts'
import type { RunEvent } from '../../src/core/types.ts'
import { runModel } from '../../src/executors/model.ts'
import type { ExecJob } from '../../src/executors/types.ts'
import { redactor, secretValues } from '../../src/core/redact.ts'
import type { Provider } from '../../src/providers/index.ts'
import { fakeProvider } from '../../src/providers/fake.ts'
import { buildWorkdir } from '../../src/sandbox/workdir.ts'
import { oneCase } from '../helpers/cases.ts'
import { tree } from '../helpers/tmp.ts'

function job(yaml: string, files: Record<string, string>, signal = new AbortController().signal): { j: ExecJob; events: RunEvent[] } {
  const { c, base } = oneCase(yaml, files)
  const events: RunEvent[] = []
  const out = tree({ '.keep': '' })
  const j: ExecJob = {
    key: 's/c@fake#1',
    case: c,
    configName: 'fake',
    config: { provider: 'fake', model: 'fake' },
    trial: 1,
    attempt: 1,
    workdir: buildWorkdir(c, { run: '2026-09-24T12-00-00Z-a1b2', key: 's/c@fake#1', attempt: 1 }, base),
    suiteRoots: [],
    out: { artifacts: join(out, 'artifacts'), transcript: join(out, 'transcript.jsonl') },
    pricing: {},
    emit: e => events.push(e),
    redact: redactor(secretValues([])),
    signal,
  }
  return { j, events }
}

const REVIEW = 'name: c\nsubject: skill.md\nexecutor: { kind: model, prompt: "Review {{fixture}}" }\ngraders: [{ kind: regex, pattern: x }]\ntimeout_s: 5\n'

test('the response, its findings, the transcript and usage all come back from one call', async () => {
  const { j, events } = job(REVIEW, {
    'skill.md': 'You are a reviewer.',
    'fixture/a.go': 'package a\n',
    'fake.yaml': 'responses:\n  - text: "done\\n```json\\n{\\"findings\\": []}\\n```"\n    usage: { input_tokens: 7, output_tokens: 3 }\n',
  })
  const r = await runModel(j, fakeProvider())
  assert.equal(r.exit, 'ok')
  assert.deepEqual(JSON.parse(readFileSync(r.artifacts['findings.json']!, 'utf8')), { findings: [] })
  assert.match(readFileSync(r.artifacts['response.txt']!, 'utf8'), /^done/)
  assert.deepEqual(r.usage, { input_tokens: 7, output_tokens: 3 })
  const lines = readFileSync(r.transcript, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(lines.map(l => l.kind === 'message' ? l.role : l.kind), ['system', 'user', 'assistant', 'usage'])
  assert.match(lines[1].text, /=== a\.go ===/)
  assert.ok(events.some(e => e.type === 'trial.usage'))
})

test('a key in the answer is redacted in the response, the findings, the transcript and the live steps', async () => {
  const { j, events } = job(REVIEW, {
    'skill.md': 's',
    'fake.yaml': 'responses:\n  - text: "sk-or-leak\\n```json\\n{\\"findings\\": [{\\"sk-or-leak\\": \\"sk-or-leak\\"}]}\\n```"\n',
  })
  j.redact = redactor(['sk-or-leak'])
  const r = await runModel(j, fakeProvider())
  assert.equal(r.exit, 'ok')
  assert.match(readFileSync(r.artifacts['response.txt']!, 'utf8'), /^\[REDACTED\]/)
  assert.deepEqual(JSON.parse(readFileSync(r.artifacts['findings.json']!, 'utf8')), { findings: [{ '[REDACTED]': '[REDACTED]' }] })
  const everything = [readFileSync(r.transcript, 'utf8'), JSON.stringify(events), ...Object.values(r.artifacts).map(f => readFileSync(f, 'utf8'))].join('\n')
  assert.ok(!everything.includes('sk-or-leak'))
})

test('an answer with no JSON is still ok; the graders decide what it is worth', async () => {
  const { j } = job(REVIEW, { 'skill.md': 's', 'fake.yaml': 'responses: [{ text: "I refuse." }]\n' })
  const r = await runModel(j, fakeProvider())
  assert.equal(r.exit, 'ok')
  assert.equal(r.artifacts['findings.json'], undefined)
})

test('an infra error carries its retryability, and a timeout of the one call is a retryable infra error', async () => {
  const { j } = job(REVIEW, { 'skill.md': 's', 'fake.yaml': 'responses: [{ fatal: revoked }]\n' })
  const fatal = await runModel(j, fakeProvider())
  assert.equal(fatal.exit, 'infra_error')
  assert.equal(fatal.retryable, false)

  const slow = job(REVIEW.replace('timeout_s: 5', 'timeout_s: 1'), { 'skill.md': 's', 'fake.yaml': 'responses: [{ delay_ms: 5000, text: late }]\n' })
  const t = await runModel(slow.j, fakeProvider())
  assert.deepEqual([t.exit, t.retryable], ['infra_error', true])
  assert.match(t.reason ?? '', /timeout/)
})

test('a cancel is reported as cancelled, never as a timeout', async () => {
  const ctl = new AbortController()
  const { j } = job(REVIEW, { 'skill.md': 's', 'fake.yaml': 'responses: [{ delay_ms: 5000, text: late }]\n' }, ctl.signal)
  const pending = runModel(j, fakeProvider())
  setTimeout(() => ctl.abort(), 20)
  assert.equal((await pending).exit, 'cancelled')
})

test('an answer that arrives after the clock stopped is never accepted', async () => {
  // A provider that ignores its signal and answers anyway.
  const deaf: Provider = { id: 'fake', complete: async () => (await new Promise(ok => setTimeout(ok, 1200)), { text: 'late', stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 }, raw: {} }) }
  const slow = job(REVIEW.replace('timeout_s: 5', 'timeout_s: 1'), { 'skill.md': 's' })
  const t = await runModel(slow.j, deaf)
  assert.deepEqual([t.exit, t.retryable], ['infra_error', true])
  assert.equal(t.artifacts['response.txt'], undefined)
  const ctl = new AbortController()
  const pending = runModel(job(REVIEW, { 'skill.md': 's' }, ctl.signal).j, deaf)
  setTimeout(() => ctl.abort(), 20)
  assert.equal((await pending).exit, 'cancelled')
})

test('an error that is not an infra error is a bug, and propagates', async () => {
  const { j } = job(REVIEW, { 'skill.md': 's' })
  const broken: Provider = { id: 'fake', complete: async () => { throw new TypeError('oops') } }
  await assert.rejects(runModel(j, broken), TypeError)
  const infra: Provider = { id: 'fake', complete: async () => { throw new InfraError('429') } }
  assert.equal((await runModel(j, infra)).retryable, true)
})
