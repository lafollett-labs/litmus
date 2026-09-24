import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { InfraError } from '../core/errors.ts'
import type { ExecutorResult, Usage } from '../core/types.ts'
import { createProvider, priced, type Provider } from '../providers/index.ts'
import { deadline } from './deadline.ts'
import { extractJson, renderPrompt } from './render.ts'
import { Transcript } from './transcript.ts'
import type { ExecJob } from './types.ts'

// One provider call: render the prompt, send it with the subject as the system
// prompt, keep the answer. Whether the answer is any good is the graders' call,
// including an answer with no JSON in it.
export async function runModel(job: ExecJob, provider: Provider = createProvider(job.config)): Promise<ExecutorResult> {
  const exec = job.case.spec.executor
  if (exec.kind !== 'model') throw new Error(`runModel given a ${exec.kind} case`)
  const started = Date.now()
  const tx = new Transcript(job.out.transcript, job.key, job.emit)
  mkdirSync(job.out.artifacts, { recursive: true })
  const zero: Usage = { input_tokens: 0, output_tokens: 0 }
  const done = (exit: ExecutorResult['exit'], extra: Partial<ExecutorResult> = {}): ExecutorResult => ({
    exit,
    artifacts: {},
    transcript: tx.path,
    usage: zero,
    wall_clock_ms: Date.now() - started,
    ...extra,
  })

  const prompt = renderPrompt(job.case.prompt, job.workdir.dir, job.case.changePatch)
  // A directory subject is refused for model cases at load; only a file is text.
  const system = job.case.subject?.kind === 'file' ? job.case.subject.content : undefined
  if (system !== undefined) tx.message('system', system)
  tx.message('user', prompt)

  const clock = deadline(job.signal, job.case.settings.timeout_s * 1000)
  try {
    const model = 'model' in job.config ? job.config.model : 'fake'
    const r = await provider.complete({
      model,
      ...(system === undefined ? {} : { system }),
      messages: [{ role: 'user', content: prompt }],
      max_tokens: exec.max_tokens,
      ...('effort' in job.config && job.config.effort ? { effort: job.config.effort } : {}),
      ...('params' in job.config && job.config.params ? { params: job.config.params } : {}),
      signal: clock.signal,
      trace: { case_id: job.case.id, trial: job.trial, attempt: job.attempt, ...(job.case.fakeFile ? { fake_file: job.case.fakeFile } : {}) },
    })
    const usage = priced(r.usage, model, job.pricing)
    tx.message('assistant', r.text)
    tx.usage(usage)

    const artifacts: Record<string, string> = { 'response.txt': join(job.out.artifacts, 'response.txt') }
    writeFileSync(artifacts['response.txt']!, r.text)
    const json = extractJson(r.text)
    if (json) {
      artifacts['findings.json'] = join(job.out.artifacts, 'findings.json')
      writeFileSync(artifacts['findings.json'], `${JSON.stringify(json, null, 2)}\n`)
    }
    return done('ok', { artifacts, usage, ...(r.stop_reason ? { reason: `stop_reason: ${r.stop_reason}` } : {}) })
  } catch (e) {
    const why = clock.stopped()
    if (why === 'cancelled') return done('cancelled')
    // One provider call that outlives the deadline is a slow or stuck
    // connection, not a model spiralling, so it is retried (ARCHITECTURE
    // § Flow). The harness keeps timeout as a model failure: there it is the
    // subject's own session that ran long.
    if (why === 'timeout') return done('infra_error', { reason: `timeout after ${job.case.settings.timeout_s}s`, retryable: true })
    if (e instanceof InfraError) return done('infra_error', { reason: e.message, retryable: e.retryable })
    throw e
  } finally {
    clock.clear()
  }
}
