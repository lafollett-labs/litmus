import { test } from 'node:test'
import assert from 'node:assert/strict'
import Anthropic from '@anthropic-ai/sdk'
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk'
import { InfraError } from '../../src/core/errors.ts'
import { messagesProvider, streamingSend } from '../../src/providers/messages.ts'

// The real SDK clients over a mocked fetch: MessageStream re-wraps failures on
// its way out, so the error shapes classify() sees are only real from here.
// Nothing leaves the machine.

const enc = new TextEncoder()
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const usage = { input_tokens: 5, output_tokens: 1 }
const start = sse('message_start', {
  type: 'message_start',
  message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, stop_sequence: null, usage },
})
const block = sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
const delta = sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a review' } })
const finish = [
  sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }),
  sse('message_stop', { type: 'message_stop' }),
]
const errorEvent = (type: string) => sse('error', { type: 'error', error: { type, message: type } })

type End = 'close' | 'drop' | 'hang'

function mockFetch(chunks: string[], end: End): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const body = new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch))
        if (end === 'close') c.close()
        if (end === 'drop') c.error(new TypeError('terminated'))
        if (end === 'hang') init.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')))
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
}

const clients = {
  anthropic: (f: typeof fetch) => new Anthropic({ apiKey: 'test-key', authToken: null, fetch: f, maxRetries: 0 }),
  bedrock: (f: typeof fetch) => new AnthropicBedrockMantle({ apiKey: 'test-key', awsRegion: 'us-east-1', fetch: f, maxRetries: 0 }),
}

const call = (id: keyof typeof clients, f: typeof fetch, signal = new AbortController().signal) =>
  messagesProvider(id, streamingSend(clients[id](f))).complete({ model: 'x', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10, signal })

for (const id of ['anthropic', 'bedrock'] as const) {
  test(`${id}: a complete stream becomes the answer`, async () => {
    const r = await call(id, mockFetch([start, block, delta, ...finish], 'close'))
    assert.equal(r.text, 'a review')
    assert.equal(r.stop_reason, 'end_turn')
  })

  test(`${id}: a stream that fails in flight is a retryable infra error, never "credentials"`, async () => {
    const shapes: [string, string[], End][] = [
      ['connection drop mid-stream', [start, block, delta], 'drop'],
      ['closed before message_stop', [start, block, delta], 'close'],
      ['malformed SSE data', [start, 'event: content_block_delta\ndata: {not json\n\n'], 'close'],
      ['empty 200 body', [], 'close'],
      ['overloaded mid-stream', [start, errorEvent('overloaded_error')], 'close'],
    ]
    for (const [label, chunks, end] of shapes) {
      await assert.rejects(
        call(id, mockFetch(chunks, end)),
        (e: unknown) => e instanceof InfraError && e.retryable && !/credentials/.test(e.message),
        label,
      )
    }
  })

  test(`${id}: a request the server rejects mid-stream is not retried`, async () => {
    await assert.rejects(call(id, mockFetch([start, errorEvent('invalid_request_error')], 'close')), (e: unknown) => e instanceof InfraError && !e.retryable)
  })

  test(`${id}: a cancel mid-stream is passed through, not turned into an infra error`, async () => {
    const ctl = new AbortController()
    const pending = call(id, mockFetch([start, block, delta], 'hang'), ctl.signal)
    setTimeout(() => ctl.abort(new Error('cancelled')), 20)
    await assert.rejects(pending, (e: unknown) => !(e instanceof InfraError))
  })
}
