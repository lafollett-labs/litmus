import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { ConfigError, InfraError } from '../core/errors.ts'
import type { CompleteRequest, CompleteResponse, Provider } from './types.ts'

// fake.yaml: scripted responses, indexed by trial. Trial n uses entry
// (n - 1) mod len, so a two-entry script [pass, fail] makes a case FLAKY on
// purpose. This is what lets the whole runner be tested for $0.
export const FakeScript = z.strictObject({
  responses: z
    .array(
      z.strictObject({
        text: z.string().optional(),
        text_file: z.string().min(1).optional(),
        infra_errors: z.int().min(0).default(0), // the first N attempts throw a retryable InfraError
        fatal: z.string().min(1).optional(), // every attempt throws a non-retryable InfraError
        delay_ms: z.int().min(0).default(0),
        usage: z.strictObject({ input_tokens: z.int().min(0), output_tokens: z.int().min(0) }).optional(),
        cost_usd: z.number().min(0).optional(),
      }),
    )
    .min(1),
})
export type FakeScript = z.infer<typeof FakeScript>

export function loadFakeScript(file: string): FakeScript {
  let raw: unknown
  try {
    raw = parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new ConfigError(`${file}: ${(e as Error).message}`)
  }
  const r = FakeScript.safeParse(raw)
  if (!r.success) throw new ConfigError(`${file}: ${r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return r.data
}

export function fakeProvider(): Provider {
  return {
    id: 'fake',
    async complete(req: CompleteRequest): Promise<CompleteResponse> {
      const file = req.trace?.fake_file
      if (!file) throw new InfraError(`the fake provider needs a fake.yaml beside the case`, { retryable: false })
      const script = loadFakeScript(file)
      const trial = req.trace?.trial ?? 1
      const entry = script.responses[(trial - 1) % script.responses.length]!
      await sleep(entry.delay_ms, req.signal)
      if (entry.fatal) throw new InfraError(`fake fatal: ${entry.fatal}`, { retryable: false })
      if ((req.trace?.attempt ?? 1) <= entry.infra_errors) throw new InfraError(`fake infra error on attempt ${req.trace?.attempt ?? 1}`)
      const text = entry.text_file ? readText(resolve(dirname(file), entry.text_file), file) : (entry.text ?? '')
      const usage = entry.usage ?? { input_tokens: 0, output_tokens: 0 }
      return {
        text,
        stop_reason: 'end_turn',
        usage: entry.cost_usd === undefined ? usage : { ...usage, cost_usd: entry.cost_usd },
        raw: { fake: true, trial, entry: (trial - 1) % script.responses.length },
      }
    },
  }
}

function readText(path: string, from: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    throw new ConfigError(`${from}: text_file ${path}: ${(e as Error).message}`)
  }
}

// A cancel before or during the delay rejects at once, and a delay that runs
// out removes its listener: a long run makes thousands of these calls on one
// signal.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  if (ms === 0) return Promise.resolve()
  return new Promise((ok, fail) => {
    const onAbort = () => (clearTimeout(t), fail(signal.reason))
    const t = setTimeout(() => (signal.removeEventListener('abort', onAbort), ok()), ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
