import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ConfigError } from '../core/errors.ts'
import { parseTrialKey, RUN_ID, type TrialRef } from '../core/ids.ts'
import type { Redactor } from '../core/redact.ts'
import type { Comparison, RunEvent, TrialRecord, Verdict } from '../core/types.ts'
import type { ConfigDef } from '../suite/schema.ts'

export type RunManifest = {
  id: string
  parent?: string
  status: 'running' | 'finished' | 'cancelled'
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
    if (existsSync(dir)) throw new ConfigError(`run ${manifest.id} already exists`)
    mkdirSync(join(dir, 'trials'), { recursive: true })
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
    writeFileSync(join(dir, 'trial.json'), `${JSON.stringify(this.#redact.json(record), null, 2)}\n`)
  }

  verdicts(v: Verdict[]): void {
    this.#writeJson('verdicts.json', v)
  }

  comparisons(c: Comparison[]): void {
    if (c.length) this.#writeJson('comparison.json', c)
  }

  finish(status: 'finished' | 'cancelled', at: Date = new Date()): RunManifest {
    this.#manifest = { ...this.#manifest, status, finished_at: at.toISOString() }
    this.#writeJson('run.json', this.#manifest)
    return this.#manifest
  }

  #writeJson(name: string, value: unknown): void {
    writeFileSync(join(this.dir, name), `${JSON.stringify(this.#redact.json(value), null, 2)}\n`)
  }
}

// ── readers ──────────────────────────────────────────────────────────────────

export function readRun(resultsDir: string, id: string): StoredRun {
  if (!RUN_ID.test(id)) throw new ConfigError(`"${id}" is not a run id`)
  const dir = join(resultsDir, id)
  if (!existsSync(join(dir, 'run.json'))) throw new ConfigError(`no run ${id} under ${resultsDir}`)
  const read = <T>(name: string, fallback: T): T => (existsSync(join(dir, name)) ? (JSON.parse(readFileSync(join(dir, name), 'utf8')) as T) : fallback)
  return { manifest: read<RunManifest>('run.json', undefined as never), verdicts: read<Verdict[]>('verdicts.json', []), comparisons: read<Comparison[]>('comparison.json', []) }
}

// Newest first: run ids sort chronologically as strings by construction.
export function listRuns(resultsDir: string): RunManifest[] {
  if (!existsSync(resultsDir)) return []
  return readdirSync(resultsDir)
    .filter(d => RUN_ID.test(d) && existsSync(join(resultsDir, d, 'run.json')))
    .sort()
    .reverse()
    .map(d => JSON.parse(readFileSync(join(resultsDir, d, 'run.json'), 'utf8')) as RunManifest)
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
      else if (e.name === 'trial.json') out.push(JSON.parse(readFileSync(path, 'utf8')) as TrialRecord)
    }
  }
  walk(join(resultsDir, id, 'trials'))
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

// ── baselines ────────────────────────────────────────────────────────────────

// Beside the runs directory: .litmus/baselines.json for .litmus/runs.
const baselinesFile = (resultsDir: string) => join(dirname(resultsDir), 'baselines.json')

export function baselines(resultsDir: string): Record<string, string> {
  const f = baselinesFile(resultsDir)
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Record<string, string>) : {}
}

export function setBaseline(resultsDir: string, name: string, runId: string): void {
  readRun(resultsDir, runId)
  const all = { ...baselines(resultsDir), [name]: runId }
  mkdirSync(dirname(baselinesFile(resultsDir)), { recursive: true })
  writeFileSync(baselinesFile(resultsDir), `${JSON.stringify(all, null, 2)}\n`)
}

export function baselineRun(resultsDir: string, name: string): string {
  const all = baselines(resultsDir)
  const id = Object.hasOwn(all, name) ? all[name] : undefined
  if (!id) throw new ConfigError(`no baseline named "${name}" (have: ${Object.keys(all).join(', ') || 'none'})`)
  return id
}
