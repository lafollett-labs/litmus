import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InfraError } from '../../src/core/errors.ts'
import { openrouterProvider } from '../../src/providers/openrouter.ts'

const signal = new AbortController().signal
const req = { model: 'anthropic/claude-sonnet-5', system: 'sys', messages: [{ role: 'user' as const, content: 'hi' }], max_tokens: 50, signal }

function fakeFetch(status: number, body: unknown): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = []
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fetch: f, calls }
}

test('the request carries the key, the system message first, reasoning effort, and asks for cost', async () => {
  const { fetch, calls } = fakeFetch(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
  await openrouterProvider({ fetch, apiKey: 'sk-or-test' }).complete({ ...req, effort: 'high' })
  const init = calls[0]!.init
  assert.equal((init.headers as Record<string, string>)['authorization'], 'Bearer sk-or-test')
  const body = JSON.parse(String(init.body))
  assert.deepEqual(body.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }])
  assert.deepEqual(body.reasoning, { effort: 'high' })
  assert.deepEqual(body.usage, { include: true })
})

test('text, finish reason, tokens and the reported cost map onto the response', async () => {
  const { fetch } = fakeFetch(200, {
    choices: [{ message: { content: 'answer' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 12, completion_tokens: 7, cost: 0.0031 },
  })
  const r = await openrouterProvider({ fetch, apiKey: 'k' }).complete(req)
  assert.equal(r.text, 'answer')
  assert.equal(r.stop_reason, 'length')
  assert.deepEqual(r.usage, { input_tokens: 12, output_tokens: 7, cost_usd: 0.0031 })
})

test('a missing key fails fast without a request', async () => {
  const { fetch, calls } = fakeFetch(200, {})
  await assert.rejects(openrouterProvider({ fetch, apiKey: '' }).complete(req), (e: unknown) => e instanceof InfraError && !e.retryable)
  assert.equal(calls.length, 0)
})

test('429 and 5xx retry, 400 and 401 do not, and an error inside a 200 retries', async () => {
  const cases: [number, unknown, boolean][] = [
    [429, 'slow down', true],
    [502, 'bad gateway', true],
    [400, 'bad', false],
    [401, 'no', false],
    [200, { error: { code: 502, message: 'upstream died' } }, true],
  ]
  for (const [status, body, retryable] of cases) {
    const { fetch } = fakeFetch(status, body)
    await assert.rejects(
      openrouterProvider({ fetch, apiKey: 'k' }).complete(req),
      (e: unknown) => e instanceof InfraError && e.retryable === retryable,
      `${status}`,
    )
  }
})

test('a network failure retries, but an aborted request rethrows the abort', async () => {
  const down = (async () => {
    throw new TypeError('fetch failed')
  }) as unknown as typeof fetch
  await assert.rejects(openrouterProvider({ fetch: down, apiKey: 'k' }).complete(req), (e: unknown) => e instanceof InfraError && e.retryable)

  const ctl = new AbortController()
  ctl.abort(new Error('cancelled'))
  const aborted = (async () => {
    throw ctl.signal.reason
  }) as unknown as typeof fetch
  await assert.rejects(openrouterProvider({ fetch: aborted, apiKey: 'k' }).complete({ ...req, signal: ctl.signal }), /cancelled/)
})

test('an unparseable 200 is a retryable infra error, not an empty answer', async () => {
  const { fetch } = fakeFetch(200, '<html>oops</html>')
  await assert.rejects(openrouterProvider({ fetch, apiKey: 'k' }).complete(req), (e: unknown) => e instanceof InfraError && e.retryable)
})
