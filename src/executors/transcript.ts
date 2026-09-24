import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Redactor } from '../core/redact.ts'
import type { RunEvent, TranscriptEntry, Usage } from '../core/types.ts'

// Appends transcript.jsonl and mirrors each entry as a trial.step event, so the
// UI's live timeline and the stored transcript can never disagree. Both are
// redacted here, where they are produced: a subject with a shell can echo a key.
export class Transcript {
  readonly path: string
  readonly #key: string
  readonly #emit: (e: RunEvent) => void
  readonly #redact: Redactor
  readonly #t0 = Date.now()

  constructor(path: string, key: string, emit: (e: RunEvent) => void, redact: Redactor) {
    this.path = path
    this.#key = key
    this.#emit = emit
    this.#redact = redact
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, '')
  }

  message(role: 'system' | 'user' | 'assistant', text: string): void {
    this.#write({ t: this.#t(), kind: 'message', role, text })
    if (role === 'assistant') this.#step('message', text)
  }

  toolCall(id: string, tool: string, input: unknown): void {
    // Redacted before it is stringified: JSON escaping would hide a value holding " or \ from a text match.
    const safe = this.#redact.json(input)
    this.#write({ t: this.#t(), kind: 'tool_call', id, tool, input: safe })
    this.#step('tool_call', `${tool} ${JSON.stringify(safe)}`)
  }

  toolResult(id: string, text: string, isError: boolean): void {
    this.#write({ t: this.#t(), kind: 'tool_result', id, text, is_error: isError })
    this.#step('tool_result', text)
  }

  denied(tool: string, reason: string): void {
    this.#write({ t: this.#t(), kind: 'denied', tool, reason })
    this.#step('denied', `${tool}: ${reason}`)
  }

  usage(usage: Usage): void {
    this.#write({ t: this.#t(), kind: 'usage', usage })
    this.#emit({ type: 'trial.usage', key: this.#key, usage })
  }

  #t = () => Date.now() - this.#t0
  #write = (e: TranscriptEntry) => appendFileSync(this.path, `${JSON.stringify(this.#redact.json(e))}\n`)
  // Redacted before it is cut: a cut through a key would leave half of it.
  #step = (kind: 'message' | 'tool_call' | 'tool_result' | 'denied', raw: string) => {
    const text = this.#redact.text(raw)
    this.#emit({ type: 'trial.step', key: this.#key, step: { kind, summary: text.length > 200 ? `${text.slice(0, 197)}...` : text } })
  }
}
