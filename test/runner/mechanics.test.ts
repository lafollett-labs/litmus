import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { InfraError } from '../../src/core/errors.ts'
import type { ExecutorResult, RunEvent } from '../../src/core/types.ts'
import type { Executor } from '../../src/executors/types.ts'
import type { Provider } from '../../src/providers/types.ts'
import { baselineSide } from '../../src/runner/rerun.ts'
import { run, type RunOptions } from '../../src/runner/run.ts'
import { listRuns, readRun, readTrials } from '../../src/store/store.ts'
import { loadProject } from '../../src/suite/load.ts'
import { select } from '../../src/suite/select.ts'
import { tree } from '../helpers/tmp.ts'

// Stand-in executors drive the runner's own mechanics: retries, staging,
// cleanup, cancellation, grading retries and comparisons over paired cases.

const CONFIG = 'suites: [./suites]\nresults: ./.litmus/runs\nconcurrency: 3\nretries: 2\njudges:\n  j: { provider: anthropic, model: claude-judge }\nconfigs:\n  fake: { provider: fake }\n  fake-b: { provider: fake }\n'

function project(files: Record<string, string>): string {
  const root = tree({ 'litmus.config.yaml': CONFIG, 'suites/e2e/suite.yaml': 'name: e2e\n', ...files })
  mkdirSync(join(root, 'wd'))
  return root
}

const harness = (name: string, trials: number, graders = '[{ kind: regex, target: out.txt, pattern: done }]', extra = '') => ({
  [`suites/e2e/cases/${name}/case.yaml`]: `name: ${name}\nexecutor: { kind: harness, harness: claude-code, prompt: go }\ngraders: ${graders}\ntrials: ${trials}\n${extra}`,
  [`suites/e2e/cases/${name}/fixture/a.txt`]: 'x\n',
})

function options(root: string, over: Partial<RunOptions>, selectors: string[] = []): RunOptions {
  const { config, suites } = loadProject(join(root, 'litmus.config.yaml'))
  return { config, selection: select(suites, selectors, new Set(Object.keys(config.configs))), configs: ['fake'], selectors, env: {}, backoffMs: () => 0, workBase: join(root, 'wd'), ...over }
}

const done = (job: Parameters<Executor>[0], extra: Partial<ExecutorResult> = {}): ExecutorResult => {
  mkdirSync(job.out.artifacts, { recursive: true })
  writeFileSync(join(job.out.artifacts, 'out.txt'), `done attempt ${job.attempt}`)
  writeFileSync(job.out.transcript, `{"kind":"message","attempt":${job.attempt}}\n`)
  return { exit: 'ok', artifacts: { 'out.txt': join(job.out.artifacts, 'out.txt') }, transcript: job.out.transcript, usage: { input_tokens: 10, output_tokens: 0 }, wall_clock_ms: 1, ...extra }
}
const blip = (job: Parameters<Executor>[0], usage = { input_tokens: 4, output_tokens: 1 }): ExecutorResult => ({ ...done(job), exit: 'infra_error', retryable: true, reason: 'blip', usage })
const tick = (ms: number) => new Promise(r => setTimeout(r, ms))
const runs = (root: string) => join(root, '.litmus/runs')
const workLeft = (root: string, id: string) => (existsSync(join(root, 'wd/litmus', id)) ? readdirSync(join(root, 'wd/litmus', id)) : [])
const reply = (text: string, usage = { input_tokens: 7, output_tokens: 3 }) => ({ text, stop_reason: 'end_turn', usage, raw: {} })

test('a retried trial keeps only its last attempt, and its usage is summed over every attempt', async () => {
  const root = project(harness('c', 1))
  const r = await run(options(root, { executors: { harness: async job => (job.attempt === 1 ? blip(job) : done(job)) } }))
  const [t] = readTrials(runs(root), r.id)
  assert.deepEqual([t!.status, t!.attempts, t!.usage], ['pass', 2, { input_tokens: 14, output_tokens: 1 }])
  const dir = join(r.dir, 'trials/e2e/c/fake/1')
  assert.deepEqual(readdirSync(dir).sort(), ['artifacts', 'transcript.jsonl', 'trial.json'])
  assert.equal(readFileSync(join(dir, 'artifacts/out.txt'), 'utf8'), 'done attempt 2')
  assert.equal(readFileSync(join(dir, 'transcript.jsonl'), 'utf8'), '{"kind":"message","attempt":2}\n')
})

test('a cost is summed only when every call that spent tokens was priced', async () => {
  const root = project(harness('c', 1))
  const priced = { input_tokens: 4, output_tokens: 1, cost_usd: 0.5 }
  const r = await run(options(root, { executors: { harness: async job => (job.attempt === 1 ? blip(job, priced) : done(job)) } }))
  assert.deepEqual(readTrials(runs(root), r.id)[0]!.usage, { input_tokens: 14, output_tokens: 1 })
  const both = await run(options(root, { executors: { harness: async job => (job.attempt === 1 ? blip(job, priced) : done(job, { usage: { ...priced, cost_usd: 0.25 } })) } }))
  assert.deepEqual(readTrials(runs(root), both.id)[0]!.usage, { input_tokens: 8, output_tokens: 2, cost_usd: 0.75 })
})

test('every workdir is removed after its trial, including one whose executor threw', async () => {
  const root = project(harness('c', 3))
  const r = await run(options(root, { executors: { harness: async job => { if (job.trial === 2) throw new TypeError('boom'); return done(job) } } }))
  assert.deepEqual(readTrials(runs(root), r.id).map(t => t.status), ['pass', 'error', 'pass'])
  assert.deepEqual(workLeft(root, r.id), [])
})

test('an infra error is never graded', async () => {
  const root = project(harness('c', 1))
  const r = await run(options(root, { executors: { harness: async job => ({ ...done(job), exit: 'infra_error', retryable: false, reason: 'auth' }) } }))
  assert.deepEqual(readTrials(runs(root), r.id).map(t => [t.status, t.graders]), [['error', []]])
})

test('once a run is cancelled no new trial starts, and a cancel cuts a backoff short', async () => {
  const root = project(harness('c', 9))
  const ctl = new AbortController()
  const events: RunEvent[] = []
  setTimeout(() => ctl.abort(new Error('cancelled')), 50)
  await run(options(root, { executors: { harness: async job => (await tick(150), done(job)) }, signal: ctl.signal, listener: e => events.push(e) }))
  assert.equal(events.filter(e => e.type === 'trial.started').length, 3)

  const slow = new AbortController()
  setTimeout(() => slow.abort(new Error('cancelled')), 100)
  const t0 = Date.now()
  const r = await run(options(root, { executors: { harness: async job => blip(job) }, backoffMs: () => 60_000, signal: slow.signal }, ['e2e/c@fake#1']))
  assert.ok(Date.now() - t0 < 5000)
  assert.equal(r.manifest.status, 'cancelled')
})

test('grading is retried on its own: a throttled judge never re-runs the executor, and its usage is recorded', async () => {
  const root = project(harness('g', 1, '[{ kind: judge, judge: j, question: "fine?", target: out.txt }]'))
  let judged = 0
  const provider: Provider = { id: 'anthropic', complete: async () => { if (++judged === 1) throw new InfraError('judge 429', { retryable: true }); return reply('{"pass": true, "rationale": "ok"}') } } as unknown as Provider
  let executed = 0
  const events: RunEvent[] = []
  const r = await run(options(root, { executors: { harness: async job => (executed++, done(job)) }, judgeProvider: () => provider, listener: e => events.push(e) }))
  const [t] = readTrials(runs(root), r.id)
  assert.deepEqual([t!.status, executed, judged, t!.attempts], ['pass', 1, 2, 1])
  assert.deepEqual(t!.grading_usage, { input_tokens: 7, output_tokens: 3 })
  assert.deepEqual(events.flatMap(e => (e.type === 'trial.retry' ? [e.reason.split(':')[0]] : [])), ['grading'])
})

test('a findings.json from an earlier grading attempt does not outlive a later extraction that failed', async () => {
  const root = project({
    'suites/e2e/cases/x/case.yaml': 'name: x\nexecutor: { kind: harness, harness: claude-code, prompt: go }\nextract: { from: out.txt, to: findings.json, with: j }\ngraders: [{ kind: file-exists, path: findings.json }, { kind: judge, judge: j, question: "fine?", target: out.txt }]\ntrials: 1\n',
    'suites/e2e/cases/x/fixture/a.txt': 'x\n',
  })
  let calls = 0
  const finding = '{"findings":[{"file":"a.txt","line":1,"severity":"high","category":"bug","title":"t","explanation":"e"}]}'
  const provider = { id: 'anthropic', complete: async () => {
    calls++
    if (calls === 1) return reply(finding) // extraction, attempt 1
    if (calls === 2) throw new InfraError('judge 429', { retryable: true })
    if (calls === 3) return reply('not json') // extraction, attempt 2
    return reply('{"pass": true, "rationale": "ok"}')
  } } as unknown as Provider
  const r = await run(options(root, { executors: { harness: async job => done(job) }, judgeProvider: () => provider }))
  const [t] = readTrials(runs(root), r.id)
  assert.deepEqual([t!.status, t!.artifacts, t!.findings], ['fail', ['out.txt'], null])
  assert.match(t!.reason!, /extraction: /)
})

test('a listener that throws never takes the run down', async () => {
  const root = project(harness('c', 3))
  const r = await run(options(root, { executors: { harness: async job => done(job) }, listener: e => { if (e.type === 'trial.finished') throw new Error('socket closed') } }))
  assert.deepEqual([r.manifest.status, r.verdicts.map(v => v.verdict)], ['finished', ['PASS']])
})

test('a trial that throws outside its attempts is an error trial, and the run goes on', async () => {
  const root = project(harness('c', 3))
  // A directory where the kept artifacts must land: the store cannot move them.
  const r = await run(options(root, { executors: { harness: async job => {
    if (job.trial === 2) mkdirSync(join(dirname(dirname(dirname(job.out.transcript))), 'artifacts/in-the-way'), { recursive: true })
    return done(job)
  } } }))
  const trials = readTrials(runs(root), r.id)
  assert.deepEqual(trials.map(t => t.status), ['pass', 'error', 'pass'])
  assert.match(trials[1]!.reason!, /^internal error: /)
  assert.deepEqual([r.manifest.status, workLeft(root, r.id)], ['finished', []])
})

test('when not even an error trial can be written, every worker stops and the run is marked failed', async () => {
  const root = project(harness('c', 9))
  const events: RunEvent[] = []
  const executor: Executor = async job => {
    // A directory where trial.json must go: neither the trial nor its error record can be written.
    if (job.trial === 1) mkdirSync(join(dirname(dirname(dirname(job.out.transcript))), 'trial.json'), { recursive: true })
    else await tick(50)
    return done(job)
  }
  await assert.rejects(run(options(root, { executors: { harness: executor }, listener: e => events.push(e) })))
  const [m] = listRuns(runs(root))
  const written = readTrials(runs(root), m!.id).length
  await tick(300)
  assert.equal(readTrials(runs(root), m!.id).length, written)
  assert.equal(readRun(runs(root), m!.id).manifest.status, 'failed')
  assert.ok(events.filter(e => e.type === 'trial.started').length < 9)
})

test('WARN medians cover only the cases both sides scored', async () => {
  const root = project({ ...harness('big', 3), ...harness('small', 3) })
  const executor: Executor = async job => done(job, { usage: { input_tokens: job.case.name === 'big' ? 100 : 10, output_tokens: 0 } })
  const base = await run(options(root, { executors: { harness: executor } }))
  const next = await run(options(root, { executors: { harness: executor }, baseline: baselineSide(runs(root), base.id, 'main') }, ['e2e/big']))
  assert.deepEqual(next.comparisons.map(c => [c.cases, c.warns]), [[1, []]])
})

test('a --baseline config the baseline never ran is reported and skipped', async () => {
  const root = project(harness('c', 1))
  const base = await run(options(root, { executors: { harness: async job => done(job) } }))
  const next = await run(options(root, { executors: { harness: async job => done(job) }, configs: ['fake', 'fake-b'], baseline: baselineSide(runs(root), base.id, 'main') }))
  assert.deepEqual(next.comparisons.map(c => [c.a, c.b]), [['fake', 'fake-b'], ['main:fake', 'fake']])
  assert.deepEqual(next.notes, ['baseline main has no config "fake-b", so fake-b is not compared with it'])
  assert.equal(JSON.parse(readFileSync(join(next.dir, 'comparison.json'), 'utf8')).length, 2)
})

test('a subject that changed since the baseline is noted, and its case is still compared', async () => {
  const root = project({ ...harness('c', 1, undefined, 'subject: ../../../../subject.md\n'), 'subject.md': 'v1\n' })
  const base = await run(options(root, { executors: { harness: async job => done(job) } }))
  writeFileSync(join(root, 'subject.md'), 'v2\n')
  const next = await run(options(root, { executors: { harness: async job => done(job) }, baseline: baselineSide(runs(root), base.id, 'main') }))
  const [c] = next.comparisons
  assert.deepEqual([c!.cases, c!.excluded], [1, []])
  assert.equal(c!.notes.length, 1)
  assert.match(c!.notes[0]!, /^e2e\/c: subject changed \([0-9a-f]{12} → [0-9a-f]{12}\)$/)
})

test('a json-schema file outside the case is part of the case hash', async () => {
  const root = project({
    ...harness('c', 1, '[{ kind: json-schema, artifact: out.json, schema: ../../schemas/s.json }]'),
    'suites/e2e/schemas/s.json': '{"type":"object"}',
  })
  const executor: Executor = async job => {
    const r = done(job)
    writeFileSync(join(job.out.artifacts, 'out.json'), '{}')
    return { ...r, artifacts: { ...r.artifacts, 'out.json': join(job.out.artifacts, 'out.json') } }
  }
  const base = await run(options(root, { executors: { harness: executor } }))
  writeFileSync(join(root, 'suites/e2e/schemas/s.json'), '{"type":"array"}')
  const next = await run(options(root, { executors: { harness: executor }, baseline: baselineSide(runs(root), base.id) }))
  assert.deepEqual(next.comparisons[0]!.excluded, [{ case: 'e2e/c', reason: 'the case changed between the two sides' }])
})
