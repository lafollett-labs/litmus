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

const retryableStatus = (s: number) => s === 408 || s === 409 || s === 429 || s >= 500

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
      let text: string
      try {
        res = await doFetch(URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: req.signal,
        })
        // OpenRouter sends the 200 before generation ends, so reading the body
        // lasts as long as the answer, and a reset can land in either step.
        text = await res.text()
      } catch (e) {
        if (req.signal.aborted) throw e
        throw new InfraError(`connection failed: ${(e as Error).message}`, { cause: e })
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
      // For a bring-your-own-key request, cost is only OpenRouter's fee; the
      // provider's own charge is reported beside it.
      const byok = usage?.is_byok === true ? (usage.cost_details?.upstream_inference_cost ?? 0) : 0
      return {
        text: answerText(choice.message),
        stop_reason: choice.finish_reason ?? null,
        usage: {
          input_tokens: usage?.prompt_tokens ?? 0,
          output_tokens: usage?.completion_tokens ?? 0,
          ...(typeof usage?.cost === 'number' ? { cost_usd: usage.cost + byok } : {}),
        },
        raw: data,
      }
    },
  }
}

// The model's text, whatever shape it came in. Content may be a string or an
// array of parts, and a refusal arrives in its own field. Either way it is
// output for the graders. An empty answer (reasoning that spent the whole
// budget, finish_reason "length") is the model's result too, not an error.
function answerText(m: { content?: string | { type?: string; text?: string }[] | null; refusal?: string | null }): string {
  const content = Array.isArray(m.content) ? m.content.flatMap(p => (p.type === 'text' && typeof p.text === 'string' ? [p.text] : [])).join('') : (m.content ?? '')
  return content || (m.refusal ?? '')
}

// An upstream error is classified by its code the way an HTTP status is. With
// no code there is nothing to say it will fail again, so it is retried.
function upstream(e: UpstreamError | undefined): InfraError {
  const code = typeof e?.code === 'number' ? e.code : /^\d+$/.test(String(e?.code ?? '')) ? Number(e?.code) : undefined
  return new InfraError(`upstream error ${e?.code ?? ''}: ${e?.message ?? 'finish_reason error'}`, { retryable: code === undefined || retryableStatus(code) })
}
