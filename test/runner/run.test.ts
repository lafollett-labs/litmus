import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExecutorResult, RunEvent } from '../../src/core/types.ts'
import type { Executor } from '../../src/executors/types.ts'
import { rerunPairs, baselineSide } from '../../src/runner/rerun.ts'
import { run, type RunOptions } from '../../src/runner/run.ts'
import { readEvents, readRun, readTrials } from '../../src/store/store.ts'
import { loadProject } from '../../src/suite/load.ts'
import { select } from '../../src/suite/select.ts'
import { tree } from '../helpers/tmp.ts'

const KEY = 'sk-ant-planted-0123456789abcdef'
const model = (graders = '[{ kind: regex, target: response.txt, pattern: LGTM }]', extra = '') =>
  `executor: { kind: model, prompt: "Review {{fixture}}" }\ngraders: ${graders}\n${extra}`

// One project covering every verdict, on the fake provider. The subject's
// scripted answer quotes a key, so redaction is checked end to end.
function project(): string {
  const cases: Record<string, string> = {
    'litmus.config.yaml': `suites: [./suites]\nresults: ./.litmus/runs\nconcurrency: 3\nretries: 2\nredact: [MY_TOKEN]\nconfigs:\n  fake: { provider: fake }\n  fake-b: { provider: fake }\n`,
    'suites/e2e/suite.yaml': 'name: e2e\ndefaults: { trials: 3 }\n',
  }
  const add = (name: string, yaml: string, fake: string) => {
    cases[`suites/e2e/cases/${name}/case.yaml`] = `name: ${name}\n${yaml}`
    cases[`suites/e2e/cases/${name}/fake.yaml`] = fake
    cases[`suites/e2e/cases/${name}/fixture/a.txt`] = 'hello\n'
  }
  add('passes', model(), `responses: [{ text: "LGTM, and the key ${KEY} too", usage: { input_tokens: 10, output_tokens: 5 } }]\n`)
  add('fails', model(), 'responses: [{ text: "nope" }]\n')
  add('flaky', model('[{ kind: regex, target: response.txt, pattern: LGTM }]', 'trials: 4\n'), 'responses: [{ text: LGTM }, { text: nope }]\n')
  add('errors', model(), 'responses: [{ fatal: revoked }]\n')
  add('retries', model(), 'responses: [{ text: LGTM, infra_errors: 1 }]\n')
  add('unsure', model('[{ kind: regex, target: response.txt, pattern: LGTM }]', 'policy: rate\nthreshold: 0.8\ntrials: 5\n'), 'responses: [{ text: LGTM }]\n')
  // A harness case, run by a stand-in executor that times out after writing a
  // file every grader accepts.
  cases['suites/e2e/cases/timeout/case.yaml'] = 'name: timeout\nexecutor: { kind: harness, harness: claude-code, prompt: go }\ngraders: [{ kind: regex, target: out.txt, pattern: done }]\ntrials: 2\n'
  cases['suites/e2e/cases/timeout/fixture/a.txt'] = 'x\n'
  const root = tree(cases)
  mkdirSync(join(root, 'wd'))
  return root
}

const timedOut: Executor = async job => {
  mkdirSync(job.out.artifacts, { recursive: true })
  writeFileSync(join(job.out.artifacts, 'out.txt'), 'done')
  writeFileSync(job.out.transcript, '')
  return { exit: 'model_failure', reason: 'timeout after 5s', artifacts: { 'out.txt': join(job.out.artifacts, 'out.txt') }, transcript: job.out.transcript, usage: { input_tokens: 1, output_tokens: 1 }, wall_clock_ms: 5000 } satisfies ExecutorResult
}

function options(root: string, over: Partial<RunOptions> = {}, selectors: string[] = []): RunOptions {
  const { config, suites } = loadProject(join(root, 'litmus.config.yaml'))
  const configs = over.configs ?? ['fake']
  return {
    config,
    selection: select(suites, selectors, new Set(Object.keys(config.configs))),
    configs,
    selectors,
    env: { ANTHROPIC_API_KEY: KEY },
    executors: { harness: timedOut },
    backoffMs: () => 0,
    workBase: join(root, 'wd'),
    ...over,
  }
}

const verdictOf = (vs: { case: string; verdict: string }[], id: string) => vs.find(v => v.case === id)?.verdict

test('an end-to-end run on fake produces all five verdicts, and every rule of the flow holds', async () => {
  const root = project()
  const events: RunEvent[] = []
  const r = await run(options(root, { listener: e => events.push(e) }))
  const v = (name: string) => verdictOf(r.verdicts, `e2e/${name}`)
  assert.deepEqual(
    ['passes', 'fails', 'flaky', 'errors', 'unsure', 'retries', 'timeout'].map(v),
    ['PASS', 'FAIL', 'FLAKY', 'ERROR', 'INCONCLUSIVE', 'PASS', 'FAIL'],
  )
  const trials = readTrials(join(root, '.litmus/runs'), r.id)
  const of = (name: string) => trials.filter(t => t.case === `e2e/${name}`)
  // Every workdir is gone, and so is the run's own directory above them.
  assert.deepEqual(readdirSync(join(root, 'wd', 'litmus')), [])
  // Only a retryable infra error is retried; a non-retryable one is attempted once.
  assert.deepEqual(of('retries').map(t => t.attempts), [2, 2, 2])
  assert.deepEqual(of('errors').map(t => [t.status, t.attempts]), [['error', 1], ['error', 1], ['error', 1]])
  assert.equal(events.filter(e => e.type === 'trial.retry').length, 3)
  // A timed-out harness trial whose graders pass is still a fail.
  assert.deepEqual(of('timeout').map(t => [t.status, t.exit, t.graders.every(g => g.pass)]), [['fail', 'model_failure', true], ['fail', 'model_failure', true]])
  // Usage is summed over attempts, and the store's layout holds.
  assert.deepEqual(of('passes')[0]!.usage, { input_tokens: 10, output_tokens: 5 })
  assert.equal(readRun(join(root, '.litmus/runs'), r.id).manifest.status, 'finished')
  // events.jsonl replays to the same verdicts, and the listener saw the same stream.
  const replayed = readEvents(join(root, '.litmus/runs'), r.id).flatMap(e => (e.type === 'case.settled' ? [e.verdict] : []))
  const key = (x: { case: string; config: string }) => `${x.case}@${x.config}`
  assert.deepEqual(replayed.sort((a, b) => (key(a) < key(b) ? -1 : 1)), r.verdicts)
  assert.deepEqual(events.map(e => e.type), readEvents(join(root, '.litmus/runs'), r.id).map(e => e.type))
  // A key planted in the environment appears in no file under the run.
  const files: string[] = []
  const walk = (d: string) => readdirSync(d).forEach(n => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : files.push(join(d, n))))
  walk(r.dir)
  assert.ok(files.length > 20)
  for (const f of files) assert.ok(!readFileSync(f, 'utf8').includes(KEY), `${f} holds the key`)
  assert.ok(files.some(f => readFileSync(f, 'utf8').includes('[REDACTED]')))
  // --rerun <run> --only fail selects exactly the FAIL cases.
  assert.deepEqual([...rerunPairs(readRun(join(root, '.litmus/runs'), r.id), ['FAIL'])].sort(), ['e2e/fails@fake', 'e2e/timeout@fake'])
})

test('running a single trial of a passing case is PASS: min_trials follows the trials requested', async () => {
  const root = project()
  const r = await run(options(root, { trials: 1 }, ['e2e/passes']))
  assert.deepEqual(r.verdicts.map(v => [v.verdict, v.scored, v.trials]), [['PASS', 1, 1]])
})

test('a cancel leaves cancelled trials that are not counted as failures, and settles nothing it stopped', async () => {
  const root = project()
  writeFileSync(join(root, 'suites/e2e/cases/passes/fake.yaml'), 'responses: [{ text: LGTM, delay_ms: 5000 }]\n')
  const ctl = new AbortController()
  setTimeout(() => ctl.abort(new Error('cancelled')), 100)
  const t0 = Date.now()
  const r = await run(options(root, { signal: ctl.signal }, ['e2e/passes']))
  assert.ok(Date.now() - t0 < 3000)
  const trials = readTrials(join(root, '.litmus/runs'), r.id)
  assert.ok(trials.length > 0 && trials.every(t => t.status === 'cancelled'))
  assert.deepEqual(r.verdicts, [])
  assert.equal(r.manifest.status, 'cancelled')
  assert.equal(readEvents(join(root, '.litmus/runs'), r.id).at(-1)!.type, 'run.cancelled')
})

test('a rerun runs exactly the chosen pairs and names its parent', async () => {
  const root = project()
  const first = await run(options(root))
  const only = rerunPairs(readRun(join(root, '.litmus/runs'), first.id), ['FAIL', 'FLAKY'])
  const again = await run(options(root, { only, parent: first.id }))
  assert.deepEqual(again.verdicts.map(v => v.case).sort(), ['e2e/fails', 'e2e/flaky', 'e2e/timeout'])
  assert.equal(again.manifest.parent, first.id)
})

test('two configs are compared, and a baseline run is compared config by config', async () => {
  const root = project()
  const both = await run(options(root, { configs: ['fake', 'fake-b'] }, ['e2e/passes', 'e2e/fails']))
  assert.equal(both.comparisons.length, 1)
  assert.equal(both.comparisons[0]!.a, 'fake')
  assert.equal(both.comparisons[0]!.b, 'fake-b')
  assert.deepEqual(both.comparisons[0]!.flips, [])
  assert.deepEqual(both.comparisons[0]!.notes, [])
  const base = baselineSide(join(root, '.litmus/runs'), both.id, 'main')
  const next = await run(options(root, { baseline: base }, ['e2e/passes', 'e2e/fails']))
  assert.equal(next.comparisons.length, 1)
  assert.equal(next.comparisons[0]!.a, 'main:fake')
  assert.equal(next.comparisons[0]!.excluded.length, 0)
})

test('a case whose content changed since the baseline is excluded from the comparison', async () => {
  const root = project()
  const base = await run(options(root, {}, ['e2e/passes']))
  writeFileSync(join(root, 'suites/e2e/cases/passes/fixture/a.txt'), 'changed\n')
  const next = await run(options(root, { baseline: baselineSide(join(root, '.litmus/runs'), base.id) }, ['e2e/passes']))
  assert.deepEqual(next.comparisons[0]!.excluded, [{ case: 'e2e/passes', reason: 'the case changed between the two sides' }])
})

test('a trial key limits its case to that trial and ignores --trials; a config the run does not use is refused', async () => {
  const root = project()
  const r = await run(options(root, { trials: 9 }, ['e2e/flaky@fake#2']))
  assert.deepEqual(r.verdicts.map(v => [v.case, v.trials]), [['e2e/flaky', 1]])
  await assert.rejects(run(options(root, {}, ['e2e/flaky@fake-b#1'])), /does not use/)
})

test('a cancel during grading is cancelled, never a pass on an empty grade list', async () => {
  const root = project()
  writeFileSync(join(root, 'suites/e2e/cases/passes/case.yaml'), 'name: passes\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: command, run: "sleep 5" }]\ntrials: 1\n')
  const ctl = new AbortController()
  setTimeout(() => ctl.abort(new Error('cancelled')), 300)
  const r = await run(options(root, { signal: ctl.signal }, ['e2e/passes']))
  const trials = readTrials(join(root, '.litmus/runs'), r.id)
  assert.deepEqual(trials.map(t => t.status), ['cancelled'])
})

test('effective min_trials follows the trials this run scheduled, not the case\'s own count', async () => {
  const root = project()
  // Six trials by default; run four, and two of those error: two scored, and ceil(4 / 2) = 2 is enough.
  writeFileSync(join(root, 'suites/e2e/cases/passes/case.yaml'), `name: passes\n${model()}trials: 6\n`)
  writeFileSync(join(root, 'suites/e2e/cases/passes/fake.yaml'), 'responses: [{ text: LGTM }, { text: LGTM }, { fatal: gone }, { fatal: gone }]\n')
  const r = await run(options(root, { trials: 4 }, ['e2e/passes']))
  assert.deepEqual(r.verdicts.map(v => [v.verdict, v.scored, v.errors]), [['PASS', 2, 2]])
})
