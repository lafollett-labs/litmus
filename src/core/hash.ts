import { createHash } from 'node:crypto'

export function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

// Keys sorted at every depth, so two configs that differ only in key order hash
// the same. Judges and extractors are identified by this hash; an unstable one
// would make every comparison across runs refuse as "judge changed", and a
// collision would let results from different judges be compared silently.
// So anything JSON would quietly mangle (a Date, a Map, NaN, a __proto__ key,
// a sparse array, a symbol key) is refused rather than hashed.
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

export function hashJson(value: unknown): string {
  return sha256(stableStringify(value))
}

function sortKeys(value: unknown): unknown {
  // JSON keeps only enumerable string keys (an array also owns its
  // non-enumerable length), so any other own key would vanish from the output.
  if (value !== null && typeof value === 'object') {
    const kept = Object.keys(value).length + (Array.isArray(value) ? 1 : 0)
    if (Reflect.ownKeys(value).length !== kept) throw new TypeError('cannot hash symbol keys or non-enumerable properties')
  }
  if (Array.isArray(value)) {
    // JSON writes a hole as null and drops a named property, so new Array(1)
    // would collide with [null], and [1] with [1] plus a .note.
    for (let i = 0; i < value.length; i++) if (!(i in value)) throw new TypeError('cannot hash a sparse array')
    if (Object.keys(value).length !== value.length) throw new TypeError('cannot hash an array with named properties')
    return value.map(sortKeys)
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`cannot hash the non-finite number ${value}`)
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TypeError(`cannot hash a ${typeof value}`)
  }
  if (value !== null && typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) throw new TypeError('cannot hash an object that is not plain JSON')
    // A null-prototype target, so a "__proto__" key is stored as a key instead
    // of replacing the prototype and vanishing from the output.
    const out: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = sortKeys(v) // an undefined member is absent, as in JSON
    }
    return out
  }
  return value
}
