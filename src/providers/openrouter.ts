import { InfraError } from '../core/errors.ts'
import type { CompleteRequest, CompleteResponse, Provider } from './types.ts'

const URL = 'https://openrouter.ai/api/v1/chat/completions'

type Deps = { fetch?: typeof fetch; apiKey?: string | undefined }

type ChatResponse = {
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
  error?: { code?: number | string; message?: string }
}

export function openrouterProvider(deps: Deps = {}): Provider {
  const doFetch = deps.fetch ?? fetch
  return {
    id: 'openrouter',
    async complete(req: CompleteRequest): Promise<CompleteResponse> {
      const key = deps.apiKey ?? process.env['OPENROUTER_API_KEY']
      if (!key) throw new InfraError('OPENROUTER_API_KEY is not set', { retryable: false })
      const body = {
        ...req.params,
        model: req.model,
        max_tokens: req.max_tokens,
        messages: [...(req.system === undefined ? [] : [{ role: 'system', content: req.system }]), ...req.messages],
        ...(req.effort === undefined ? {} : { reasoning: { effort: req.effort } }),
        usage: { include: true }, // ask OpenRouter to report the cost it charged
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
      const text = await res.text()
      if (!res.ok) {
        const s = res.status
        throw new InfraError(`${s}: ${text.slice(0, 500)}`, { retryable: s === 408 || s === 409 || s === 429 || s >= 500 })
      }
      let data: ChatResponse
      try {
        data = JSON.parse(text) as ChatResponse
      } catch {
        throw new InfraError(`unparseable response: ${text.slice(0, 200)}`)
      }
      // OpenRouter reports some upstream failures as a 200 with an error body.
      if (data.error) throw new InfraError(`upstream error ${data.error.code ?? ''}: ${data.error.message ?? ''}`)
      const choice = data.choices?.[0]
      return {
        text: choice?.message?.content ?? '',
        stop_reason: choice?.finish_reason ?? null,
        usage: {
          input_tokens: data.usage?.prompt_tokens ?? 0,
          output_tokens: data.usage?.completion_tokens ?? 0,
          ...(typeof data.usage?.cost === 'number' ? { cost_usd: data.usage.cost } : {}),
        },
        raw: data,
      }
    },
  }
}
