import { randomBytes } from 'node:crypto'
import { ConfigError } from './errors.ts'

// Suite, case and config names share one alphabet. It excludes '/', '@' and '#',
// which delimit a trial key, and it starts alphanumeric so a name never parses
// as a flag or a relative path.
export const NAME = /^[a-z0-9][a-z0-9._-]*$/

export type TrialRef = { suite: string; case: string; config: string; trial: number }

export function assertName(kind: string, name: string): string {
  if (!NAME.test(name)) {
    throw new ConfigError(`${kind} name "${name}" must match ${NAME} (lowercase, digits, . _ -)`)
  }
  return name
}

export function caseId(suite: string, name: string): string {
  return `${suite}/${name}`
}

export function trialKey(ref: TrialRef): string {
  return `${ref.suite}/${ref.case}@${ref.config}#${ref.trial}`
}

const TRIAL_KEY = /^([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)@([a-z0-9][a-z0-9._-]*)#([1-9][0-9]*)$/

export function parseTrialKey(key: string): TrialRef | undefined {
  const m = TRIAL_KEY.exec(key)
  if (!m) return undefined
  return { suite: m[1]!, case: m[2]!, config: m[3]!, trial: Number(m[4]) }
}

// 2026-09-24T15-04-05Z-a1b2: sorts chronologically as a plain string, and is a
// valid directory name on every OS (no colons).
export function runId(now: Date = new Date(), suffix: string = randomBytes(2).toString('hex')): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-')
  return `${stamp}-${suffix}`
}
