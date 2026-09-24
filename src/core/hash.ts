import { createHash } from 'node:crypto'

export function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

// Keys sorted at every depth, so two configs that differ only in key order hash
// the same. Judges and extractors are identified by this hash; an unstable one
// would make every comparison across runs refuse as "judge changed".
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

export function hashJson(value: unknown): string {
  return sha256(stableStringify(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = sortKeys(v)
    }
    return out
  }
  return value
}
