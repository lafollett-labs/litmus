import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { discoverSuites } from '../../src/suite/load.ts'
import type { LoadedCase } from '../../src/suite/load.ts'
import { tree } from './tmp.ts'

// One suite with one case, built from a map of case-relative files. Returns
// the loaded case and a clean base directory for workdirs (a temp dir with no
// CLAUDE.md or AGENTS.md above it).
export function oneCase(caseYaml: string, files: Record<string, string> = {}): { c: LoadedCase; base: string } {
  const prefixed: Record<string, string> = { 's/suite.yaml': 'name: s\n', 's/cases/c/case.yaml': caseYaml }
  for (const [k, v] of Object.entries(files)) prefixed[`s/cases/c/${k}`] = v
  const root = tree(prefixed)
  const base = join(realpathSync(tree({ '.keep': '' })), 'wd')
  mkdirSync(base, { recursive: true })
  return { c: discoverSuites([root])[0]!.cases[0]!, base }
}

export function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}
