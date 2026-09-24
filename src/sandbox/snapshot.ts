import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export type Snapshot = Map<string, { size: number; hash: string }>

// Every regular file under dir, keyed by forward-slash relative path. .git is
// skipped: litmus never reads it back, which is the point.
export function snapshot(dir: string): Snapshot {
  const out: Snapshot = new Map()
  for (const path of walk(dir)) {
    const data = readFileSync(path)
    out.set(toKey(dir, path), { size: data.length, hash: createHash('sha256').update(data).digest('hex') })
  }
  return out
}

export function written(before: Snapshot, after: Snapshot): string[] {
  return [...after.entries()].filter(([k, v]) => before.get(k)?.hash !== v.hash).map(([k]) => k).sort()
}

export function* walk(dir: string, skip: (name: string) => boolean = n => n === '.git'): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    if (skip(name)) continue
    const path = join(dir, name)
    const st = lstatSync(path)
    if (st.isDirectory()) yield* walk(path, skip)
    else if (st.isFile()) yield path
  }
}

export function symlinksUnder(dir: string): string[] {
  const out: string[] = []
  const visit = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name)
      const st = lstatSync(path)
      if (st.isSymbolicLink()) out.push(toKey(dir, path))
      else if (st.isDirectory()) visit(path)
    }
  }
  visit(dir)
  return out.sort()
}

const toKey = (root: string, path: string) => relative(root, path).split(sep).join('/')
