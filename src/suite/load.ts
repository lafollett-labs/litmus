import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parse } from 'yaml'
import type { z } from 'zod'
import { ConfigError } from '../core/errors.ts'
import { sha256 } from '../core/hash.ts'
import { caseId } from '../core/ids.ts'
import { CaseFile, ConfigFile, SuiteFile, TruthFile } from './schema.ts'

export type Config = ConfigFile & { file: string; dir: string; roots: string[]; resultsDir: string }

export type Settings = {
  trials: number
  min_trials: number
  policy: 'all' | 'rate'
  threshold: number
  timeout_s: number
  tags: string[]
}

export type LoadedCase = {
  id: string
  suite: string
  name: string
  dir: string
  spec: CaseFile
  settings: Settings
  prompt: string // the resolved prompt text, whichever of prompt / prompt_file the case gave
  fixtureDir?: string
  changePatch?: string
  truth?: TruthFile
  fakeFile?: string
  subject?: { path: string; hash: string; content: string }
}

export type LoadedSuite = { name: string; dir: string; spec: SuiteFile; cases: LoadedCase[] }

const BUILTIN = { trials: 3, policy: 'all', threshold: 0.8, timeout_s: 600 } as const

export function loadConfig(file: string): Config {
  const path = resolve(file)
  if (!existsSync(path)) throw new ConfigError(`no config at ${path} (pass --config, or create litmus.config.yaml)`)
  const spec = parseFile(path, ConfigFile)
  const dir = dirname(path)
  return { ...spec, file: path, dir, roots: spec.suites.map(r => resolve(dir, r)), resultsDir: resolve(dir, spec.results) }
}

// Suites are the immediate subdirectories of each root that hold a suite.yaml.
// A name that appears under two roots is an error, not a shadow: a private
// suite silently replacing a public one of the same name is a gate that
// measures something other than what its name says.
export function discoverSuites(roots: string[]): LoadedSuite[] {
  const seen = new Map<string, string>()
  const suites: LoadedSuite[] = []
  for (const root of roots) {
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new ConfigError(`suite root ${root} is not a directory`)
    for (const entry of readdirSync(root).sort()) {
      const dir = join(root, entry)
      if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'suite.yaml'))) continue
      const suite = loadSuite(dir)
      const prior = seen.get(suite.name)
      if (prior) throw new ConfigError(`suite "${suite.name}" is defined twice: ${prior} and ${dir}`)
      seen.set(suite.name, dir)
      suites.push(suite)
    }
  }
  return suites
}

export function loadSuite(dir: string): LoadedSuite {
  const spec = parseFile(join(dir, 'suite.yaml'), SuiteFile)
  expectDirName(spec.name, dir, 'suite')
  const casesDir = join(dir, 'cases')
  const names = existsSync(casesDir) ? readdirSync(casesDir).sort() : []
  const cases = names
    .map(n => join(casesDir, n))
    .filter(d => statSync(d).isDirectory() && existsSync(join(d, 'case.yaml')))
    .map(d => loadCase(spec, d))
  if (cases.length === 0) throw new ConfigError(`suite "${spec.name}" has no cases under ${casesDir}`)
  return { name: spec.name, dir, spec, cases }
}

function loadCase(suite: SuiteFile, dir: string): LoadedCase {
  const file = join(dir, 'case.yaml')
  const spec = parseFile(file, CaseFile)
  expectDirName(spec.name, dir, 'case')
  const d = suite.defaults
  const trials = spec.trials ?? d.trials ?? BUILTIN.trials
  const settings: Settings = {
    trials,
    // Half the trials, rounded up, must score before a verdict counts: one
    // trial that survived two infra errors is not evidence of PASS.
    min_trials: spec.min_trials ?? d.min_trials ?? Math.ceil(trials / 2),
    policy: spec.policy ?? d.policy ?? BUILTIN.policy,
    threshold: spec.threshold ?? d.threshold ?? BUILTIN.threshold,
    timeout_s: spec.timeout_s ?? d.timeout_s ?? BUILTIN.timeout_s,
    tags: [...new Set([...(d.tags ?? []), ...(spec.tags ?? [])])],
  }
  if (settings.min_trials > settings.trials) {
    throw new ConfigError(`${file}: min_trials (${settings.min_trials}) exceeds trials (${settings.trials})`)
  }

  const prompt = spec.executor.prompt ?? readRequired(resolve(dir, spec.executor.prompt_file!), file, 'prompt_file')
  const loaded: LoadedCase = { id: caseId(suite.name, spec.name), suite: suite.name, name: spec.name, dir, spec, settings, prompt }

  const fixtureDir = join(dir, 'fixture')
  if (existsSync(fixtureDir)) loaded.fixtureDir = fixtureDir
  const changePatch = join(dir, 'change.patch')
  if (existsSync(changePatch)) loaded.changePatch = changePatch
  const fakeFile = join(dir, 'fake.yaml')
  if (existsSync(fakeFile)) loaded.fakeFile = fakeFile

  const truthFile = join(dir, 'truth.yaml')
  if (existsSync(truthFile)) {
    loaded.truth = parseFile(truthFile, TruthFile)
    for (const bug of loaded.truth.bugs) {
      readRequired(resolve(dir, bug.fix), truthFile, `fix for bug "${bug.id}"`)
    }
  }
  if (spec.graders.some(g => g.kind === 'review-match') && !loaded.truth) {
    throw new ConfigError(`${file}: a review-match grader needs a truth.yaml beside it`)
  }

  if (spec.subject) {
    const path = resolve(dir, spec.subject)
    const content = readRequired(path, file, 'subject')
    loaded.subject = { path, hash: sha256(content), content }
  }
  return loaded
}

function parseFile<S extends z.ZodType>(file: string, schema: S): z.infer<S> {
  if (!existsSync(file)) throw new ConfigError(`missing ${file}`)
  let raw: unknown
  try {
    raw = parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new ConfigError(`${file}: not valid YAML: ${(e as Error).message}`)
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map(i => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new ConfigError(`${file}:\n${issues}`)
  }
  return result.data
}

function readRequired(path: string, from: string, what: string): string {
  if (!existsSync(path)) throw new ConfigError(`${from}: ${what} not found at ${path}`)
  return readFileSync(path, 'utf8')
}

function expectDirName(name: string, dir: string, kind: string): void {
  if (basename(dir) !== name) {
    throw new ConfigError(`${kind} "${name}" lives in ${dir}; its directory must be named "${name}"`)
  }
}
