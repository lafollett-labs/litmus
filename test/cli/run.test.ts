import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Ajv } from 'ajv'
import { tree } from '../helpers/tmp.ts'

// The CLI end to end: `node src/cli/main.ts` against a fixture project on the
// fake provider, checking output and every exit code (docs/ARCHITECTURE.md § CLI).

const MAIN = join(import.meta.dirname, '../../src/cli/main.ts')
const SCHEMA = join(import.meta.dirname, '../../src/report/vendor/ctrf.schema.json')

function project(): string {
  const files: Record<string, string> = {
    'litmus.config.yaml': 'suites: [./suites]\nresults: ./.litmus/runs\nconcurrency: 4\nretries: 1\nconfigs:\n  fake: { provider: fake }\n  fake-b: { provider: fake }\n',
    'suites/e2e/suite.yaml': 'name: e2e\ndefaults: { trials: 3 }\n',
    // Outside every case, so editing it changes the answer without changing a
    // case hash: what a new subject version looks like to a comparison.
    'answer.txt': 'LGTM',
  }
  const add = (name: string, extra: string, fake: string) => {
    files[`suites/e2e/cases/${name}/case.yaml`] = `name: ${name}\nexecutor: { kind: model, prompt: "Review {{fixture}}" }\ngraders: [{ kind: regex, target: response.txt, pattern: LGTM }]\n${extra}`
    files[`suites/e2e/cases/${name}/fake.yaml`] = `responses: ${fake}\n`
    files[`suites/e2e/cases/${name}/fixture/a.txt`] = 'hello\n'
  }
  add('passes', '', '[{ text: LGTM }]')
  add('fails', '', '[{ text: nope }]')
  add('flaky', 'trials: 4\n', '[{ text: LGTM }, { text: nope }]')
  add('errors', '', '[{ fatal: revoked }]')
  add('unsure', 'policy: rate\nthreshold: 0.8\ntrials: 5\n', '[{ text: LGTM }]')
  add('few', 'trials: 4\n', '[{ text: LGTM }, { fatal: gone }, { fatal: gone }, { fatal: gone }]')
  add('drift', 'trials: 10\n', '[{ text_file: ../../../../answer.txt }]')
  add('slow', 'trials: 2\n', '[{ text: LGTM, delay_ms: 20000 }]')
  return tree(files)
}

const ROOT = project()
const litmus = (...args: string[]) => spawnSync(process.execPath, [MAIN, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
const runId = (stdout: string) => /litmus run (\S+)/.exec(stdout)![1]!

test('exit 0 when every verdict passes, with the verdict and the exit on stdout', () => {
  const r = litmus('run', 'e2e/passes', '--config', 'fake')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^PASS {10}e2e\/passes@fake {2}3\/3 {2}rate 1\.00 \[0\.44, 1\.00\]$/m)
  assert.match(r.stdout, /^1 verdict: 1 PASS\nexit 0\n$/m)
})

test('exit 1 on FAIL, FLAKY and INCONCLUSIVE (interval), unless the flags allow them', () => {
  for (const [sel, flag] of [['e2e/fails', undefined], ['e2e/flaky', '--allow-flaky'], ['e2e/unsure', '--allow-inconclusive']] as const) {
    const blocked = litmus('run', sel, '--config', 'fake')
    assert.equal(blocked.status, 1, `${sel}: ${blocked.stderr}`)
    assert.match(blocked.stdout, new RegExp(`blocks  ${sel}@fake`))
    if (flag) assert.equal(litmus('run', sel, '--config', 'fake', flag).status, 0, `${sel} ${flag}`)
  }
})

test('exit 3 on infrastructure trouble alone, and 1 when a blocking verdict comes with it', () => {
  const errors = litmus('run', 'e2e/errors', '--config', 'fake')
  assert.equal(errors.status, 3, errors.stderr)
  assert.match(errors.stdout, /infra {3}e2e\/errors@fake ERROR/)
  const few = litmus('run', 'e2e/few', '--config', 'fake', '--allow-inconclusive')
  assert.equal(few.status, 3, few.stdout)
  assert.match(few.stdout, /INCONCLUSIVE +e2e\/few@fake .*too few scored trials/)
  assert.equal(litmus('run', 'e2e/errors', 'e2e/fails', '--config', 'fake').status, 1)
})

test('exit 2 on every usage or config error, with the reason on stderr', () => {
  for (const args of [
    ['run', 'e2e/passes'], // two configs defined, none named
    ['run', 'e2e/passes', '--config', 'nope'],
    ['run', 'e2e/passes', '--config', 'fake,fake'],
    ['run', 'e2e/passes', '--config', 'fake', '--trials', '0'],
    ['run', 'e2e/passes', '--config', 'fake', '--reporter', 'xml'],
    ['run', 'e2e/passes', '--config', 'fake', '--only', 'fail'],
    ['run', 'e2e/passes', '--config', 'fake', '--baseline', 'nope'],
    ['run', 'nope', '--config', 'fake'],
    ['run', '--rerun', 'nope', '--only', 'fail'],
    ['compare', 'only-one'],
    ['compare', 'config:nope', 'config:nope'],
    ['baseline', 'set', 'Bad:Name', '2026-01-01T00-00-00Z-ffff'],
    ['baseline', 'frob'],
  ]) {
    const r = litmus(...args)
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}`)
    assert.ok(r.stderr.trim().length > 0, args.join(' '))
  }
})

test('a REGRESSION against a baseline exits 1 from run and from compare, and the flip is shown', () => {
  writeFileSync(join(ROOT, 'answer.txt'), 'LGTM')
  const before = litmus('run', 'e2e/drift', '--config', 'fake')
  assert.equal(before.status, 0, before.stderr)
  const base = runId(before.stdout)
  assert.equal(litmus('baseline', 'set', 'main', base).status, 0)
  assert.match(litmus('baseline', 'list').stdout, new RegExp(`^main  ${base}$`, 'm'))

  writeFileSync(join(ROOT, 'answer.txt'), 'nope')
  const after = litmus('run', 'e2e/drift', '--config', 'fake', '--baseline', 'main')
  assert.equal(after.status, 1, after.stderr)
  assert.match(after.stdout, /^baseline:main:fake → fake {2}REGRESSION {2}Δ −1\.00 \[/m)
  assert.match(after.stdout, /^ {2}flip {6}e2e\/drift: PASS → FAIL$/m)
  assert.match(after.stdout, /blocks {2}baseline:main:fake → fake REGRESSION/)
  const next = runId(after.stdout)

  const out = join(ROOT, 'comparison.json')
  const cmp = litmus('compare', 'baseline:main', `${next}:fake`, '--out', out)
  assert.equal(cmp.status, 1, cmp.stderr)
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).verdict, 'REGRESSION')
  // config:fake is the newest finished run with that config: the failing one.
  assert.equal(litmus('compare', 'baseline:main:fake', 'config:fake').status, 1)
  assert.equal(litmus('compare', 'config:fake', 'baseline:main:fake').status, 0)
  // The same run on both sides: no evidence either way, which only a flag lets through.
  assert.equal(litmus('compare', next, next).status, 1)
  assert.equal(litmus('compare', next, next, '--allow-inconclusive').status, 0)
})

test('two configs in one run are compared, and a comparison INCONCLUSIVE never changes the exit', () => {
  const r = litmus('run', 'e2e/passes', '--config', 'fake,fake-b')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^fake → fake-b {2}INCONCLUSIVE/m)
})

test('json, CTRF and JUnit reporters print documents, and CTRF validates against the vendored schema', () => {
  const json = litmus('run', 'e2e/passes', 'e2e/fails', '--config', 'fake', '--reporter', 'json')
  assert.equal(json.status, 1)
  const doc = JSON.parse(json.stdout)
  assert.deepEqual(doc.verdicts.map((v: { case: string; verdict: string }) => [v.case, v.verdict]), [['e2e/fails', 'FAIL'], ['e2e/passes', 'PASS']])
  assert.equal(doc.exit, 1)

  const ctrf = litmus('run', 'e2e/passes', 'e2e/fails', 'e2e/flaky', 'e2e/errors', '--config', 'fake', '--reporter', 'ctrf', '--allow-flaky')
  const report = JSON.parse(ctrf.stdout) as { timestamp: string; results: { tests: { name: string; status: string; flaky?: boolean }[]; summary: Record<string, number> } }
  // Formats (uuid, date-time) are checked by hand: ajv-formats is not a dependency.
  const validate = new Ajv({ allErrors: true, validateFormats: false }).compile(JSON.parse(readFileSync(SCHEMA, 'utf8')))
  assert.ok(validate(report), JSON.stringify(validate.errors))
  assert.ok(!Number.isNaN(Date.parse(report.timestamp)))
  const status = Object.fromEntries(report.results.tests.map(t => [t.name, [t.status, t.flaky ?? false]]))
  assert.deepEqual(status, { 'e2e/errors@fake': ['other', false], 'e2e/fails@fake': ['failed', false], 'e2e/flaky@fake': ['passed', true], 'e2e/passes@fake': ['passed', false] })
  assert.deepEqual([report.results.summary.tests, report.results.summary.passed, report.results.summary.failed, report.results.summary.other, report.results.summary.flaky], [4, 2, 1, 1, 1])

  const junit = litmus('run', 'e2e/passes', 'e2e/fails', 'e2e/errors', '--config', 'fake', '--reporter', 'junit')
  assert.match(junit.stdout, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<testsuites name="litmus" tests="3" failures="1" errors="1">/)
  assert.match(junit.stdout, /<testcase classname="e2e" name="e2e\/fails@fake" time="[\d.]+">\n {6}<failure message="FAIL [^"]*" type="FAIL"\/>/)
  assert.match(junit.stdout, /<error message="ERROR [^"]*" type="ERROR"\/>/)
  assert.match(junit.stdout, /<testcase classname="e2e" name="e2e\/passes@fake" time="[\d.]+"\/>/)
})

test('--out writes the document to a file while stdout shows the live view', () => {
  const out = join(ROOT, 'junit.xml')
  const r = litmus('run', 'e2e/passes', '--config', 'fake', '--reporter', 'junit', '--out', out)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^PASS +e2e\/passes@fake/m)
  assert.match(readFileSync(out, 'utf8'), /<testsuites name="litmus" tests="1" failures="0" errors="0">/)
  const text = join(ROOT, 'run.txt')
  assert.equal(litmus('run', 'e2e/passes', '--config', 'fake', '--out', text).status, 0)
  assert.match(readFileSync(text, 'utf8'), /^exit 0$/m)
})

test('--rerun reruns exactly the pairs --only picks, and list shows the latest verdicts', () => {
  const first = litmus('run', 'e2e/passes', 'e2e/fails', 'e2e/flaky', '--config', 'fake')
  const id = runId(first.stdout)
  const again = litmus('run', '--rerun', id, '--only', 'fail,flaky', '--reporter', 'json')
  assert.equal(again.status, 1)
  const doc = JSON.parse(again.stdout)
  assert.deepEqual(doc.verdicts.map((v: { case: string }) => v.case), ['e2e/fails', 'e2e/flaky'])
  assert.equal(doc.run.parent, id)
  assert.equal(litmus('run', '--rerun', id, '--only', 'error').stdout.trim(), `nothing to rerun: run ${id} has no ERROR verdict`)
  assert.match(litmus('list', 'e2e/fails').stdout, /^ {2}fails +model +3 trials {2}fake: FAIL$/m)
})

test('a trial key runs that one trial', () => {
  const r = litmus('run', 'e2e/flaky@fake#2', '--config', 'fake', '--reporter', 'json')
  assert.deepEqual(JSON.parse(r.stdout).verdicts.map((v: { verdict: string; trials: number }) => [v.verdict, v.trials]), [['FAIL', 1]])
})

test('SIGINT cancels the run: it is written as cancelled and exits 130', async () => {
  const child = spawn(process.execPath, [MAIN, 'run', 'e2e/slow', '--config', 'fake'], { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } })
  let stdout = ''
  child.stdout.on('data', d => {
    stdout += d
    if (stdout.includes('litmus run ')) child.kill('SIGINT')
  })
  const code = await new Promise<number | null>(ok => child.on('close', ok))
  assert.equal(code, 130, stdout)
  const id = runId(stdout)
  assert.equal(JSON.parse(readFileSync(join(ROOT, '.litmus/runs', id, 'run.json'), 'utf8')).status, 'cancelled')
  assert.match(stdout, /^cancelled: 0\/2 trials completed/m)
})
