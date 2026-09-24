import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after } from 'node:test'

// A throwaway directory tree, removed when the test file finishes. Tests never
// read or write a real litmus project.
export function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'litmus-test-'))
  after(() => rmSync(root, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}
