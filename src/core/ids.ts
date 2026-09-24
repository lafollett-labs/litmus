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
  if (!Number.isSafeInteger(ref.trial) || ref.trial < 1) throw new RangeError(`trial must be a positive safe integer, got ${ref.trial}`)
  return `${ref.suite}/${ref.case}@${ref.config}#${ref.trial}`
}

// Built from NAME, so the two grammars cannot drift apart.
const SEG = NAME.source.slice(1, -1)
const TRIAL_KEY = new RegExp(`^(${SEG})/(${SEG})@(${SEG})#([1-9][0-9]*)$`)

// The run-id grammar, for the store and the server to check ids against.
export const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-f]{4}$/

export function parseTrialKey(key: string): TrialRef | undefined {
  const m = TRIAL_KEY.exec(key)
  if (!m) return undefined
  // The grammar admits any digit string; past 2^53 Number() rounds, and the
  // ref would name a different trial than the key.
  const trial = Number(m[4])
  if (!Number.isSafeInteger(trial)) return undefined
  return { suite: m[1]!, case: m[2]!, config: m[3]!, trial }
}

// 2026-09-24T15-04-05Z-a1b2: sorts chronologically to the second as a plain
// string (the suffix orders runs started in the same second at random), and is
// a valid directory name on every OS (no colons).
export function runId(now: Date = new Date(), suffix: string = randomBytes(2).toString('hex')): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-')
  return `${stamp}-${suffix}`
}
