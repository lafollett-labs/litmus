import Anthropic, { AnthropicError, APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import { InfraError } from '../core/errors.ts'
import type { CompleteRequest, CompleteResponse, Provider } from './types.ts'

// The Anthropic API and Bedrock's Mantle endpoint share the Messages surface,
// so one adapter serves both; only the client differs.

export type Send = (body: Anthropic.MessageCreateParamsNonStreaming, signal: AbortSignal) => Promise<Anthropic.Message>

export function streamingSend(client: Pick<Anthropic, 'messages'>): Send {
  // Streaming, even though litmus only wants the final message: a long review
  // at a high max_tokens outlives a non-streaming request's HTTP timeout.
  return (body, signal) => client.messages.stream(body, { signal }).finalMessage()
}

export function messagesProvider(id: 'anthropic' | 'bedrock', send: Send): Provider {
  return {
    id,
    async complete(req: CompleteRequest): Promise<CompleteResponse> {
      const params = (req.params ?? {}) as Partial<Anthropic.MessageCreateParamsNonStreaming>
      const body: Anthropic.MessageCreateParamsNonStreaming = {
        ...params,
        model: req.model,
        max_tokens: req.max_tokens,
        messages: req.messages,
        ...(req.system === undefined ? {} : { system: req.system }),
        ...(req.effort === undefined ? {} : { output_config: { ...params.output_config, effort: req.effort } }),
      }
      // No server-side fallbacks, ever: a fallback answers with a different
      // model, and an eval that silently measures the wrong model is worse
      // than one that reports ERROR.
      let message: Anthropic.Message
      try {
        message = await send(body, req.signal)
      } catch (e) {
        throw classify(e)
      }
      const text = message.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('')
      const u = message.usage
      return {
        text,
        stop_reason: message.stop_reason,
        usage: {
          input_tokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          output_tokens: u.output_tokens,
        },
        raw: message,
      }
    },
  }
}

// Error types that say the request itself was wrong: another attempt fails
// the same way.
const FAILS_AGAIN = new Set(['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'request_too_large', 'billing_error'])

export function classify(e: unknown): unknown {
  if (e instanceof APIUserAbortError) return e // cancellation, not a failure
  // Mantle wraps an AWS credential failure in an APIConnectionError. It stays
  // retryable, as the SDK intends (resolution is network-bound: SSO, IMDS,
  // STS), and an empty chain fails before anything reaches the model. The
  // message is the credential error's own, which names the fix (an expired SSO
  // session says to run `aws sso login`).
  const cred = credentialFailure(e)
  if (cred) return new InfraError(`no usable credentials: ${cred.message}`, { cause: e })
  if (e instanceof APIConnectionError) return new InfraError(`connection failed: ${e.message}`, { cause: e })
  if (e instanceof APIError) {
    const id = e.requestID ? ` (request ${e.requestID})` : '' // the id Anthropic support asks for
    // An error event mid-stream has no HTTP status, only its body's type
    // (overloaded_error, api_error): the server failed after it had started
    // answering. That is worth another attempt unless the type says the
    // request itself was wrong.
    if (e.status === undefined) {
      const retryable = !FAILS_AGAIN.has(e.type ?? '')
      return new InfraError(`stream error ${e.type ?? 'error'}: ${e.message}${id}`, { retryable, cause: e })
    }
    const status = e.status
    const retryable = status === 408 || status === 409 || status === 429 || status >= 500
    return new InfraError(`${e.type ?? 'error'}: ${e.message}${id}`, { retryable, cause: e }) // e.message already leads with the status
  }
  // Anything else the SDK raises is the stream failing in flight. MessageStream
  // turns a dropped connection, a body that ended before message_stop, and
  // malformed SSE into a plain AnthropicError.
  if (e instanceof AnthropicError) return new InfraError(`stream failed: ${e.message}`, { cause: e })
  return e
}

function credentialFailure(e: unknown): Error | undefined {
  for (let c: unknown = e; c instanceof Error; c = c.cause) {
    if (c.name === 'CredentialsProviderError') return c
  }
  return undefined
}
