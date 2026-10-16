import { readFileSync, rmdirSync, rmSync } from 'node:fs'
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
import { sumUsage } from '../graders/judges.ts'
import { createProvider, priced, type Provider } from '../providers/index.ts'
import { buildWorkdir, type Workdir } from '../sandbox/workdir.ts'
import { compare, type CompareOptions, type CompareSide } from '../stats/compare.ts'
import { settle } from '../stats/verdict.ts'
import { RunStore, type RunManifest } from '../store/store.ts'
import { effectiveMinTrials, type Config, type LoadedCase } from '../suite/load.ts'
import type { JudgeDef } from '../suite/schema.ts'
import type { Selection } from '../suite/select.ts'
import { hashTree } from '../suite/tree.ts'
import { caseHash, judgesOf } from './case-hash.ts'
import { readTrial, sideMetrics } from './metrics.ts'
import type { RunSide } from './rerun.ts'

export type RunOptions = {
  config: Config
  selection: Selection
  configs: string[] // config names; a trial-key selector's config must be among them
  selectors?: string[] // as the operator gave them, recorded in run.json
  trials?: number // --trials: overrides each case's own count (a trial-key selector ignores it)
  only?: ReadonlySet<string> // "<case>@<config>": run just these pairs (a rerun)
  parent?: string // the run this one reruns
  baseline?: RunSide
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

// notes: what the run could not do and says so rather than failing, such as
// a --baseline config the baseline run does not hold.
export type RunOutcome = { id: string; dir: string; manifest: RunManifest; verdicts: Verdict[]; comparisons: Comparison[]; notes: string[] }

type Job = { key: string; ref: TrialRef; case: LoadedCase; configName: string }

// A cost is reported only when every call that spent tokens was priced: one
// unpriced call makes the sum a floor, and a floor read as the cost misleads.
// A call that spent nothing (an attempt refused before it reached the
// provider) has nothing to price.
const total = (parts: Usage[]): Usage => sumUsage(parts.filter(u => u.input_tokens + u.output_tokens > 0 || u.cost_usd !== undefined))

// Exponential with jitter: 1 s, 2 s, 4 s ... capped at 30 s, so a throttled
// provider is not hammered by every concurrent trial at once.
export const defaultBackoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2)

// docs/ARCHITECTURE.md § Flow of a run.
export async function run(o: RunOptions): Promise<RunOutcome> {
  const { config } = o
  const env = o.env ?? process.env
  // A fault in litmus itself (the store cannot be written) aborts this one, so
  // no worker goes on spending on a run that can no longer record it.
  const fault = new AbortController()
  const signal = o.signal ? AbortSignal.any([o.signal, fault.signal]) : fault.signal
  const now = o.now ?? (() => new Date())
  const backoff = o.backoffMs ?? defaultBackoff
  // The harness reads its credentials from process.env whatever `env` says,
  // so both are scrubbed.
  const redact: Redactor = redactor(secretValues(config.redact, o.env ? { ...process.env, ...o.env } : process.env))
  if (new Set(o.configs).size !== o.configs.length) throw new ConfigError(`config named twice in ${o.configs.join(',')}`)
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
  // A subscriber that throws (a closed SSE socket) is its own problem; it
  // never takes the run down with it.
  // The listener hears every event even when the store cannot record it, so a
  // live view still sees run.failed when the store is what failed.
  const emit = (e: RunEvent) => {
    try {
      store.event(e)
    } finally {
      try {
        o.listener?.(redact.json(e))
      } catch {
        // the listener's failure is not the run's
      }
    }
  }

  try {
    return await execute()
  } catch (e) {
    fault.abort(e)
    // Best effort on both: the store is what failed. The event lets a live
    // view (and a replay of events.jsonl, when it can still be written) end.
    try {
      emit({ type: 'run.failed', run: id, error: redact.text((e as Error)?.message ?? String(e)) })
    } catch {
      // the error below says why
    }
    try {
      store.finish('failed', now())
    } catch {
      // the error below says why
    }
    throw e
  } finally {
    // Every workdir removes itself, which leaves the run's own directory empty.
    try {
      rmdirSync(join(o.workBase ?? tmpdir(), 'litmus', id))
    } catch {
      // never made (no trial got a workdir), or not empty: left alone
    }
  }

  async function execute(): Promise<RunOutcome> {
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

    const leaks: string[] = []
    const ctx = { o, config, signal, redact, store, emit, judge, backoff, env, leaks }
    let next = 0
    let broke: { error: unknown } | undefined
    // A trial that throws becomes an error trial and the run goes on. Only when
    // even that cannot be recorded does the run stop, every worker with it.
    const worker = async () => {
      while (next < jobs.length && !signal.aborted) {
        const job = jobs[next++]!
        try {
          const record = await trial(job, ctx).catch(e => crashed(job, e, ctx))
          records.push(record)
          const k = `${job.case.id}@${job.configName}`
          const g = groups.get(k)!
          g.records.push(record)
          if (g.records.length === g.scheduled && !signal.aborted) settleGroup(k)
        } catch (e) {
          broke ??= { error: e }
          fault.abort(e)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(config.concurrency, jobs.length) }, worker))
    if (broke) throw broke.error

    // A cancel settles nothing further: a case missing trials the operator
    // stopped would read as INCONCLUSIVE, and a cancelled trial is never scored.
    const cancelled = signal.aborted
    const order = (v: Verdict) => `${v.case}@${v.config}`
    verdicts.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0))
    store.verdicts(verdicts)

    // A cancelled run compares nothing: its missing cases would read as change.
    const current: RunSide = {
      label: '',
      configs: o.configs,
      verdicts,
      records,
      hashes: caseHashes,
      subjects: Object.fromEntries(cases.flatMap(c => (c.subject ? [[c.id, c.subject.hash]] : []))),
      plugins,
    }
    const { comparisons, notes } = cancelled ? { comparisons: [], notes: [] } : comparisonsOf(o, current)
    store.comparisons(comparisons)
    const summary = Object.fromEntries((['PASS', 'FAIL', 'FLAKY', 'ERROR', 'INCONCLUSIVE'] as VerdictKind[]).map(k => [k, verdicts.filter(v => v.verdict === k).length])) as Record<VerdictKind, number>
    emit({ type: cancelled ? 'run.cancelled' : 'run.finished', run: id, summary })
    const manifest = store.finish(cancelled ? 'cancelled' : 'finished', now())
    return { id, dir: store.dir, manifest, verdicts, comparisons, notes: [...notes, ...leaks] }
  }
}

// A workdir that will not go is reported, never thrown: by then the trial's
// record may be written, and its outcome is not the cleanup's to decide.
function release(w: Workdir | undefined, x: Ctx): void {
  try {
    w?.cleanup()
  } catch (e) {
    x.leaks.push(`workdir ${w!.root} was not removed: ${(e as Error).message}`)
  }
}

// One job per (case, config, trial). A trial-key selector limits its case to
// the trials it names and ignores --trials.
function expand(o: RunOptions): Job[] {
  const jobs: Job[] = []
  for (const sel of o.selection) {
    const c = sel.case
    for (const r of sel.trials ?? []) {
      if (!o.configs.includes(r.config)) throw new ConfigError(`trial ${trialKey(r)} names config "${r.config}", which this run does not use (--config ${o.configs.join(',')})`)
    }
    const refs: TrialRef[] = sel.trials
      ? sel.trials
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
  leaks: string[] // workdirs that would not go; a note, never the trial's outcome
}

// A trial: attempts until one is not a retryable infra error, then extraction
// and grading (retried on their own, never re-running the executor), then the
// status, with a cancel checked first so it can never pass.
async function trial(job: Job, x: Ctx): Promise<TrialRecord> {
  const { config, signal } = x
  const def = config.configs[job.configName]!
  const started = x.o.now?.() ?? new Date()
  x.emit({ type: 'trial.started', key: job.key })

  const spent: Usage[] = []
  const gradingSpent: Usage[] = []
  let attempts = 0
  let result: ExecutorResult | undefined
  let failure: string | undefined // a reason the trial is an error without a result
  let kept = 0
  let workdir: ReturnType<typeof buildWorkdir> | undefined
  let artifacts: Record<string, string> = {}
  let graders: GraderResult[] = []
  let gradeError: string | undefined
  let extractorHash: string | undefined
  let extractError: string | undefined
  const executor = x.o.executors?.[job.case.spec.executor.kind] ?? (job.case.spec.executor.kind === 'model' ? (j: ExecJob) => runModel(j, createProvider(def, x.env)) : runHarness)

  try {
    return await attemptAndGrade()
  } catch (e) {
    // What the trial spent is known here and nowhere else.
    throw new TrialCrash(e, attempts, total(spent), gradingSpent.length ? total(gradingSpent) : undefined)
  } finally {
    release(workdir, x)
  }

  async function attemptAndGrade(): Promise<TrialRecord> {
      for (let attempt = 1; attempt <= 1 + config.retries && !signal.aborted; attempt++) {
        attempts = attempt
        release(workdir, x)
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
        if (result) spent.push(result.usage)
        const retryable = result ? result.exit === 'infra_error' && result.retryable === true : failure !== undefined
        if (!retryable || attempt > config.retries || signal.aborted) break
        x.emit({ type: 'trial.retry', key: job.key, attempt, reason: result?.reason ?? failure ?? 'infra error' })
        await sleep(x.backoff(attempt), signal)
      }

      artifacts = result && kept ? x.store.keepAttempt(job.ref, kept, result.artifacts) : (x.store.keepAttempt(job.ref, 0, {}), {})
      if (result && workdir && (result.exit === 'ok' || result.exit === 'model_failure') && !signal.aborted) {
        const gctx: GradeContext = { case: job.case, judge: x.judge, signal, redact: x.redact }
        const executed = artifacts
        let written: string | undefined // the file this attempt's extraction wrote
        for (let g = 1; g <= 1 + config.retries; g++) {
          // Every grading attempt starts from what the executor left, so a
          // findings.json an earlier extraction wrote cannot outlive a later
          // extraction that failed, in the record or on disk.
          extractError = undefined
          if (written !== undefined) rmSync(written, { force: true })
          written = undefined
          try {
            let t: TrialResult = { ...result, artifacts: executed, transcript: join(x.store.trialDir(job.ref), 'transcript.jsonl'), workdir: workdir.dir, home: workdir.home }
            if (result.exit === 'ok' && job.case.spec.extract) {
              const ex = await runExtract(t, gctx)
              t = ex.trial
              written = Object.values(t.artifacts).find(p => !Object.values(executed).includes(p))
              extractorHash = ex.extractor_hash
              extractError = ex.error
              if (ex.usage) gradingSpent.push(priceFor(ex.usage, job.case.spec.extract.with, x))
            }
            graders = await gradeAll(t, gctx)
            // Results come back in case order, so each lines up with its spec and its judge.
            graders.forEach((r, i) => {
              const spec = job.case.spec.graders[i]!
              const by = spec.kind === 'judge' ? spec.judge : spec.kind === 'review-match' ? spec.confirm : undefined
              if (r.usage && by !== undefined) gradingSpent.push(priceFor(r.usage, by, x))
            })
            artifacts = t.artifacts
            gradeError = undefined
            break
          } catch (e) {
            if (signal.aborted) break
            gradeError = x.redact.text(`grading failed: ${(e as Error).message}`)
            if (!(e instanceof InfraError && e.retryable) || g > config.retries) break
            x.emit({ type: 'trial.retry', key: job.key, attempt: g, reason: `grading: ${gradeError}` })
            await sleep(x.backoff(g), signal)
          }
        }
        if (written !== undefined && !Object.values(artifacts).includes(written)) rmSync(written, { force: true })
      }

    const status: TrialStatus =
      signal.aborted || result?.exit === 'cancelled'
        ? 'cancelled'
        : !result || result.exit === 'infra_error'
          ? 'error'
          : result.exit === 'model_failure' // graded for metrics only, so a grading error cannot hide it
            ? 'fail'
            : gradeError !== undefined
              ? 'error'
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
      usage: total(spent),
      ...(gradingSpent.length ? { grading_usage: total(gradingSpent) } : {}),
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
}

// A trial that threw after it began, with what it had spent by then.
class TrialCrash extends Error {
  readonly attempts: number
  readonly usage: Usage
  readonly grading: Usage | undefined
  constructor(error: unknown, attempts: number, usage: Usage, grading: Usage | undefined) {
    super((error as Error)?.message ?? String(error), { cause: error })
    this.attempts = attempts
    this.usage = usage
    this.grading = grading
  }
}

// A trial that threw outside its attempts (the store could not move its files,
// say) is an error trial with the reason, like a workdir that would not build.
// If this cannot be written either, the throw stops the run.
function crashed(job: Job, e: unknown, x: Ctx): TrialRecord {
  const known = e instanceof TrialCrash ? e : undefined
  const at = (x.o.now?.() ?? new Date()).toISOString()
  const status: TrialStatus = x.signal.aborted ? 'cancelled' : 'error'
  const record: TrialRecord = {
    key: job.key,
    run: x.store.manifest.id,
    case: job.case.id,
    config: job.configName,
    trial: job.ref.trial,
    status,
    exit: 'infra_error',
    reason: x.redact.text(`internal error: ${(e as Error)?.message ?? String(e)}`),
    attempts: known?.attempts ?? 0,
    graders: [],
    usage: known?.usage ?? { input_tokens: 0, output_tokens: 0 },
    ...(known?.grading ? { grading_usage: known.grading } : {}),
    wall_clock_ms: 0,
    started_at: at,
    finished_at: at,
    artifacts: [],
    tool_calls: 0,
    findings: null,
  }
  x.store.writeTrial(record)
  x.emit({ type: 'trial.finished', key: job.key, status, graders: [] })
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
// --baseline, each config is compared with the baseline's same config. A
// config the baseline never ran is reported in the notes and skipped.
function comparisonsOf(o: RunOptions, current: RunSide): { comparisons: Comparison[]; notes: string[] } {
  const opts = { tolerance: o.config.compare.tolerance, warnRatio: o.config.compare.warn_ratio }
  const comparisons: Comparison[] = []
  const notes: string[] = []
  const [first, ...rest] = o.configs
  for (const b of rest) comparisons.push(pair({ ...current, label: first! }, first!, { ...current, label: b }, b, opts))
  const base = o.baseline
  if (base) {
    for (const c of o.configs) {
      if (!base.configs.includes(c)) {
        notes.push(`baseline ${base.label} has no config "${c}", so ${c} is not compared with it`)
        continue
      }
      comparisons.push(pair({ ...base, label: `${base.label}:${c}` }, c, { ...current, label: c }, c, opts))
    }
  }
  return { comparisons, notes }
}

// A comparison over the cases both sides scored, WARN medians included: taken
// over every case a side ran, a median would measure which cases were picked
// rather than how the model did on the same ones.
function pair(a: RunSide, configA: string, b: RunSide, configB: string, opts: CompareOptions): Comparison {
  const side = (s: RunSide, config: string): CompareSide => ({ label: s.label, verdicts: s.verdicts.filter(v => v.config === config), hashes: s.hashes })
  const sa = side(a, configA)
  const sb = side(b, configB)
  const shape = compare(sa, sb, opts)
  const out = new Set(shape.excluded.map(e => e.case))
  const paired = new Set(sa.verdicts.map(v => v.case).filter(id => !out.has(id)))
  const metrics = (s: RunSide, config: string) => sideMetrics(s.records.filter(r => r.config === config && paired.has(r.case)))
  return compare({ ...sa, metrics: metrics(a, configA), notes: versionNotes(a, b, paired) }, { ...sb, metrics: metrics(b, configB) }, opts)
}

// A subject or plugin that differs between the sides is what a comparison is
// usually for, so it is reported, never excluded (docs/ARCHITECTURE.md §
// Comparison). Within one run both sides share them, and nothing is noted.
function versionNotes(a: RunSide, b: RunSide, paired: Set<string>): string[] {
  const short = (h: string | undefined) => (h === undefined ? 'none' : h.slice(0, 12))
  const notes: string[] = []
  for (const id of [...paired].sort()) {
    const ha = a.subjects[id]
    const hb = b.subjects[id]
    if (ha !== hb) notes.push(`${id}: subject changed (${short(ha)} → ${short(hb)})`)
  }
  for (const root of [...new Set([...Object.keys(a.plugins), ...Object.keys(b.plugins)])].sort()) {
    const ha = Object.hasOwn(a.plugins, root) ? a.plugins[root] : undefined
    const hb = Object.hasOwn(b.plugins, root) ? b.plugins[root] : undefined
    if (ha === undefined || hb === undefined) notes.push(`plugin ${root}: loaded only by ${ha === undefined ? b.label : a.label}`)
    else if (ha !== hb) notes.push(`plugin ${root}: changed (${short(ha)} → ${short(hb)})`)
  }
  return notes
}

export const LITMUS_VERSION: string = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version
