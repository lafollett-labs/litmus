import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, posix } from 'node:path'
import { ConfigError } from '../core/errors.ts'
import type { TranscriptEntry } from '../core/types.ts'
import { readRegular } from '../sandbox/snapshot.ts'
import type { TrialResult } from './types.ts'

// What every grader reads, and the rule they share: anything missing is a
// failed grade with a reason, never a throw and never a pass. An eval tool that
// treats "no findings file" as "no findings" passes every clean case for free.

export function normPath(p: string): string {
  const n = posix.normalize(p.replaceAll('\\', '/'))
  return n.startsWith('./') ? n.slice(2) : n
}

// Far past anything a review or a findings file needs, and short of the
// string length a utf8 read would throw on.
export const ARTIFACT_MAX_BYTES = 64 << 20

// An artifact by name, as long as its file is really there: a regular file,
// read without following a link or blocking on a FIFO (a subject with a shell
// may still be running), and not too large to read.
export function readArtifact(trial: TrialResult, name: string): { name: string; path: string; text: string } | undefined {
  const want = normPath(name)
  const key = Object.keys(trial.artifacts).find(k => k === name || normPath(k) === want)
  const path = key === undefined ? undefined : trial.artifacts[key]
  if (key === undefined || path === undefined) return undefined
  const size = lstatSync(path, { throwIfNoEntry: false })?.size
  if (size === undefined || size > ARTIFACT_MAX_BYTES) return undefined
  const data = readRegular(path)
  return data === undefined ? undefined : { name: key, path, text: data.toString('utf8') }
}

// A torn last line (a process killed mid-write) is skipped rather than failing
// the whole transcript; a missing transcript is undefined, never "no entries".
export function readTranscript(path: string): TranscriptEntry[] | undefined {
  if (!existsSync(path)) return undefined
  const entries: TranscriptEntry[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line) as TranscriptEntry)
    } catch {
      // torn line: skip
    }
  }
  return entries
}

// What the subject wrote: assistant messages and tool calls (name and input).
// System and user messages are litmus's own input, and tool results are the
// environment's: a Read result is the fixture, so a pattern in the fixture
// would match every harness trial that opened the file, and none on the model
// executor, where the fixture sits in the prompt.
export function subjectText(entries: TranscriptEntry[]): string {
  const parts: string[] = []
  for (const e of entries) {
    if (e.kind === 'message' && e.role === 'assistant') parts.push(e.text)
    else if (e.kind === 'tool_call') parts.push(`${e.tool} ${JSON.stringify(e.input)}`)
  }
  return parts.join('\n')
}

// The whole session, labelled, for a judge that needs to know what was asked.
export function renderTranscript(entries: TranscriptEntry[]): string {
  const lines: string[] = []
  for (const e of entries) {
    if (e.kind === 'message') lines.push(`[${e.role}]\n${e.text}`)
    else if (e.kind === 'tool_call') lines.push(`[tool_call ${e.tool}] ${JSON.stringify(e.input)}`)
    else if (e.kind === 'tool_result') lines.push(`[tool_result${e.is_error ? ' error' : ''}]\n${e.text}`)
    else if (e.kind === 'denied') lines.push(`[denied ${e.tool}] ${e.reason}`)
  }
  return lines.join('\n\n')
}

// A case-relative path that must stay inside the directory it is joined to.
// Rejected outright rather than normalized: "a/../../b" is a typo at best.
export function relativeInside(p: string, what: string): string {
  const n = p.replaceAll('\\', '/')
  if (isAbsolute(n) || n.split('/').includes('..')) throw new ConfigError(`${what} "${p}" must be a relative path with no ".." segments`)
  return normPath(n)
}

// min defaults to 1 so an unset bound can never pass on zero; the schema
// refuses a lone max below that default (max: 0 needs an explicit min: 0).
export function countCheck(n: number, spec: { min?: number | undefined; max?: number | undefined }): { pass: boolean; want: string } {
  const min = spec.min ?? 1
  const max = spec.max
  const want = max === undefined ? `at least ${min}` : min === max ? `exactly ${min}` : `${min} to ${max}`
  return { pass: n >= min && (max === undefined || n <= max), want }
}
