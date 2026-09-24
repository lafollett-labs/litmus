import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { ConfigError } from '../core/errors.ts'
import { sha256 } from '../core/hash.ts'

// A directory's content hash: each regular file's relative path and sha256,
// sorted. An added, removed, renamed or edited file is a new version; where the
// directory lives and its mtimes are not. `.git` is history, not content. A
// symlink is refused: it would hash one thing and load another.
export function hashTree(root: string): string {
  const lines: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new ConfigError(`${path} is a symlink; a hashed tree must hold only files and directories`)
      if (entry.isDirectory()) {
        if (entry.name !== '.git') walk(path)
      } else if (entry.isFile()) {
        lines.push(`${relative(root, path).split(sep).join('/')}\0${sha256(readFileSync(path))}`)
      } else {
        throw new ConfigError(`${path} is neither a regular file nor a directory`)
      }
    }
  }
  walk(root)
  return sha256(lines.sort().join('\n'))
}
