import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { ConfigError } from '../core/errors.ts'
import { sha256 } from '../core/hash.ts'

// A directory's content hash: each regular file's relative path, executable
// bit and sha256, sorted. An added, removed, renamed, edited or chmod +x'd file
// is a new version; where the directory lives and its mtimes are not. `.git`
// (a directory, or a worktree's gitfile naming its location) is history, not
// content, and `.DS_Store` is Finder's. A symlink is refused: it would hash one
// thing and load another.
export function hashTree(root: string): string {
  const lines: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.name === '.git' || entry.name === '.DS_Store') continue
      if (entry.isSymbolicLink()) throw new ConfigError(`${path} is a symlink; a hashed tree must hold only files and directories`)
      if (entry.isDirectory()) {
        walk(path)
      } else if (entry.isFile()) {
        const exec = (statSync(path).mode & 0o111) !== 0 ? 'x' : '-'
        lines.push(`${relative(root, path).split(sep).join('/')}\0${exec}\0${sha256(readFileSync(path))}`)
      } else {
        throw new ConfigError(`${path} is neither a regular file nor a directory`)
      }
    }
  }
  walk(root)
  return sha256(lines.sort().join('\n'))
}
