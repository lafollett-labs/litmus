import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, InfraError } from '../core/errors.ts'
import { runId as newRunId, trialKey, type TrialRef } from '../core/ids.ts'
import { redactor, secretValues, type Redactor } from '../core/redact.ts'
import type { Comparison, ExecutorResult, GraderResult, RunEvent, TrialRecord, TrialStatus, Usage, Verdict, VerdictKind } from '../core/types.ts'
import { runHarness } from '../executors/harness.ts'
import { runModel } from '../executors/model.ts'
import type { Executor, ExecJob } from '../executors/types.ts'
import { gradeAll, judgeHash, makeJudges, runExtract, type GradeContext, type Judge, type TrialResult } from '../graders/index.ts'
import { createProvider, priced, type Provider } from '../providers/index.ts'
import { buildWorkdir } from '../sandbox/workdir.ts'
import { compare, type CompareSide } from '../stats/compare.ts'
import { settle } from '../stats/verdict.ts'
import { RunStore, type RunManifest } from '../store/store.ts'
import { effectiveMinTrials, type Config, type LoadedCase } from '../suite/load.ts'
import type { JudgeDef } from '../suite/schema.ts'
import type { Selection } from '../suite/select.ts'
import { hashTree } from '../suite/tree.ts'
import { caseHash, judgesOf } from './case-hash.ts'
import { readTrial, sideMetrics } from './metrics.ts'

export type RunOptions = {
  config: Config
  selection: Selection
  configs: string[] // config names; a trial-key selector's config must be among them
  selectors?: string[] // as the operator gave them, recorded in run.json
  trials?: number // --trials: overrides each case's own count (a trial-key selector ignores it)
  only?: ReadonlySet<string> // "<case>@<config>": run just these pairs (a rerun)
  parent?: string // the run this one reruns
  baseline?: { label: string; verdicts: Verdict[]; records: TrialRecord[]; hashes: Record<string, string> }
  signal?: AbortSignal
  listener?: (e: RunEvent) => void
  env?: NodeJS.ProcessEnv
  // Seams for tests; production passes none of these.
  executors?: Partial<Record<'model' | 'harness', Executor>>
  judgeProvider?: (def: JudgeDef) => Provider
  backoffMs?: (attempt: number) => number
  workBase?: string
  id?: string
  now?: () => Date
}

export type RunOutcome = { id: string; dir: string; manifest: RunManifest; verdicts: Verdict[]; comparisons: Comparison[] }

type Job = { key: string; ref: TrialRef; case: LoadedCase; configName: string }

const ZERO: Usage = { input_tokens: 0, output_tokens: 0 }
const add = (a: Usage, b: Usage): Usage => {
  const cost = a.cost_usd === undefined && b.cost_usd === undefined ? undefined : (a.cost_usd ?? 0) + (b.cost_usd ?? 0)
  return { input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens, ...(cost === undefined ? {} : { cost_usd: cost }) }
}

// Exponential with jitter: 1 s, 2 s, 4 s ... capped at 30 s, so a throttled
// provider is not hammered by every concurrent trial at once.
const defaultBackoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2)

// docs/ARCHITECTURE.md § Flow of a run.
export async function run(o: RunOptions): Promise<RunOutcome> {
  const { config } = o
  const env = o.env ?? process.env
  const signal = o.signal ?? new AbortController().signal
  const now = o.now ?? (() => new Date())
  const backoff = o.backoffMs ?? defaultBackoff
  const redact: Redactor = redactor(secretValues(config.redact, env))
  for (const name of o.configs) if (!Object.hasOwn(config.configs, name)) throw new ConfigError(`no config named "${name}" (defined: ${Object.keys(config.configs).join(', ')})`)

  const jobs = expand(o)
  if (jobs.length === 0) throw new ConfigError('nothing to run: the selection and --only leave no trials')

  // Judges are pinned by hash; a provider is made only when a grader calls one.
  const judgeDefs = config.judges
  const judge = makeJudges(judgeDefs, o.judgeProvider ?? (def => createProvider(def, env)))
  const hashOfJudge = (name: string) => {
    const def = Object.hasOwn(judgeDefs, name) ? judgeDefs[name] : undefined
    if (!def) throw new ConfigError(`no judge named "${name}" under judges: in litmus.config.yaml`)
    return judgeHash(def)
  }
  const cases = [...new Map(jobs.map(j => [j.case.id, j.case])).values()]
  const caseHashes = Object.fromEntries(cases.map(c => [c.id, caseHash(c, hashOfJudge)]))
  const plugins = Object.fromEntries([...new Set(cases.flatMap(c => c.plugins))].sort().map(p => [p, hashTree(p)]))

  const id = o.id ?? newRunId(now())
  const store = RunStore.create(config.resultsDir, {
    id,
    ...(o.parent ? { parent: o.parent } : {}),
    status: 'running',
    started_at: now().toISOString(),
    litmus_version: LITMUS_VERSION,
    selection: o.selectors ?? [],
    configs: Object.fromEntries(o.configs.map(n => [n, config.configs[n]!])),
    cases: cases.map(c => ({ id: c.id, case_hash: caseHashes[c.id]!, ...(c.subject ? { subject_hash: c.subject.hash } : {}) })),
    judges: Object.fromEntries([...new Set(cases.flatMap(judgesOf))].sort().map(n => [n, hashOfJudge(n)])),
    plugins,
  }, redact)
  const emit = (e: RunEvent) => {
    store.event(e)
    o.listener?.(redact.json(e))
  }

  emit({ type: 'run.started', run: id, jobs: jobs.length })
  for (const j of jobs) emit({ type: 'trial.queued', key: j.key })

  // Settled as soon as a (case, config) has every trial, so the UI sees a
  // verdict the moment it exists rather than at the end of the run.
  const groups = new Map<string, { case: LoadedCase; config: string; scheduled: number; records: TrialRecord[] }>()
  for (const j of jobs) {
    const k = `${j.case.id}@${j.configName}`
    const g = groups.get(k) ?? { case: j.case, config: j.configName, scheduled: 0, records: [] }
    g.scheduled++
    groups.set(k, g)
  }
  const verdicts: Verdict[] = []
  const records: TrialRecord[] = []
  const settleGroup = (k: string) => {
    const g = groups.get(k)!
    const v = settle({
      case: g.case.id,
      config: g.config,
      policy: g.case.settings.policy,
      threshold: g.case.settings.threshold,
      min_trials: effectiveMinTrials(g.case.settings, g.scheduled),
      expect: g.case.spec.expect,
      trials: g.scheduled,
      outcomes: g.records.map(r => ({ status: r.status, exit: r.exit })),
    })
    verdicts.push(v)
    emit({ type: 'case.settled', case: v.case, config: v.config, verdict: v })
  }

  const ctx = { o, config, signal, redact, store, emit, judge, backoff, env }
  let next = 0
  const worker = async () => {
    while (next < jobs.length && !signal.aborted) {
      const job = jobs[next++]!
      const record = await trial(job, ctx)
      records.push(record)
      const k = `${job.case.id}@${job.configName}`
      const g = groups.get(k)!
      g.records.push(record)
      if (g.records.length === g.scheduled && !signal.aborted) settleGroup(k)
    }
  }
  await Promise.all(Array.from({ length: Math.min(config.concurrency, jobs.length) }, worker))

  // A cancel settles nothing further: a case missing trials the operator
  // stopped would read as INCONCLUSIVE, and a cancelled trial is never scored.
  const cancelled = signal.aborted
  const order = (v: Verdict) => `${v.case}@${v.config}`
  verdicts.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0))
  store.verdicts(verdicts)

  const comparisons = cancelled ? [] : comparisonsOf(o, verdicts, records, caseHashes)
  store.comparisons(comparisons)
  const summary = Object.fromEntries((['PASS', 'FAIL', 'FLAKY', 'ERROR', 'INCONCLUSIVE'] as VerdictKind[]).map(k => [k, verdicts.filter(v => v.verdict === k).length])) as Record<VerdictKind, number>
  emit({ type: cancelled ? 'run.cancelled' : 'run.finished', run: id, summary })
  const manifest = store.finish(cancelled ? 'cancelled' : 'finished', now())
  return { id, dir: store.dir, manifest, verdicts, comparisons }
}

// One job per (case, config, trial). A trial-key selector limits its case to
// the trials it names and ignores --trials.
function expand(o: RunOptions): Job[] {
  const jobs: Job[] = []
  for (const sel of o.selection) {
    const c = sel.case
    const refs: TrialRef[] = sel.trials
      ? sel.trials.filter(r => {
          if (!o.configs.includes(r.config)) throw new ConfigError(`trial ${trialKey(r)} names config "${r.config}", which this run does not use (--config ${o.configs.join(',')})`)
          return true
        })
      : o.configs.flatMap(config => Array.from({ length: o.trials ?? c.settings.trials }, (_, i) => ({ suite: c.suite, case: c.name, config, trial: i + 1 })))
    for (const ref of refs) {
      if (o.only && !o.only.has(`${c.id}@${ref.config}`)) continue
      jobs.push({ key: trialKey(ref), ref, case: c, configName: ref.config })
    }
  }
  return jobs
}

type Ctx = {
  o: RunOptions
  config: Config
  signal: AbortSignal
  redact: Redactor
  store: RunStore
  emit: (e: RunEvent) => void
  judge: (name: string) => Judge
  backoff: (attempt: number) => number
  env: NodeJS.ProcessEnv
}

// A trial: attempts until one is not a retryable infra error, then extraction
// and grading (retried on their own, never re-running the executor), then the
// status, with a cancel checked first so it can never pass.
async function trial(job: Job, x: Ctx): Promise<TrialRecord> {
  const { config, signal } = x
  const def = config.configs[job.configName]!
  const started = x.o.now?.() ?? new Date()
  x.emit({ type: 'trial.started', key: job.key })

  let usage: Usage = ZERO
  let attempts = 0
  let result: ExecutorResult | undefined
  let failure: string | undefined // a reason the trial is an error without a result
  let kept = 0
  let workdir: ReturnType<typeof buildWorkdir> | undefined
  const executor = x.o.executors?.[job.case.spec.executor.kind] ?? (job.case.spec.executor.kind === 'model' ? (j: ExecJob) => runModel(j, createProvider(def, x.env)) : runHarness)

  for (let attempt = 1; attempt <= 1 + config.retries && !signal.aborted; attempt++) {
    attempts = attempt
    workdir?.cleanup()
    workdir = undefined
    try {
      workdir = buildWorkdir(job.case, { run: x.store.manifest.id, key: job.key, attempt }, x.o.workBase ?? tmpdir(), [config.resultsDir, ...config.roots])
      result = await executor({
        key: job.key,
        case: job.case,
        configName: job.configName,
        config: def,
        trial: job.ref.trial,
        attempt,
        workdir,
        suiteRoots: config.roots,
        out: x.store.attemptDir(job.ref, attempt),
        pricing: config.pricing,
        emit: x.emit,
        redact: x.redact,
        signal,
      })
      kept = attempt
      failure = undefined
    } catch (e) {
      // A case that cannot be built (a patch that no longer applies) or an
      // executor bug: the trial is an error with the reason, and the run goes on.
      result = undefined
      failure = x.redact.text(`${e instanceof ConfigError ? 'case error' : e instanceof InfraError ? 'infra error' : 'internal error'}: ${(e as Error).message}`)
      if (!(e instanceof InfraError && e.retryable)) break
    }
    if (result) usage = add(usage, result.usage)
    const retryable = result ? result.exit === 'infra_error' && result.retryable === true : failure !== undefined
    if (!retryable || attempt > config.retries || signal.aborted) break
    x.emit({ type: 'trial.retry', key: job.key, attempt, reason: result?.reason ?? failure ?? 'infra error' })
    await sleep(x.backoff(attempt), signal)
  }

  const artifacts = result && kept ? x.store.keepAttempt(job.ref, kept, result.artifacts) : (x.store.keepAttempt(job.ref, 0, {}), {})
  let graders: GraderResult[] = []
  let gradeError: string | undefined
  let extractorHash: string | undefined
  let extractError: string | undefined
  let gradingUsage: Usage = ZERO
  if (result && workdir && (result.exit === 'ok' || result.exit === 'model_failure') && !signal.aborted) {
    const gctx: GradeContext = { case: job.case, judge: x.judge, signal, redact: x.redact }
    for (let g = 1; g <= 1 + config.retries; g++) {
      try {
        let t: TrialResult = { ...result, artifacts, transcript: join(x.store.trialDir(job.ref), 'transcript.jsonl'), workdir: workdir.dir, home: workdir.home }
        if (result.exit === 'ok' && job.case.spec.extract) {
          const ex = await runExtract(t, gctx)
          t = ex.trial
          extractorHash = ex.extractor_hash
          extractError = ex.error
          if (ex.usage) gradingUsage = add(gradingUsage, priceFor(ex.usage, job.case.spec.extract.with, x))
          Object.assign(artifacts, t.artifacts)
        }
        graders = await gradeAll(t, gctx)
        // Results come back in case order, so each lines up with its spec and its judge.
        graders.forEach((r, i) => {
          const spec = job.case.spec.graders[i]!
          const by = spec.kind === 'judge' ? spec.judge : spec.kind === 'review-match' ? spec.confirm : undefined
          if (r.usage && by !== undefined) gradingUsage = add(gradingUsage, priceFor(r.usage, by, x))
        })
        gradeError = undefined
        break
      } catch (e) {
        if (signal.aborted) break
        gradeError = x.redact.text(`grading failed: ${(e as Error).message}`)
        if (!(e instanceof InfraError && e.retryable) || g > config.retries) break
        await sleep(x.backoff(g), signal)
      }
    }
  }
  workdir?.cleanup()

  const status: TrialStatus =
    signal.aborted || result?.exit === 'cancelled'
      ? 'cancelled'
      : !result || result.exit === 'infra_error' || gradeError !== undefined
        ? 'error'
        : result.exit === 'model_failure'
          ? 'fail'
          : graders.every(r => r.pass)
            ? 'pass'
            : 'fail'
  const reason = [failure ?? result?.reason, gradeError, extractError && `extraction: ${extractError}`].filter(Boolean).join('; ')
  const detail = readTrial(x.store.trialDir(job.ref), artifacts)
  const record: TrialRecord = {
    key: job.key,
    run: x.store.manifest.id,
    case: job.case.id,
    config: job.configName,
    trial: job.ref.trial,
    status,
    exit: result?.exit ?? 'infra_error',
    ...(reason ? { reason } : {}),
    attempts,
    graders,
    usage,
    ...(gradingUsage !== ZERO ? { grading_usage: gradingUsage } : {}),
    wall_clock_ms: result?.wall_clock_ms ?? 0,
    started_at: started.toISOString(),
    finished_at: (x.o.now?.() ?? new Date()).toISOString(),
    artifacts: Object.keys(artifacts).sort(),
    tool_calls: detail.tool_calls,
    findings: detail.findings,
    ...(job.case.subject ? { subject_hash: job.case.subject.hash } : {}),
    ...(extractorHash ? { extractor_hash: extractorHash } : {}),
    ...(judgesOf(job.case).length ? { judge_hashes: Object.fromEntries(judgesOf(job.case).map(n => [n, x.judge(n).hash])) } : {}),
  }
  x.store.writeTrial(record)
  x.emit({ type: 'trial.finished', key: job.key, status, graders: graders.map(g => ({ grader: g.grader, pass: g.pass })) })
  return record
}

const priceFor = (u: Usage, judgeName: string, x: Ctx) => priced(u, x.judge(judgeName).def.model, x.config.pricing)

// Resolves early on a cancel: a backoff never holds up the operator.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve()
  return new Promise(ok => {
    const done = () => (clearTimeout(t), signal.removeEventListener('abort', done), ok())
    const t = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

// Every config after the first is compared with the first, and with
// --baseline, each config is compared with the baseline's same config.
function comparisonsOf(o: RunOptions, verdicts: Verdict[], records: TrialRecord[], hashes: Record<string, string>): Comparison[] {
  const opts = { tolerance: o.config.compare.tolerance, warnRatio: o.config.compare.warn_ratio }
  const sideOf = (label: string, config: string, vs: Verdict[], rs: TrialRecord[], hs: Record<string, string>): CompareSide => ({
    label,
    verdicts: vs.filter(v => v.config === config),
    metrics: sideMetrics(rs.filter(r => r.config === config)),
    hashes: hs,
  })
  const out: Comparison[] = []
  const [first, ...rest] = o.configs
  for (const b of rest) out.push(compare(sideOf(first!, first!, verdicts, records, hashes), sideOf(b, b, verdicts, records, hashes), opts))
  if (o.baseline) {
    for (const c of o.configs) {
      out.push(compare(sideOf(`${o.baseline.label}:${c}`, c, o.baseline.verdicts, o.baseline.records, o.baseline.hashes), sideOf(c, c, verdicts, records, hashes), opts))
    }
  }
  return out
}

export const LITMUS_VERSION: string = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version
