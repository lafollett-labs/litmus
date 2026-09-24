import { lstatSync, readFileSync, readdirSync, realpathSync, statSync, type Stats } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parse } from 'yaml'
import type { z } from 'zod'
import { CREDENTIAL_KEY, CREDENTIAL_VARS } from '../core/credentials.ts'
import { ConfigError } from '../core/errors.ts'
import { sha256 } from '../core/hash.ts'
import { caseId } from '../core/ids.ts'
import { BUILTIN_SCHEMAS, CaseFile, ConfigFile, SuiteFile, TruthFile } from './schema.ts'
import { hashTree } from './tree.ts'

// Everything here reads operator-authored files, so every failure is a
// ConfigError (exit 2), never a stack trace (exit 1, which `run` uses for a
// blocking verdict).

export type Config = ConfigFile & { file: string; dir: string; roots: string[]; resultsDir: string }

export type Settings = {
  trials: number
  min_trials?: number // as written (case, then suite); read it through effectiveMinTrials
  policy: 'all' | 'rate'
  threshold: number
  timeout_s: number
  tags: string[]
}

// A file subject is text the model executor can use as its system prompt. A
// directory subject (a plugin, a skill folder) is only a version: the harness
// loads it itself.
export type Subject = { kind: 'file'; path: string; hash: string; content: string } | { kind: 'dir'; path: string; hash: string }

export type LoadedCase = {
  id: string
  suite: string
  name: string
  dir: string
  spec: CaseFile
  settings: Settings
  prompt: string // the resolved prompt text, whichever of prompt / prompt_file the case gave
  plugins: string[] // absolute plugin roots (harness cases); [] otherwise
  fixtureDir?: string
  changePatch?: string
  truth?: TruthFile
  fakeFile?: string
  subject?: Subject
}

export type LoadedSuite = { name: string; dir: string; spec: SuiteFile; cases: LoadedCase[] }

const BUILTIN = { trials: 3, policy: 'all', threshold: 0.8, timeout_s: 600 } as const

// The verdict needs min(min_trials, requested) scored trials, and an unset
// min_trials is half the trials requested this run, rounded up: one trial that
// survived two infra errors is not evidence of PASS (ARCHITECTURE § Flow).
export function effectiveMinTrials(s: Settings, requested: number = s.trials): number {
  return s.min_trials === undefined ? Math.ceil(requested / 2) : Math.min(s.min_trials, requested)
}

export function loadConfig(file: string, env: NodeJS.ProcessEnv = process.env): Config {
  const path = resolve(file)
  if (!stat(path)?.isFile()) throw new ConfigError(`no config at ${path} (pass --config-file, or create litmus.config.yaml)`)
  const spec = parseFile(path, ConfigFile)
  const secrets = new Set([...CREDENTIAL_VARS, ...spec.redact].map(n => env[n]).filter(v => typeof v === 'string' && v !== ''))
  for (const [section, defs] of Object.entries({ configs: spec.configs, judges: spec.judges })) {
    for (const [name, def] of Object.entries(defs)) {
      if ('params' in def && def.params) refuseCredentials(def.params, `${section}.${name}.params`, secrets, path)
    }
  }
  const dir = dirname(path)
  return { ...spec, file: path, dir, roots: spec.suites.map(r => resolve(dir, r)), resultsDir: resolve(dir, spec.results) }
}

// The config and every suite it names, with each case's judge references
// checked against the config's judges: a typo there would otherwise surface
// on every trial, after the executor has been paid.
export function loadProject(file: string, env: NodeJS.ProcessEnv = process.env): { config: Config; suites: LoadedSuite[] } {
  const config = loadConfig(file, env)
  const suites = discoverSuites(config.roots)
  const judges = Object.keys(config.judges)
  for (const c of suites.flatMap(s => s.cases)) {
    const refs = [c.spec.extract?.with, ...c.spec.graders.map(g => (g.kind === 'judge' ? g.judge : g.kind === 'review-match' ? g.confirm : undefined))]
    for (const ref of refs) {
      if (ref !== undefined && !judges.includes(ref)) {
        throw new ConfigError(`${join(c.dir, 'case.yaml')}: judge "${ref}" is not defined in ${config.file} (defined: ${judges.join(', ') || 'none'})`)
      }
    }
  }
  return { config, suites }
}

// params is recorded in run.json, so it must never carry a credential. Keys are
// refused by name at every depth, and any string equal to a live credential
// value is refused wherever it sits.
function refuseCredentials(value: unknown, where: string, secrets: Set<unknown>, file: string): void {
  if (typeof value === 'string' && secrets.has(value)) {
    throw new ConfigError(`${file}: ${where} holds the value of a credential variable; credentials come only from the environment`)
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => refuseCredentials(v, `${where}[${i}]`, secrets, file))
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (CREDENTIAL_KEY.test(k) || k.toLowerCase() === 'headers') {
        throw new ConfigError(`${file}: ${where}.${k} is not allowed; params is for model behaviour, and credentials, auth and headers never go there`)
      }
      refuseCredentials(v, `${where}.${k}`, secrets, file)
    }
  }
}

// Suites are the immediate subdirectories of each root that hold a suite.yaml.
// A name that appears under two roots is an error, not a shadow: a private
// suite silently replacing a public one of the same name is a gate that
// measures something other than what its name says. A root with no suites is
// an error too: a mistyped root path would otherwise run nothing and exit 0.
export function discoverSuites(roots: string[]): LoadedSuite[] {
  const seen = new Map<string, string>()
  const suites: LoadedSuite[] = []
  for (const root of roots) {
    if (!stat(root)?.isDirectory()) throw new ConfigError(`suite root ${root} is not a directory`)
    let found = 0
    for (const dir of entries(root)) {
      if (neverAName(dir) || !dirOrBrokenLink(dir)) continue
      if (!optional(join(dir, 'suite.yaml'), 'file', dir)) {
        if (stat(join(dir, 'suite.yml')) || stat(join(dir, 'cases'))) throw new ConfigError(`${dir} looks like a suite but has no suite.yaml`)
        continue
      }
      const suite = loadSuite(dir)
      const prior = seen.get(suite.name)
      if (prior) throw new ConfigError(`suite "${suite.name}" is defined twice: ${prior} and ${dir}`)
      seen.set(suite.name, dir)
      suites.push(suite)
      found++
    }
    if (found === 0) throw new ConfigError(`suite root ${root} holds no suite (no <dir>/suite.yaml under it)`)
  }
  return suites
}

// Every directory under cases/ is a case, so a case.yml typo is an error rather
// than a case that silently stops running. A name that can never be a case
// name (leading . or _) is skipped, which leaves room for shared files.
export function loadSuite(dir: string): LoadedSuite {
  const spec = parseFile(join(dir, 'suite.yaml'), SuiteFile)
  expectDirName(spec.name, dir, 'suite')
  const casesDir = join(dir, 'cases')
  const cases: LoadedCase[] = []
  for (const d of stat(casesDir)?.isDirectory() ? entries(casesDir) : []) {
    if (neverAName(d) || !dirOrBrokenLink(d)) continue
    if (!stat(join(d, 'case.yaml'))?.isFile()) {
      throw new ConfigError(`${d} has no case.yaml; every directory under cases/ is a case (prefix it with _ to keep other files there)`)
    }
    cases.push(loadCase(spec, d))
  }
  if (cases.length === 0) throw new ConfigError(`suite "${spec.name}" has no cases under ${casesDir}`)
  return { name: spec.name, dir, spec, cases }
}

function loadCase(suite: SuiteFile, dir: string): LoadedCase {
  const file = join(dir, 'case.yaml')
  const spec = parseFile(file, CaseFile)
  expectDirName(spec.name, dir, 'case')
  const d = suite.defaults
  const settings: Settings = {
    trials: spec.trials ?? d.trials ?? BUILTIN.trials,
    policy: spec.policy ?? d.policy ?? BUILTIN.policy,
    threshold: spec.threshold ?? d.threshold ?? BUILTIN.threshold,
    timeout_s: spec.timeout_s ?? d.timeout_s ?? BUILTIN.timeout_s,
    tags: [...new Set([...(d.tags ?? []), ...(spec.tags ?? [])])],
  }
  const minTrials = spec.min_trials ?? d.min_trials
  if (minTrials !== undefined) {
    if (minTrials > settings.trials) throw new ConfigError(`${file}: min_trials (${minTrials}) exceeds trials (${settings.trials})`)
    settings.min_trials = minTrials
  }

  const promptFile = spec.executor.prompt_file === undefined ? undefined : requireFile(resolve(dir, spec.executor.prompt_file), file, 'prompt_file')
  if (promptFile) refuseAnswers(promptFile, file, 'prompt_file')
  const prompt = spec.executor.prompt ?? readBytes(promptFile!, file, 'prompt_file').toString('utf8')
  const plugins = spec.executor.kind === 'harness' ? spec.executor.plugins.map(p => requireDir(resolve(dir, p), file, `plugin ${p}`)) : []
  const loaded: LoadedCase = { id: caseId(suite.name, spec.name), suite: suite.name, name: spec.name, dir, spec, settings, prompt, plugins }

  const fixtureDir = optional(join(dir, 'fixture'), 'dir', file)
  if (fixtureDir) loaded.fixtureDir = fixtureDir
  const changePatch = optional(join(dir, 'change.patch'), 'file', file)
  if (changePatch) loaded.changePatch = changePatch
  const fakeFile = optional(join(dir, 'fake.yaml'), 'file', file)
  if (fakeFile) loaded.fakeFile = fakeFile

  const truthFile = optional(join(dir, 'truth.yaml'), 'file', file)
  if (truthFile) {
    loaded.truth = parseFile(truthFile, TruthFile)
    for (const bug of loaded.truth.bugs) requireFile(resolve(dir, bug.fix), truthFile, `fix for bug "${bug.id}"`)
  }
  for (const g of spec.graders) {
    if (g.kind === 'review-match' && !loaded.truth) throw new ConfigError(`${file}: a review-match grader needs a truth.yaml beside it`)
    if (g.kind === 'json-schema' && g.schema.startsWith('litmus:') && !BUILTIN_SCHEMAS.has(g.schema)) {
      throw new ConfigError(`${file}: unknown built-in schema "${g.schema}" (known: ${[...BUILTIN_SCHEMAS].join(', ')})`)
    }
    if (g.kind === 'json-schema' && !g.schema.startsWith('litmus:')) requireFile(resolve(dir, g.schema), file, `schema ${g.schema}`)
  }

  if (spec.subject) loaded.subject = loadSubject(resolve(dir, spec.subject), spec, file)
  return loaded
}

// A subject is named by its real location: a link as the subject itself would
// let the path in case.yaml name one thing while the hash covers another.
function loadSubject(path: string, spec: CaseFile, file: string): Subject {
  if (fsCall(path, () => lstatSync(path, { throwIfNoEntry: false }))?.isSymbolicLink()) {
    throw new ConfigError(`${file}: subject ${path} is a symlink; name the file or directory it points at`)
  }
  const st = stat(path)
  if (!st) throw new ConfigError(`${file}: subject not found at ${path}`)
  if (st.isDirectory()) {
    if (spec.executor.kind === 'model') {
      throw new ConfigError(`${file}: a model case's subject is its system prompt, so it must be a file; ${path} is a directory`)
    }
    return { kind: 'dir', path, hash: fsCall(path, () => hashTree(path)) }
  }
  refuseAnswers(path, file, 'subject')
  const bytes = readBytes(path, file, 'subject')
  return { kind: 'file', path, hash: sha256(bytes), content: bytes.toString('utf8') }
}

// case.yaml, truth.yaml, fake.yaml, fix/ and proof/ are a case's answers (a
// case.yaml names the seeded bug and holds the graders). A prompt_file or
// subject that resolves to one of them, in this case or any other, hands the
// answers to the model under test. The real path is checked as well as the
// written one, so neither a symlink nor a case-insensitive filesystem gets
// around it (the real path carries the on-disk case).
function refuseAnswers(path: string, from: string, what: string): void {
  const isCase = (d: string) => stat(join(d, 'case.yaml'))?.isFile() === true
  const isAnswer = (p: string): boolean => {
    const name = basename(p)
    if ((name === 'case.yaml' || name === 'truth.yaml' || name === 'fake.yaml') && isCase(dirname(p))) return true
    for (let d = dirname(p); dirname(d) !== d; d = dirname(d)) {
      if ((basename(d) === 'fix' || basename(d) === 'proof') && isCase(dirname(d))) return true
    }
    return false
  }
  const written = isAnswer(path)
  const real = fsCall(path, () => realpathSync.native(path))
  if (written || isAnswer(real)) {
    const via = written ? '' : ` (real path ${real})` // name the target when only a link led there
    throw new ConfigError(`${from}: ${what} ${path}${via} is a case's ground truth, which never reaches the subject`)
  }
}

// Absent is fine; present as the wrong type, or as a dangling link, is an
// error, not an absence: a case whose fixture link broke would otherwise run
// against an empty workdir and read as the model's failure.
function optional(path: string, kind: 'file' | 'dir', from: string): string | undefined {
  if (!fsCall(path, () => lstatSync(path, { throwIfNoEntry: false }))) return undefined
  if (!stat(path)) throw new ConfigError(`${from}: ${basename(path)} at ${path} is a broken symlink`)
  return kind === 'dir' ? requireDir(path, from, basename(path)) : requireFile(path, from, basename(path))
}

function parseFile<S extends z.ZodType>(file: string, schema: S): z.infer<S> {
  const text = readBytes(file, file, 'file').toString('utf8')
  let raw: unknown
  try {
    raw = parse(text)
  } catch (e) {
    throw new ConfigError(`${file}: not valid YAML: ${(e as Error).message}`)
  }
  refuseCycles(raw, file)
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map(i => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new ConfigError(`${file}:\n${issues}`)
  }
  return result.data
}

// yaml builds `&a { self: *a }` into a circular object, which every walk after
// this (the params check, hashing, run.json) would recurse into forever.
function refuseCycles(value: unknown, file: string, ancestors = new Set<object>()): void {
  if (value === null || typeof value !== 'object') return
  if (ancestors.has(value)) throw new ConfigError(`${file}: a YAML alias refers to itself`)
  ancestors.add(value)
  for (const v of Object.values(value)) refuseCycles(v, file, ancestors)
  ancestors.delete(value)
}

function readBytes(path: string, from: string, what: string): Buffer {
  requireFile(path, from, what)
  return fsCall(path, () => readFileSync(path))
}

function requireFile(path: string, from: string, what: string): string {
  const st = stat(path)
  if (!st) throw new ConfigError(`${from}: ${what} not found at ${path}`)
  if (!st.isFile()) throw new ConfigError(`${from}: ${what} at ${path} is not a file`)
  return path
}

function requireDir(path: string, from: string, what: string): string {
  if (!stat(path)?.isDirectory()) throw new ConfigError(`${from}: ${what} is not a directory at ${path}`)
  return path
}

function expectDirName(name: string, dir: string, kind: string): void {
  if (basename(dir) !== name) {
    throw new ConfigError(`${kind} "${name}" lives in ${dir}; its directory must be named "${name}"`)
  }
}

// NAME starts alphanumeric, so a . or _ entry is never a suite or case: shared
// files, editor lock links (.#file), caches.
function neverAName(path: string): boolean {
  return /^[._]/.test(basename(path))
}

// A dangling symlink under a root or cases/ is refused, not skipped: skipping
// it would quietly drop whatever it used to point at.
function dirOrBrokenLink(path: string): boolean {
  const st = stat(path)
  if (!st) throw new ConfigError(`${path} is a broken symlink`)
  return st.isDirectory()
}

function entries(dir: string): string[] {
  return fsCall(dir, () => readdirSync(dir).sort()).map(n => join(dir, n))
}

function stat(path: string): Stats | undefined {
  return fsCall(path, () => statSync(path, { throwIfNoEntry: false }))
}

function fsCall<T>(path: string, fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof ConfigError) throw e
    throw new ConfigError(`cannot read ${path}: ${(e as Error).message}`)
  }
}
