import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hashJson } from '../core/hash.ts'
import { extractJson } from '../executors/render.ts'
import { Findings } from '../suite/schema.ts'
import { normPath, readArtifact, relativeInside } from './common.ts'
import { ask } from './judges.ts'
import { EXTRACT_PROMPT_VERSION, EXTRACT_SYSTEM, extractRequest } from './prompts.ts'
import type { RunExtract, TrialResult } from './types.ts'

const EXTRACT_MAX_TOKENS = 16000

// docs/ARCHITECTURE.md § Extract: a pinned model turns a free-form review into
// litmus:findings, so a real /review skill is scored without changing what it
// writes. The hash is returned whenever the case has an extract step, even
// when nothing was extracted: it identifies how the trial was graded.
export const runExtract: RunExtract = async (trial, ctx) => {
  const spec = ctx.case.spec.extract
  if (!spec) return { trial }
  const judge = ctx.judge(spec.with)
  const extractor_hash = hashJson({ judge: judge.hash, prompt_version: EXTRACT_PROMPT_VERSION })
  const to = relativeInside(spec.to, 'extract.to')

  // Whatever already sits at `to` (a findings.json the executor pulled out of
  // the reply itself, say) must not stand in for an extraction that failed.
  // It leaves the artifact map, so the graders fail on the missing artifact.
  const artifacts = Object.fromEntries(Object.entries(trial.artifacts).filter(([name]) => normPath(name) !== to))
  const without: TrialResult = { ...trial, artifacts }

  // Every way it can fail says why, so the graders' "findings.json was not
  // produced" can be traced back to the extractor rather than the subject.
  const source = spec.from === 'final_message' ? (readArtifact(trial, 'final_message.txt') ?? readArtifact(trial, 'response.txt')) : readArtifact(trial, spec.from)
  if (!source) return { trial: without, extractor_hash, error: `nothing to extract from: ${spec.from} was not produced` }

  const reply = await ask(judge, EXTRACT_SYSTEM, extractRequest(source.text), EXTRACT_MAX_TOKENS, ctx.signal)
  const usage = reply.usage
  const parsed = Findings.safeParse(extractJson(reply.text))
  if (!parsed.success) {
    const said = ctx.redact.text(reply.text)
    return { trial: without, extractor_hash, usage, error: `the extractor's reply is not litmus:findings: ${JSON.stringify(said.length > 200 ? `${said.slice(0, 197)}...` : said)}` }
  }

  // The subject named the files under artifacts/, so a directory (or a file on
  // the way) can already sit at `to`. That fails the extraction, never the run.
  const path = join(artifactsDir(trial), to)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(ctx.redact.json(parsed.data), null, 2)}\n`)
  } catch (e) {
    return { trial: without, extractor_hash, usage, error: `could not write ${to}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` }
  }
  return { trial: { ...trial, artifacts: { ...artifacts, [to]: path } }, extractor_hash, usage }
}

// The directory the executor wrote artifacts into, recovered from any
// artifact whose path ends in its own name; failing that, the store's layout.
function artifactsDir(trial: TrialResult): string {
  for (const [name, path] of Object.entries(trial.artifacts)) {
    const suffix = `/${normPath(name)}`
    if (path.replaceAll('\\', '/').endsWith(suffix)) return path.slice(0, path.length - suffix.length)
  }
  return join(dirname(trial.transcript), 'artifacts')
}
