import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ConfigError } from '../../src/core/errors.ts'
import type { TranscriptEntry } from '../../src/core/types.ts'
import type { GradeContext, Judge, TrialResult } from '../../src/graders/index.ts'
import type { CompleteRequest, Provider } from '../../src/providers/index.ts'
import type { LoadedCase } from '../../src/suite/load.ts'
import { Grader, type Grader as GraderSpec } from '../../src/suite/schema.ts'
import { oneCase } from './cases.ts'
import { tree } from './tmp.ts'

// A grader spec with its schema defaults applied, exactly as a loaded case has it.
export function spec<K extends GraderSpec['kind']>(g: { kind: K } & Record<string, unknown>): Extract<GraderSpec, { kind: K }> {
  return Grader.parse(g) as Extract<GraderSpec, { kind: K }>
}

// A finished trial laid out the way the store lays it out: artifacts/ beside
// transcript.jsonl, plus a workdir and a home. `transcript: null` leaves the
// transcript file out entirely.
export function trial(
  o: { workdir?: Record<string, string>; artifacts?: Record<string, string>; transcript?: TranscriptEntry[] | null } = {},
): TrialResult {
  const root = tree({ 'work/.keep': '', 'home/.keep': '' })
  const out = join(root, 'out')
  const artifacts: Record<string, string> = {}
  for (const [name, content] of Object.entries(o.artifacts ?? {})) {
    artifacts[name] = join(out, 'artifacts', name)
    put(artifacts[name], content)
  }
  for (const [rel, content] of Object.entries(o.workdir ?? {})) put(join(root, 'work', rel), content)
  const transcript = join(out, 'transcript.jsonl')
  if (o.transcript !== null) put(transcript, (o.transcript ?? []).map(e => `${JSON.stringify(e)}\n`).join(''))
  return { exit: 'ok', artifacts, transcript, usage: { input_tokens: 0, output_tokens: 0 }, wall_clock_ms: 0, workdir: join(root, 'work'), home: join(root, 'home') }
}

export function ctx(c: LoadedCase = oneCase(CASE).c, judges: Record<string, Judge> = {}, signal = new AbortController().signal): GradeContext {
  return {
    case: c,
    judge: name => {
      const j = judges[name]
      if (!j) throw new ConfigError(`no judge named "${name}"`)
      return j
    },
    signal,
  }
}

export const CASE = 'name: c\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: regex, pattern: x }]\n'

// A provider that answers from a script, in order, and records every request.
// Judge, confirm and extract tests never reach a real model.
export function stub(replies: (string | Error)[]): Provider & { calls: CompleteRequest[] } {
  const calls: CompleteRequest[] = []
  return {
    id: 'fake',
    calls,
    async complete(req) {
      calls.push(req)
      const r = replies[calls.length - 1]
      if (r === undefined) throw new Error(`stub provider has no reply #${calls.length}`)
      if (r instanceof Error) throw r
      return { text: r, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, raw: {} }
    },
  }
}

export function judgeOf(provider: Provider, name = 'default'): Judge {
  return { name, def: { provider: 'fake', model: 'judge-model' }, hash: `hash-of-${name}`, provider }
}

export const verdict = (pass: boolean, rationale = 'because') => `\`\`\`json\n${JSON.stringify({ pass, rationale })}\n\`\`\``

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
