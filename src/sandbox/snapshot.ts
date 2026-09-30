import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export type Snapshot = Map<string, { size: number; hash: string }>

// Every regular file under dir, keyed by forward-slash relative path. .git is
// skipped: litmus never reads it back, which is the point.
export function snapshot(dir: string): Snapshot {
  const out: Snapshot = new Map()
  for (const path of walk(dir)) {
    const data = readRegular(path)
    if (data) out.set(toKey(dir, path), { size: data.length, hash: digest(data) })
  }
  return out
}

export const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

// A subject with a shell can swap a listed file for a link or a FIFO before it
// is read. Opened without following a final link or blocking on a FIFO, then
// judged by the open file itself: anything but a regular file, or one over
// maxBytes, is undefined.
export function readRegular(path: string, maxBytes = Infinity): Buffer | undefined {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return undefined
  }
  try {
    const st = fstatSync(fd) // the open file itself, so a swap or growth after the open cannot slip past
    return st.isFile() && st.size <= maxBytes ? readFileSync(fd) : undefined
  } finally {
    closeSync(fd)
  }
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
