import { test } from 'node:test'
import assert from 'node:assert/strict'
import Anthropic, { AnthropicError, APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import { InfraError } from '../../src/core/errors.ts'
import { classify, messagesProvider, type Send } from '../../src/providers/messages.ts'

const message = (over: Partial<Anthropic.Message> = {}): Anthropic.Message =>
  ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [
      { type: 'text', text: 'hello ', citations: null },
      { type: 'thinking', thinking: '', signature: 's' },
      { type: 'text', text: 'world', citations: null },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 3, cache_read_input_tokens: 2 },
    ...over,
  }) as unknown as Anthropic.Message

const signal = new AbortController().signal
const generate = (status: number, type: string) =>
  APIError.generate(status, { type: 'error', error: { type, message: type } }, type, new Headers())

function capture(reply: Anthropic.Message = message()): { send: Send; bodies: Anthropic.MessageCreateParamsNonStreaming[] } {
  const bodies: Anthropic.MessageCreateParamsNonStreaming[] = []
  return { bodies, send: async body => (bodies.push(body), reply) }
}

test('effort goes into output_config, merged with any output_config the params carry', async () => {
  const { send, bodies } = capture()
  await messagesProvider('anthropic', send).complete({
    model: 'claude-opus-5-5',
    system: 'be terse',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 100,
    effort: 'medium',
    params: { output_config: { format: { type: 'json_schema', schema: {} } }, metadata: { user_id: 'litmus' } },
    signal,
  })
  const body = bodies[0] as unknown as Record<string, unknown>
  assert.deepEqual(body['output_config'], { format: { type: 'json_schema', schema: {} }, effort: 'medium' })
  assert.equal(body['system'], 'be terse')
  assert.deepEqual(body['metadata'], { user_id: 'litmus' })
})

test('without effort or system, neither key is sent, and params cannot override the model or messages', async () => {
  const { send, bodies } = capture()
  await messagesProvider('bedrock', send).complete({
    model: 'anthropic.claude-opus-5-5',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 100,
    params: { model: 'something-else', messages: [] },
    signal,
  })
  const body = bodies[0] as unknown as Record<string, unknown>
  assert.equal('output_config' in body, false)
  assert.equal('system' in body, false)
  assert.equal(body['model'], 'anthropic.claude-opus-5-5')
  assert.deepEqual(body['messages'], [{ role: 'user', content: 'hi' }])
})

test('text blocks concatenate, thinking is dropped, and cached input counts toward input tokens', async () => {
  const { send } = capture()
  const r = await messagesProvider('anthropic', send).complete({ model: 'm', messages: [], max_tokens: 1, signal })
  assert.equal(r.text, 'hello world')
  assert.deepEqual(r.usage, { input_tokens: 15, output_tokens: 5 })
  assert.equal(r.stop_reason, 'end_turn')
})

test('a refusal is returned as output for the graders, not thrown', async () => {
  const { send } = capture(message({ stop_reason: 'refusal', content: [] }))
  const r = await messagesProvider('anthropic', send).complete({ model: 'm', messages: [], max_tokens: 1, signal })
  assert.equal(r.stop_reason, 'refusal')
  assert.equal(r.text, '')
})

test('throttling, overload, 5xx, timeouts and connection failures are retryable infra errors', () => {
  for (const e of [generate(429, 'rate_limit_error'), generate(529, 'overloaded_error'), generate(500, 'api_error'), generate(408, 'timeout'), new APIConnectionError({ message: 'reset' })]) {
    const c = classify(e)
    assert.ok(c instanceof InfraError, String(e))
    assert.equal(c.retryable, true, String(e))
  }
})

test('auth, permission, bad requests, unknown models and missing credentials fail fast without retrying', () => {
  for (const e of [generate(401, 'authentication_error'), generate(403, 'permission_error'), generate(400, 'invalid_request_error'), generate(404, 'not_found_error')]) {
    const c = classify(e)
    assert.ok(c instanceof InfraError, String(e))
    assert.equal(c.retryable, false, String(e))
  }
  // Mantle wraps an empty AWS credential chain as a connection error; no retry finds credentials.
  const aws = Object.assign(new Error('Could not load credentials from any providers'), { name: 'CredentialsProviderError' })
  for (const e of [aws, new APIConnectionError({ message: 'Failed to resolve AWS credentials', cause: aws })]) {
    const c = classify(e) as InfraError
    assert.equal(c.retryable, false)
    assert.match(c.message, /no usable credentials/)
  }
})

test('any other SDK error is the stream failing in flight, and is retried', () => {
  const c = classify(new AnthropicError('stream ended without producing a Message with role=assistant')) as InfraError
  assert.ok(c instanceof InfraError && c.retryable)
  assert.match(c.message, /^stream failed:/)
})

test('an API error names its request id, and a billing error mid-stream is not retried', () => {
  const withId = new APIError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, undefined, new Headers({ 'request-id': 'req_123' }), 'rate_limit_error')
  assert.match((classify(withId) as InfraError).message, /\(request req_123\)/)
  type ErrorType = ConstructorParameters<typeof APIError>[4]
  const billing = new APIError(undefined, { type: 'error', error: { type: 'billing_error', message: 'no credit' } }, undefined, new Headers(), 'billing_error' as ErrorType)
  assert.equal((classify(billing) as InfraError).retryable, false)
})

test('an error event mid-stream has no status: an overload retries, a request the server rejected does not', () => {
  type ErrorType = ConstructorParameters<typeof APIError>[4]
  const midStream = (type: string) => new APIError(undefined, { type: 'error', error: { type, message: type } }, undefined, new Headers(), type as ErrorType)
  for (const type of ['overloaded_error', 'api_error', 'rate_limit_error']) {
    const c = classify(midStream(type))
    assert.ok(c instanceof InfraError && c.retryable, type)
    assert.match((c as InfraError).message, new RegExp(`stream error ${type}`))
  }
  for (const type of ['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'request_too_large']) {
    const c = classify(midStream(type))
    assert.ok(c instanceof InfraError && !c.retryable, type)
  }
})

test('a cancellation passes through untouched, and so does a bug in our own code', () => {
  const abort = new APIUserAbortError()
  assert.equal(classify(abort), abort)
  const bug = new TypeError('undefined is not a function')
  assert.equal(classify(bug), bug)
})

test('a provider error surfaces from complete() already classified', async () => {
  const send: Send = async () => {
    throw generate(429, 'rate_limit_error')
  }
  await assert.rejects(
    messagesProvider('anthropic', send).complete({ model: 'm', messages: [], max_tokens: 1, signal }),
    (e: unknown) => e instanceof InfraError && e.retryable && /429/.test(e.message),
  )
})
