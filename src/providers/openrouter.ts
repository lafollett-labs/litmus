import { InfraError } from '../core/errors.ts'
import type { CompleteRequest, CompleteResponse, Provider } from './types.ts'

const URL = 'https://openrouter.ai/api/v1/chat/completions'

type Deps = { fetch?: typeof fetch; apiKey?: string | undefined; env?: NodeJS.ProcessEnv }

type UpstreamError = { code?: number | string; message?: string }

type ChatResponse = {
  choices?: { message?: { content?: string | { type?: string; text?: string }[] | null; refusal?: string | null }; finish_reason?: string | null; error?: UpstreamError }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; is_byok?: boolean; cost_details?: { upstream_inference_cost?: number } }
  error?: UpstreamError
}

const retryableStatus = (s: number) => s === 408 || s === 409 || s === 429 || (s >= 500 && s < 600)

export function openrouterProvider(deps: Deps = {}): Provider {
  const doFetch = deps.fetch ?? fetch
  return {
    id: 'openrouter',
    async complete(req: CompleteRequest): Promise<CompleteResponse> {
      const key = deps.apiKey ?? (deps.env ?? process.env)['OPENROUTER_API_KEY']
      if (!key) throw new InfraError('OPENROUTER_API_KEY is not set', { retryable: false })
      const reasoning = req.params?.['reasoning'] as Record<string, unknown> | undefined
      const body = {
        ...req.params,
        model: req.model,
        max_tokens: req.max_tokens,
        messages: [...(req.system === undefined ? [] : [{ role: 'system', content: req.system }]), ...req.messages],
        ...(req.effort === undefined ? {} : { reasoning: { ...reasoning, effort: req.effort } }),
        stream: false, // one JSON body; an SSE reply would only burn retries as "unparseable"
      }
      let res: Response
      try {
        res = await doFetch(URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: req.signal,
        })
      } catch (e) {
        if (req.signal.aborted) throw e
        throw new InfraError(`connection failed: ${(e as Error).message}`, { cause: e })
      }
      // OpenRouter sends the 200 before generation ends, so reading the body
      // lasts as long as the answer. A read that fails after an error status
      // is still classified by that status.
      let text: string
      try {
        text = await res.text()
      } catch (e) {
        if (req.signal.aborted) throw e
        const retryable = res.ok || retryableStatus(res.status)
        throw new InfraError(`${res.status}: response body failed: ${(e as Error).message}`, { retryable, cause: e })
      }
      if (!res.ok) throw new InfraError(`${res.status}: ${text.slice(0, 500)}`, { retryable: retryableStatus(res.status) })
      let data: unknown
      try {
        data = JSON.parse(text)
      } catch {
        throw new InfraError(`unparseable response: ${text.slice(0, 200)}`)
      }
      if (typeof data !== 'object' || data === null) throw new InfraError(`unexpected response: ${text.slice(0, 200)}`)
      const { choices, usage, error } = data as ChatResponse
      const choice = choices?.[0]
      // OpenRouter reports upstream failures inside a 200: at the top level, or
      // on the choice with finish_reason "error" beside any partial output.
      // Either way there is no answer to grade, so it must not read as a FAIL.
      const failed = choice?.error ?? error
      if (failed || choice?.finish_reason === 'error') throw upstream(failed)
      if (!choice?.message) throw new InfraError(`response carried no answer: ${text.slice(0, 200)}`)
      const answer = answerText(choice.message)
      const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : null
      // An empty answer is the model's result only when the finish reason says
      // why: it spent its budget ("length", often all on reasoning) or was
      // filtered. Empty with "stop" or no reason is how an upstream hiccup
      // looks through OpenRouter, and grading it FAIL would be a false regression.
      if (answer === '' && !EMPTY_IS_A_RESULT.has(finish ?? '')) throw new InfraError(`empty answer with finish_reason ${finish ?? 'null'}`)
      return {
        text: answer,
        stop_reason: finish,
        usage: { input_tokens: count(usage?.prompt_tokens), output_tokens: count(usage?.completion_tokens), ...cost(usage) },
        raw: data,
      }
    },
  }
}

const EMPTY_IS_A_RESULT = new Set(['length', 'content_filter'])

// For a bring-your-own-key request, cost is only OpenRouter's fee and the
// provider's charge is reported beside it. With that charge missing, the
// reported cost would be a known under-count, so none is reported and the
// pricing fallback estimates it instead.
function cost(u: ChatResponse['usage']): { cost_usd?: number } {
  if (typeof u?.cost !== 'number' || !Number.isFinite(u.cost)) return {}
  if (u.is_byok !== true) return { cost_usd: u.cost }
  const upstream = u.cost_details?.upstream_inference_cost
  return typeof upstream === 'number' ? { cost_usd: u.cost + upstream } : {}
}

// The model's text, whatever shape it came in. Content may be a string or an
// array of parts, and a refusal arrives in its own field. Either way it is
// output for the graders. The body is parsed JSON, not a checked type, so
// every field is checked before it is read: a malformed part is no text,
// never a TypeError out of the boundary.
function answerText(m: unknown): string {
  if (typeof m !== 'object' || m === null) return ''
  const { content, refusal } = m as { content?: unknown; refusal?: unknown }
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.flatMap(p => (isTextPart(p) ? [p.text] : [])).join('')
        : ''
  return text || (typeof refusal === 'string' ? refusal : '')
}

function isTextPart(p: unknown): p is { type: 'text'; text: string } {
  return typeof p === 'object' && p !== null && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string'
}

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0)

// An upstream error is classified by its code the way an HTTP status is. With
// no code there is nothing to say it will fail again, so it is retried.
function upstream(e: UpstreamError | undefined): InfraError {
  const code = typeof e?.code === 'number' ? e.code : /^\d+$/.test(String(e?.code ?? '')) ? Number(e?.code) : undefined
  return new InfraError(`upstream error ${e?.code ?? ''}: ${e?.message ?? 'finish_reason error'}`, { retryable: code === undefined || retryableStatus(code) })
}
