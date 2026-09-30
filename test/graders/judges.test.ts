import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, InfraError } from '../../src/core/errors.ts'
import { askJudge, JUDGE_TIMEOUT_S, judgeHash, judgeTimeoutS, makeJudges, parseVerdict } from '../../src/graders/judges.ts'
import type { Provider } from '../../src/providers/index.ts'
import type { JudgeDef } from '../../src/suite/schema.ts'
import { judgeOf, stub, verdict } from '../helpers/grading.ts'

const def: JudgeDef = { provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low', params: { temperature: 0, top_k: 5 } }

test('a judge hash ignores key order, at every depth', () => {
  const shuffled = { params: { top_k: 5, temperature: 0 }, effort: 'low', model: 'claude-haiku-4-5', provider: 'anthropic' } as JudgeDef
  assert.equal(judgeHash(shuffled), judgeHash(def))
})

test('a judge hash changes with the model, the effort, the params or the region', () => {
  const base = judgeHash(def)
  for (const changed of [{ ...def, model: 'claude-sonnet-5' }, { ...def, effort: 'high' as const }, { ...def, params: { temperature: 1, top_k: 5 } }, { ...def, region: 'us-east-1' }]) {
    assert.notEqual(judgeHash(changed), base)
  }
})

test('judges are made once per name, on first use', () => {
  let made = 0
  const judges = makeJudges({ default: def, unused: { provider: 'bedrock', model: 'm' } }, () => (made++, stub([])))
  assert.equal(made, 0)
  const a = judges('default')
  assert.equal(judges('default'), a)
  assert.equal(made, 1)
  assert.equal(a.hash, judgeHash(def))
})

test('an unknown judge name is a config error, including names every object inherits', () => {
  const judges = makeJudges({ default: def }, () => stub([]))
  assert.throws(() => judges('strict'), ConfigError)
  assert.throws(() => judges('constructor'), ConfigError)
})

test('the pinned model, effort and params go to the provider', async () => {
  const p = stub([verdict(true, 'yes')])
  const j = { ...judgeOf(p), def }
  assert.deepEqual(await askJudge(j, 'Question: ok?', new AbortController().signal), { pass: true, rationale: 'yes', usage: { input_tokens: 1, output_tokens: 1 } })
  assert.equal(p.calls[0]?.model, 'claude-haiku-4-5')
  assert.equal(p.calls[0]?.effort, 'low')
  assert.deepEqual(p.calls[0]?.params, { temperature: 0, top_k: 5 })
})

test('a verdict is the last json fence, or the whole reply', () => {
  assert.deepEqual(parseVerdict('{"pass": true, "rationale": "r"}'), { pass: true, rationale: 'r' })
  assert.equal(parseVerdict(`${verdict(true)}\nOn reflection:\n${verdict(false, 'no')}`).pass, false)
})

test('canary: a garbage, half-formed or string-typed verdict is a no', () => {
  for (const reply of ['Yes, definitely passes.', '{"pass": "true", "rationale": "r"}', '{"pass": true}', '```json\n{"pass": tru\n```', '', '[true]']) {
    const v = parseVerdict(reply)
    assert.equal(v.pass, false, reply)
    assert.match(v.rationale, /judge reply unparseable/)
  }
})

test('a provider failure propagates as the InfraError it is', async () => {
  const j = judgeOf(stub([new InfraError('529 overloaded')]))
  await assert.rejects(askJudge(j, 'Q', new AbortController().signal), InfraError)
})

test('a judge whose provider never settles times out as a retryable infra error, and a cancel is not a timeout', { timeout: 10_000 }, async () => {
  const stuck: Provider = { id: 'fake', complete: () => new Promise(() => {}) }
  const j = judgeOf(stuck)
  const t0 = Date.now()
  mock.timers.enable({ apis: ['setTimeout'] })
  const pending = askJudge(j, 'q', new AbortController().signal)
  mock.timers.tick(JUDGE_TIMEOUT_S * 1000)
  await assert.rejects(pending, (e: Error) => e instanceof InfraError && e.retryable && /no answer within 300s/.test(e.message))
  mock.timers.reset()
  const ctl = new AbortController()
  const cancelled = askJudge(j, 'q', ctl.signal)
  ctl.abort(new Error('cancelled'))
  await assert.rejects(cancelled, (e: Error) => !(e instanceof InfraError))
  assert.ok(Date.now() - t0 < 2000)
})

test('a judge reports what its call spent', async () => {
  const v = await askJudge(judgeOf(stub([verdict(true)])), 'q', new AbortController().signal)
  assert.deepEqual(v.usage, { input_tokens: 1, output_tokens: 1 })
})

test('the judge deadline grows with what the call may write, never below the floor', () => {
  assert.equal(judgeTimeoutS(4096), JUDGE_TIMEOUT_S)
  assert.equal(judgeTimeoutS(16000), 800)
})
