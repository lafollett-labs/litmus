// node --test exits 0 when its glob matches nothing, so a renamed or moved
// test directory would turn the required CI check green with no tests run.
// Count the files first, then hand them to node --test. Extra arguments
// (--test-name-pattern and friends) pass straight through.
import { spawnSync } from 'node:child_process'
import { glob } from 'node:fs/promises'

const PATTERN = 'test/**/*.test.ts'
const files = (await Array.fromAsync(glob(PATTERN))).sort()
if (files.length === 0) {
  console.error(`no test files match ${PATTERN}`)
  process.exit(1)
}
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' })
process.exit(r.status ?? 1)
