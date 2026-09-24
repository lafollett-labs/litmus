import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, posix } from 'node:path'
import { ConfigError } from '../core/errors.ts'
import type { TranscriptEntry } from '../core/types.ts'
import type { TrialResult } from './types.ts'

// What every grader reads, and the rule they share: anything missing is a
// failed grade with a reason, never a throw and never a pass. An eval tool that
// treats "no findings file" as "no findings" passes every clean case for free.

export function normPath(p: string): string {
  const n = posix.normalize(p.replaceAll('\\', '/'))
  return n.startsWith('./') ? n.slice(2) : n
}

// An artifact by name, as long as its file is really there.
export function readArtifact(trial: TrialResult, name: string): { name: string; path: string; text: string } | undefined {
  const want = normPath(name)
  const key = Object.keys(trial.artifacts).find(k => k === name || normPath(k) === want)
  const path = key === undefined ? undefined : trial.artifacts[key]
  if (key === undefined || path === undefined || !existsSync(path) || !statSync(path).isFile()) return undefined
  return { name: key, path, text: readFileSync(path, 'utf8') }
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

// What the subject did: assistant messages, tool calls (name and input) and
// tool results. System and user messages are litmus's own input; a pattern
// that appears in the prompt or the fixture it renders would match every trial.
export function subjectText(entries: TranscriptEntry[]): string {
  const parts: string[] = []
  for (const e of entries) {
    if (e.kind === 'message' && e.role === 'assistant') parts.push(e.text)
    else if (e.kind === 'tool_call') parts.push(`${e.tool} ${JSON.stringify(e.input)}`)
    else if (e.kind === 'tool_result') parts.push(e.text)
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
