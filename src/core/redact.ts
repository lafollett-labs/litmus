import { CREDENTIAL_VARS } from './credentials.ts'

export const REDACTED = '[REDACTED]'

export type Redactor = {
  text(s: string): string
  bytes(b: Buffer): Buffer
  json<T>(v: T): T
}

// The values redaction scrubs: each credential variable, and each name the
// config lists under `redact`, that is set to something non-empty.
export function secretValues(redact: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([...CREDENTIAL_VARS, ...redact].map(n => env[n]).filter((v): v is string => typeof v === 'string' && v !== ''))]
}

// Redaction by value (docs/ARCHITECTURE.md § Redaction). Longest first, so a
// value that contains another is replaced whole, not in part.
export function redactor(values: Iterable<string>): Redactor {
  const secrets = [...new Set(values)].filter(v => v !== '').sort((a, b) => b.length - a.length)
  const text = (s: string) => secrets.reduce((t, v) => t.replaceAll(v, REDACTED), s)
  // latin1 maps each byte to one char, so replacing a value's UTF-8 bytes
  // this way is byte-exact and leaves the rest of a binary file as it was.
  const raw = secrets.map(v => Buffer.from(v, 'utf8').toString('latin1'))
  const bytes = (b: Buffer) => {
    const s = b.toString('latin1')
    const r = raw.reduce((t, v) => t.replaceAll(v, REDACTED), s)
    return r === s ? b : Buffer.from(r, 'latin1')
  }
  // Keys too: a subject can name a file, or a JSON field, after a key.
  const walk = (v: unknown): unknown =>
    typeof v === 'string'
      ? text(v)
      : Array.isArray(v)
        ? v.map(walk)
        : v !== null && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), walk(x)]))
          : v
  return { text, bytes, json: <T>(v: T) => walk(v) as T }
}
