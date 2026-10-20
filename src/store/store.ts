import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ConfigError } from '../core/errors.ts'
import { NAME, parseTrialKey, RUN_ID, type TrialRef } from '../core/ids.ts'
import type { Redactor } from '../core/redact.ts'
import type { Comparison, RunEvent, TrialRecord, Verdict, VerdictKind } from '../core/types.ts'
import type { ConfigDef } from '../suite/schema.ts'

export type RunManifest = {
  id: string
  parent?: string
  status: 'running' | 'finished' | 'cancelled' | 'failed' // failed: litmus itself broke (the store could not be written)
  started_at: string
  finished_at?: string
  litmus_version: string
  selection: string[]
  configs: Record<string, ConfigDef> // params were checked for credentials at load
  cases: { id: string; case_hash: string; subject_hash?: string }[]
  judges: Record<string, string> // name -> hash, for every judge a case in the run can call
  plugins: Record<string, string> // plugin root -> tree hash, for every plugin the run loaded
}

export type StoredRun = { manifest: RunManifest; verdicts: Verdict[]; comparisons: Comparison[] }

// One run's directory (docs/ARCHITECTURE.md § Storage). Every record passes
// through the redactor as JSON, before it is stringified, so escaping can
// never hide a key. Transcripts and artifacts are redacted by the executor
// that wrote them; the store only moves the last attempt's into place.
export class RunStore {
  readonly dir: string
  readonly #redact: Redactor
  #manifest: RunManifest

  private constructor(dir: string, manifest: RunManifest, redact: Redactor) {
    this.dir = dir
    this.#manifest = manifest
    this.#redact = redact
  }

  // Runs are append-only: an id that exists already is never written into.
  static create(resultsDir: string, manifest: RunManifest, redact: Redactor): RunStore {
    if (!RUN_ID.test(manifest.id)) throw new Error(`not a run id: ${manifest.id}`)
    const dir = join(resultsDir, manifest.id)
    mkdirSync(resultsDir, { recursive: true })
    // Not recursive, so the claim on the id is atomic: two runs given one id
    // cannot both write into it.
    try {
      mkdirSync(dir)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new ConfigError(`run ${manifest.id} already exists`)
      throw e
    }
    mkdirSync(join(dir, 'trials'))
    const store = new RunStore(dir, manifest, redact)
    store.#writeJson('run.json', manifest)
    return store
  }

  get manifest(): RunManifest {
    return this.#manifest
  }

  event(e: RunEvent): void {
    appendFileSync(join(this.dir, 'events.jsonl'), `${JSON.stringify(this.#redact.json(e))}\n`)
  }

  trialDir(ref: TrialRef): string {
    return join(this.dir, 'trials', ref.suite, ref.case, ref.config, String(ref.trial))
  }

  // Where one attempt writes, so a retried attempt never appends to the
  // transcript of the one before it.
  attemptDir(ref: TrialRef, attempt: number): { artifacts: string; transcript: string } {
    const dir = join(this.trialDir(ref), '.attempts', String(attempt))
    return { artifacts: join(dir, 'artifacts'), transcript: join(dir, 'transcript.jsonl') }
  }

  // The kept attempt becomes the trial's transcript.jsonl and artifacts/, and
  // the others are removed. Returns the artifact map rewritten to the new place.
  keepAttempt(ref: TrialRef, attempt: number, artifacts: Record<string, string>): Record<string, string> {
    const dir = this.trialDir(ref)
    const from = this.attemptDir(ref, attempt)
    const artifactsDir = join(dir, 'artifacts')
    // No attempt may have written anything: a workdir that would not build, or
    // an executor that threw before its first write.
    mkdirSync(dir, { recursive: true })
    if (existsSync(from.transcript)) renameSync(from.transcript, join(dir, 'transcript.jsonl'))
    else writeFileSync(join(dir, 'transcript.jsonl'), '')
    if (existsSync(from.artifacts)) renameSync(from.artifacts, artifactsDir)
    else mkdirSync(artifactsDir, { recursive: true })
    rmSync(join(dir, '.attempts'), { recursive: true, force: true })
    const moved: Record<string, string> = {}
    for (const [name, path] of Object.entries(artifacts)) {
      moved[name] = path.startsWith(from.artifacts) ? join(artifactsDir, path.slice(from.artifacts.length)) : path
    }
    return moved
  }

  writeTrial(record: TrialRecord): void {
    const ref = parseTrialKey(record.key)
    if (!ref) throw new Error(`not a trial key: ${record.key}`)
    const dir = this.trialDir(ref)
    mkdirSync(dir, { recursive: true })
    writeAtomic(join(dir, 'trial.json'), `${JSON.stringify(this.#redact.json(record), null, 2)}\n`)
  }

  verdicts(v: Verdict[]): void {
    this.#writeJson('verdicts.json', v)
  }

  comparisons(c: Comparison[]): void {
    if (c.length) this.#writeJson('comparison.json', c)
  }

  // Returns the manifest as written: redacted, like everything a reporter prints.
  finish(status: 'finished' | 'cancelled' | 'failed', at: Date = new Date()): RunManifest {
    this.#manifest = { ...this.#manifest, status, finished_at: at.toISOString() }
    this.#writeJson('run.json', this.#manifest)
    return this.#redact.json(this.#manifest)
  }

  #writeJson(name: string, value: unknown): void {
    writeAtomic(join(this.dir, name), `${JSON.stringify(this.#redact.json(value), null, 2)}\n`)
  }
}

// A reader (litmus serve, while a CLI run finishes) or a kill mid-write sees
// the old file or the new one, never a truncated one.
function writeAtomic(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text)
  renameSync(`${path}.tmp`, path)
}

const parse = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

// ── readers ──────────────────────────────────────────────────────────────────

// What every reader of a manifest leans on. A record without it was edited by
// hand or written by something else, and reading on would crash far from here.
const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v)
const whole = (m: unknown): m is RunManifest =>
  isObject(m) && ['configs', 'judges', 'plugins'].every(k => isObject((m as Record<string, unknown>)[k])) && Array.isArray((m as RunManifest).cases)

export function readRun(resultsDir: string, id: string): StoredRun {
  if (!RUN_ID.test(id)) throw new ConfigError(`"${id}" is not a run id`)
  const dir = join(resultsDir, id)
  if (!existsSync(join(dir, 'run.json'))) throw new ConfigError(`no run ${id} under ${resultsDir}`)
  const read = <T>(name: string, fallback: T): T => {
    if (!existsSync(join(dir, name))) return fallback
    const value = parse<T>(join(dir, name))
    if (value === undefined) throw new ConfigError(`${join(dir, name)} does not parse; the run's record is damaged`)
    return value
  }
  const manifest = read<RunManifest>('run.json', undefined as never)
  if (!whole(manifest)) throw new ConfigError(`${join(dir, 'run.json')} lacks its configs, cases, judges or plugins; the run's record is damaged`)
  return { manifest, verdicts: read<Verdict[]>('verdicts.json', []), comparisons: read<Comparison[]>('comparison.json', []) }
}

// Newest first, by start time to the millisecond: a run id sorts only to the
// second, and two runs started in that second would otherwise come back in
// the order of their random suffixes. A run whose run.json does not parse, or
// lacks the fields every reader needs (written by hand, or by an
// older litmus without atomic writes), is skipped, so one bad run cannot hide
// the others.
export function listRuns(resultsDir: string): RunManifest[] {
  if (!existsSync(resultsDir)) return []
  // A start time that does not parse (a hand-edited file) sorts oldest.
  const at = (m: RunManifest) => {
    const t = Date.parse(m.started_at)
    return Number.isFinite(t) ? t : -Infinity
  }
  return readdirSync(resultsDir)
    .filter(d => RUN_ID.test(d))
    .flatMap(d => {
      const m = parse<RunManifest>(join(resultsDir, d, 'run.json'))
      return whole(m) ? [m] : []
    })
    .sort((a, b) => at(b) - at(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

// A torn last line (the process killed mid-append) is skipped, as the
// transcript reader skips one.
export function readEvents(resultsDir: string, id: string): RunEvent[] {
  readRun(resultsDir, id)
  const path = join(resultsDir, id, 'events.jsonl')
  if (!existsSync(path)) return []
  const out: RunEvent[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    try {
      out.push(JSON.parse(line) as RunEvent)
    } catch {
      // torn line
    }
  }
  return out
}

export function readTrials(resultsDir: string, id: string): TrialRecord[] {
  readRun(resultsDir, id)
  const out: TrialRecord[] = []
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.attempts') continue
      const path = join(dir, e.name)
      if (e.isDirectory()) walk(path)
      else if (e.name === 'trial.json') {
        const record = parse<TrialRecord>(path)
        if (record) out.push(record) // a torn record is skipped, as listRuns skips one
      }
    }
  }
  walk(join(resultsDir, id, 'trials'))
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

// case id -> config -> the verdict from the newest run that settled it. A
// cancelled run's settled verdicts count: those cases did finish. A run whose
// verdicts cannot be read is skipped, so one bad run cannot hide the others.
export function latestVerdicts(resultsDir: string): Map<string, Map<string, VerdictKind>> {
  const out = new Map<string, Map<string, VerdictKind>>()
  for (const m of listRuns(resultsDir)) {
    if (m.status !== 'finished' && m.status !== 'cancelled') continue
    let verdicts: Verdict[]
    try {
      verdicts = readRun(resultsDir, m.id).verdicts
    } catch {
      continue
    }
    for (const v of verdicts) {
      const byConfig = out.get(v.case) ?? new Map<string, VerdictKind>()
      if (!byConfig.has(v.config)) byConfig.set(v.config, v.verdict)
      out.set(v.case, byConfig)
    }
  }
  return out
}

// ── baselines ────────────────────────────────────────────────────────────────

// Beside the runs directory: .litmus/baselines.json for .litmus/runs.
export const baselinesFile = (resultsDir: string) => join(dirname(resultsDir), 'baselines.json')

export function baselines(resultsDir: string): Record<string, string> {
  const f = baselinesFile(resultsDir)
  if (!existsSync(f)) return {}
  const all = parse<Record<string, string>>(f)
  if (all === undefined || typeof all !== 'object' || all === null || Array.isArray(all)) throw new ConfigError(`${f} is not a JSON object of baseline names; fix it or remove it`)
  return all
}

// NAME, so `baseline:<name>[:<config>]` parses: a ':' in a name would be read
// as the config.
export function setBaseline(resultsDir: string, name: string, runId: string): void {
  if (!NAME.test(name)) throw new ConfigError(`baseline name "${name}" must match ${NAME} (lowercase, digits, . _ -)`)
  // A cancelled or failed run holds only some of its cases; as a baseline it
  // would quietly shrink every comparison against it.
  const { status } = readRun(resultsDir, runId).manifest
  if (status !== 'finished') throw new ConfigError(`run ${runId} is ${status}; only a finished run can be a baseline`)
  const all = { ...baselines(resultsDir), [name]: runId }
  mkdirSync(dirname(baselinesFile(resultsDir)), { recursive: true })
  writeAtomic(baselinesFile(resultsDir), `${JSON.stringify(all, null, 2)}\n`)
}

export function baselineRun(resultsDir: string, name: string): string {
  const all = baselines(resultsDir)
  const id = Object.hasOwn(all, name) ? all[name] : undefined
  if (!id) throw new ConfigError(`no baseline named "${name}" (have: ${Object.keys(all).join(', ') || 'none'})`)
  return id
}
