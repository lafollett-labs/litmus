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

export function classify(e: unknown): unknown {
  if (e instanceof APIUserAbortError) return e // cancellation, not a failure
  if (e instanceof APIConnectionError) return new InfraError(`connection failed: ${e.message}`, { cause: e })
  if (e instanceof APIError) {
    const status = e.status ?? 0
    const retryable = status === 408 || status === 409 || status === 429 || status >= 500
    return new InfraError(`${status} ${e.type ?? 'error'}: ${e.message}`, { retryable, cause: e })
  }
  // No credentials at all surfaces as a plain AnthropicError (or, on Bedrock,
  // the AWS credential chain's own error) before any request is sent. It will
  // fail the same way on every attempt.
  if (e instanceof AnthropicError || (e instanceof Error && e.name === 'CredentialsProviderError')) {
    return new InfraError(`no usable credentials: ${e.message}`, { retryable: false, cause: e })
  }
  return e
}
