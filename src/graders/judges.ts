import { z } from 'zod'
import { ConfigError, InfraError } from '../core/errors.ts'
import type { Usage } from '../core/types.ts'
import { deadline, raced } from '../executors/deadline.ts'
import { hashJson } from '../core/hash.ts'
import { extractJson } from '../executors/render.ts'
import { createProvider, type Provider } from '../providers/index.ts'
import type { JudgeDef } from '../suite/schema.ts'
import { JUDGE_PROMPT_VERSION, JUDGE_SYSTEM } from './prompts.ts'
import type { Judge } from './types.ts'

export { EXTRACT_PROMPT_VERSION, JUDGE_PROMPT_VERSION } from './prompts.ts'

const JUDGE_MAX_TOKENS = 4096

export function judgeHash(def: JudgeDef): string {
  // A fake judge has none of effort, region or params; each is hashed as unset.
  const pick = <K extends 'effort' | 'region' | 'params'>(k: K) => (k in def ? (def as Partial<Record<K, unknown>>)[k] : undefined)
  return hashJson({ provider: def.provider, model: def.model, effort: pick('effort'), region: pick('region'), params: pick('params'), prompt_version: JUDGE_PROMPT_VERSION })
}

// One provider per judge name, made on first use: a config may name judges a
// run never touches, and those must not need credentials.
export function makeJudges(defs: Record<string, JudgeDef>, providerFor: (def: JudgeDef) => Provider = createProvider): (name: string) => Judge {
  const made = new Map<string, Judge>()
  return name => {
    const hit = made.get(name)
    if (hit) return hit
    // hasOwn: "constructor" is a valid judge name, and every object has one.
    const def = Object.hasOwn(defs, name) ? defs[name] : undefined
    if (!def) throw new ConfigError(`no judge named "${name}" under judges: in litmus.config.yaml (have: ${Object.keys(defs).join(', ') || 'none'})`)
    const judge: Judge = { name, def, hash: judgeHash(def), provider: providerFor(def) }
    made.set(name, judge)
    return judge
  }
}

// A provider failure is an InfraError and propagates: the runner retries the
// grading. Only the model's answer is interpreted here. Every call has its own
// deadline, as the model executor's does: a judge whose provider never settles
// would otherwise hold the trial in grading until the run is cancelled.
export const JUDGE_TIMEOUT_S = 300

export async function ask(judge: Judge, system: string, user: string, maxTokens: number, signal: AbortSignal): Promise<{ text: string; usage: Usage }> {
  const clock = deadline(signal, JUDGE_TIMEOUT_S * 1000)
  try {
    const r = await raced(
      judge.provider.complete({
        model: judge.def.model,
        system,
        messages: [{ role: 'user', content: user }],
        max_tokens: maxTokens,
        ...('effort' in judge.def && judge.def.effort ? { effort: judge.def.effort } : {}),
        ...('params' in judge.def && judge.def.params ? { params: judge.def.params } : {}),
        signal: clock.signal,
      }),
      clock.signal,
    )
    if (clock.stopped()) throw new Error('answered after the clock stopped') // classified below, never accepted
    return { text: r.text, usage: r.usage }
  } catch (e) {
    if (clock.stopped() === 'timeout') throw new InfraError(`judge "${judge.name}" gave no answer within ${JUDGE_TIMEOUT_S}s`, { retryable: true })
    throw e // a cancel, or the provider's own InfraError
  } finally {
    clock.clear()
  }
}

export async function askJudge(judge: Judge, user: string, signal: AbortSignal): Promise<{ pass: boolean; rationale: string; usage: Usage }> {
  const r = await ask(judge, JUDGE_SYSTEM, user, JUDGE_MAX_TOKENS, signal)
  return { ...parseVerdict(r.text), usage: r.usage }
}

// Tokens and cost across several judge calls; cost only when every call reported one.
export function sumUsage(all: Usage[]): Usage {
  const cost = all.every(u => u.cost_usd !== undefined) && all.length ? all.reduce((n, u) => n + u.cost_usd!, 0) : undefined
  return { input_tokens: all.reduce((n, u) => n + u.input_tokens, 0), output_tokens: all.reduce((n, u) => n + u.output_tokens, 0), ...(cost === undefined ? {} : { cost_usd: cost }) }
}

const Verdict = z.object({ pass: z.boolean(), rationale: z.string() })

// Anything but a well-formed { pass: boolean, rationale: string } is a no. A
// judge that rambles, refuses, or answers "pass": "yes" has not said yes.
export function parseVerdict(text: string): { pass: boolean; rationale: string } {
  const v = Verdict.safeParse(extractJson(text))
  if (v.success) return { pass: v.data.pass, rationale: v.data.rationale }
  return { pass: false, rationale: `judge reply unparseable: ${JSON.stringify(text.length > 200 ? `${text.slice(0, 197)}...` : text)}` }
}
