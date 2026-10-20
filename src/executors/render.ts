import { readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { ConfigError } from '../core/errors.ts'
import { walk } from '../sandbox/snapshot.ts'

// {{fixture}}, {{diff}} and {{file:<path>}} (docs/ARCHITECTURE.md § Executor).
// Line numbers are part of the render because findings cite lines: a model
// that has to count lines itself gets them wrong, and review-match then
// scores a correct finding as a miss.
export function renderPrompt(template: string, workdir: string, changePatch?: string): string {
  return template.replace(/\{\{\s*(fixture|diff|file:([^}]+?))\s*\}\}/g, (_all, what: string, path?: string) => render(what, workdir, changePatch, path))
}

function render(what: string, workdir: string, changePatch: string | undefined, path: string | undefined): string {
  if (what === 'fixture') return [...walk(workdir)].map(f => numbered(relative(workdir, f).split(sep).join('/'), f)).join('\n')
  if (what === 'diff') return changePatch ? readFileSync(changePatch, 'utf8') : ''
  const abs = resolve(workdir, path!.trim())
  // A template may only name files inside the workdir; "../truth.yaml" is
  // exactly the leak the sandbox exists to prevent. Either mistake is the
  // case author's, so it is a config error, not a crash.
  if (abs !== workdir && !abs.startsWith(workdir + sep)) throw new ConfigError(`{{file:${path}}} points outside the workdir`)
  try {
    return numbered(path!.trim(), abs)
  } catch (e) {
    throw new ConfigError(`{{file:${path}}}: ${(e as Error).message}`)
  }
}

function numbered(name: string, path: string): string {
  const data = readFileSync(path)
  if (data.includes(0)) return `=== ${name} === (binary, ${data.length} bytes)\n`
  const lines = data.toString('utf8').replace(/\n$/, '').split('\n')
  const width = String(lines.length).length
  return `=== ${name} ===\n${lines.map((l, i) => `${String(i + 1).padStart(width)} | ${l}`).join('\n')}\n`
}

// The last ```json fence is the answer, because models reason first and answer
// last; with no fence, the whole response if it is one JSON object. An earlier
// fence is never fallen back to: it is a draft, or an example echoed from the
// prompt ("pass": true), and a broken final answer is no answer. The fence
// closes at a ``` that starts a line, at any indent and whatever follows it:
// JSON cannot hold a raw newline inside a string, so a code block quoted in a
// finding's fix or a judge's rationale never ends it early. If that slice is
// not an object, a ``` right after a } closes it instead (`{...}```), first
// the earliest and then the last, unless a " follows it on its line; one
// inside a string leaves the slice unterminated. At most three parses, so the scan stays linear. Anything else
// is no object at all, and the graders decide what that means.
const OPENER = /```json[ \t]*\r?\n/g
// After \n only: JSON may hold a raw U+2028 or U+2029 in a string, and ^ with
// the m flag would start a line there.
const CLOSER = /(?<![^\n])[ \t]*```/g

// Where the answer starts: just after the last opener, or -1 with no fence.
export function answerStart(text: string): number {
  const last = [...text.matchAll(OPENER)].at(-1)
  return last ? last.index + last[0].length : -1
}

export function extractJson(text: string): Record<string, unknown> | undefined {
  const start = answerStart(text)
  if (start < 0) return jsonObject(text.trim())
  CLOSER.lastIndex = start
  const line = CLOSER.exec(text)
  const fenced = line ? jsonObject(text.slice(start, line.index)) : undefined
  if (fenced) return fenced
  // A " later on the closer's line means the ``` sat inside a string the
  // reply failed to quote, and a prefix ending there could be planted text.
  const closes = (i: number) => {
    const end = text.indexOf('\n', i)
    return !text.slice(i + 4, end < 0 ? undefined : end).includes('"')
  }
  const first = text.indexOf('}```', start)
  if (first < 0) return undefined
  const last = text.lastIndexOf('}```')
  const at = [first, ...(last > first ? [last] : [])].filter(closes)
  for (const i of at) {
    const v = jsonObject(text.slice(start, i + 1))
    if (v) return v
  }
  return undefined
}

function jsonObject(s: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(s)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined // not JSON
  }
}
