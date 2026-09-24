import { z } from 'zod'
import { ConfigError } from '../core/errors.ts'
import { hashJson } from '../core/hash.ts'
import { extractJson } from '../executors/render.ts'
import { createProvider, type Provider } from '../providers/index.ts'
import type { JudgeDef } from '../suite/schema.ts'
import { JUDGE_PROMPT_VERSION, JUDGE_SYSTEM } from './prompts.ts'
import type { Judge } from './types.ts'

export { EXTRACT_PROMPT_VERSION, JUDGE_PROMPT_VERSION } from './prompts.ts'

const JUDGE_MAX_TOKENS = 4096

export function judgeHash(def: JudgeDef): string {
  return hashJson({ provider: def.provider, model: def.model, effort: def.effort, region: def.region, params: def.params, prompt_version: JUDGE_PROMPT_VERSION })
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
// grading. Only the model's answer is interpreted here.
export async function ask(judge: Judge, system: string, user: string, maxTokens: number, signal: AbortSignal): Promise<string> {
  const r = await judge.provider.complete({
    model: judge.def.model,
    system,
    messages: [{ role: 'user', content: user }],
    max_tokens: maxTokens,
    ...(judge.def.effort ? { effort: judge.def.effort } : {}),
    ...(judge.def.params ? { params: judge.def.params } : {}),
    signal,
  })
  return r.text
}

export async function askJudge(judge: Judge, user: string, signal: AbortSignal): Promise<{ pass: boolean; rationale: string }> {
  return parseVerdict(await ask(judge, JUDGE_SYSTEM, user, JUDGE_MAX_TOKENS, signal))
}

const Verdict = z.object({ pass: z.boolean(), rationale: z.string() })

// Anything but a well-formed { pass: boolean, rationale: string } is a no. A
// judge that rambles, refuses, or answers "pass": "yes" has not said yes.
export function parseVerdict(text: string): { pass: boolean; rationale: string } {
  const v = Verdict.safeParse(extractJson(text))
  if (v.success) return { pass: v.data.pass, rationale: v.data.rationale }
  return { pass: false, rationale: `judge reply unparseable: ${JSON.stringify(text.length > 200 ? `${text.slice(0, 197)}...` : text)}` }
}
