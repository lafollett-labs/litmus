import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { tree } from '../helpers/tmp.ts'

// docs/PLAN.md M10: the example suites give the verdicts their descriptions
// promise on the fake config. They run from a copy, so the run is written
// there and never into this repository. A new example case must be added here.
const REPO = join(import.meta.dirname, '../..')
const EXPECTED: Record<string, string> = {
  'canaries/not-findings': 'PASS',
  'canaries/wrong-sum': 'PASS',
  'code-review/go-token-expiry': 'PASS',
  'code-review/ts-clean-slug': 'PASS',
  'code-review/ts-range-merge': 'FLAKY',
  'smoke/errors': 'ERROR',
  'smoke/fails': 'FAIL',
  'smoke/flaky': 'FLAKY',
  'smoke/passes': 'PASS',
  'smoke/retried': 'PASS',
  'smoke/unsure': 'INCONCLUSIVE',
}

test('every example case gives its promised verdict on the fake config', () => {
  const dir = tree({})
  cpSync(join(REPO, 'litmus.config.yaml'), join(dir, 'litmus.config.yaml'))
  cpSync(join(REPO, 'suites'), join(dir, 'suites'), { recursive: true })
  const r = spawnSync(process.execPath, [join(REPO, 'src/cli/main.ts'), 'run', '--config', 'fake', '--reporter', 'json', '--config-file', join(dir, 'litmus.config.yaml')], { encoding: 'utf8', cwd: dir })
  const doc = JSON.parse(r.stdout) as { verdicts: { case: string; verdict: string }[] }
  assert.deepEqual(Object.fromEntries(doc.verdicts.map(v => [v.case, v.verdict])), EXPECTED)
  assert.equal(r.status, 1, 'FAIL, FLAKY, ERROR and INCONCLUSIVE block')
})
