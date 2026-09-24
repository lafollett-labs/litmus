import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { join } from 'node:path'
import { ConfigError, InfraError } from '../../src/core/errors.ts'
import { fakeProvider } from '../../src/providers/fake.ts'
import { tree } from '../helpers/tmp.ts'

const root = tree({
  'fake.yaml': `responses:
  - text: first
    usage: { input_tokens: 10, output_tokens: 2 }
    cost_usd: 0.5
  - text_file: second.txt
  - infra_errors: 2
    text: third after two failures
  - fatal: key revoked
  - delay_ms: 5000
    text: slow
`,
  'second.txt': 'from a file',
  'bad.yaml': 'responses: []\n',
  'missing.yaml': 'responses:\n  - text_file: nowhere.txt\n',
  'quick.yaml': 'responses:\n  - delay_ms: 5\n    text: quick\n',
  'both.yaml': 'responses:\n  - text: a\n    text_file: second.txt\n',
  'broken.yaml': 'responses: [\n',
})
const fake = fakeProvider()
const ask = (trial: number, attempt = 1, file = join(root, 'fake.yaml'), signal = new AbortController().signal) =>
  fake.complete({ model: 'fake', messages: [], max_tokens: 1, signal, trace: { case_id: 's/c', trial, attempt, fake_file: file } })

test('trial n answers with entry n, cycling, with its scripted usage and cost', async () => {
  const r = await ask(1)
  assert.equal(r.text, 'first')
  assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 2, cost_usd: 0.5 })
  assert.equal((await ask(6)).text, 'first')
})

test('text_file is read relative to fake.yaml', async () => {
  assert.equal((await ask(2)).text, 'from a file')
})

test('infra_errors fails the first N attempts with a retryable error, then answers', async () => {
  await assert.rejects(ask(3, 1), (e: unknown) => e instanceof InfraError && e.retryable)
  await assert.rejects(ask(3, 2), InfraError)
  assert.equal((await ask(3, 3)).text, 'third after two failures')
})

test('fatal fails every attempt without retry', async () => {
  for (const attempt of [1, 2, 3]) {
    await assert.rejects(ask(4, attempt), (e: unknown) => e instanceof InfraError && !e.retryable && /key revoked/.test(e.message))
  }
})

test('a delay honours the abort signal instead of sleeping it out', async () => {
  const ctl = new AbortController()
  const pending = ask(5, 1, join(root, 'fake.yaml'), ctl.signal)
  ctl.abort(new Error('cancelled'))
  const started = Date.now()
  await assert.rejects(pending, /cancelled/)
  assert.ok(Date.now() - started < 1000)
})

test('an already-cancelled request rejects at once, with or without a delay', async () => {
  const ctl = new AbortController()
  ctl.abort(new Error('cancelled first'))
  const started = Date.now()
  await assert.rejects(ask(5, 1, join(root, 'fake.yaml'), ctl.signal), /cancelled first/)
  await assert.rejects(ask(1, 1, join(root, 'fake.yaml'), ctl.signal), /cancelled first/)
  assert.ok(Date.now() - started < 1000)
})

test('a delay that runs out answers, and leaves no listener on the signal', async () => {
  const ctl = new AbortController()
  const r = await ask(1, 1, join(root, 'quick.yaml'), ctl.signal)
  assert.equal(r.text, 'quick')
  assert.equal(getEventListeners(ctl.signal, 'abort').length, 0)
})

test('a missing or unparseable fake.yaml, or an entry with both text and text_file, is a config error', async () => {
  for (const f of ['nowhere.yaml', 'broken.yaml', 'both.yaml']) await assert.rejects(ask(1, 1, join(root, f)), ConfigError, f)
})

test('a missing text_file is a config error, not a crash', async () => {
  await assert.rejects(ask(1, 1, join(root, 'missing.yaml')), (e: unknown) => e instanceof ConfigError && /text_file .*nowhere\.txt/.test(e.message))
})

test('no fake.yaml is a non-retryable infra error, and a bad script is a config error', async () => {
  await assert.rejects(fake.complete({ model: 'fake', messages: [], max_tokens: 1, signal: new AbortController().signal }), (e: unknown) => e instanceof InfraError && !e.retryable)
  await assert.rejects(ask(1, 1, join(root, 'bad.yaml')), ConfigError)
})
