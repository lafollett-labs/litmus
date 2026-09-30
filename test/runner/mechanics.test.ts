import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ConfigError, InfraError } from '../../src/core/errors.ts'
import type { ExecutorResult, RunEvent } from '../../src/core/types.ts'
import type { Executor } from '../../src/executors/types.ts'
import type { Provider } from '../../src/providers/types.ts'
import { baselineSide } from '../../src/runner/rerun.ts'
import { defaultBackoff, run, type RunOptions } from '../../src/runner/run.ts'
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

test('a trial whose workdir will not build, or whose executor throws before writing, keeps the real reason', async () => {
  const root = project({ ...harness('c', 1), 'suites/e2e/cases/c/change.patch': 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-not what is there\n+y\n' })
  const r = await run(options(root, { executors: { harness: async job => done(job) } }))
  const [t] = readTrials(runs(root), r.id)
  assert.equal(t?.status, 'error')
  assert.match(t?.reason ?? '', /^case error: .*change\.patch does not apply/)
  const early = project(harness('d', 1))
  const e = await run(options(early, { executors: { harness: async () => { throw new ConfigError('bedrock config "b" has no region') } } }))
  assert.match(readTrials(runs(early), e.id)[0]?.reason ?? '', /^case error: bedrock config "b" has no region$/)
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

test('an attempt that spent nothing leaves the cost of the priced attempts standing', async () => {
  const root = project(harness('c', 1))
  const priced = { input_tokens: 4, output_tokens: 1, cost_usd: 0.5 }
  const r = await run(options(root, { executors: { harness: async job => (job.attempt === 1 ? blip(job, { input_tokens: 0, output_tokens: 0 }) : done(job, { usage: priced })) } }))
  assert.deepEqual(readTrials(runs(root), r.id)[0]!.usage, priced)
})

test('a plugin that changed, or that only one side loaded, is noted', async () => {
  const plugged = (name: string, plugin: string) => ({
    [`suites/e2e/cases/${name}/case.yaml`]: `name: ${name}\nexecutor: { kind: harness, harness: claude-code, prompt: go, plugins: [../../../../${plugin}] }\ngraders: [{ kind: regex, target: out.txt, pattern: done }]\ntrials: 1\n`,
    [`suites/e2e/cases/${name}/fixture/a.txt`]: 'x\n',
  })
  const root = project({ ...plugged('a', 'plug-a'), ...plugged('b', 'plug-b'), 'plug-a/x.md': 'v1\n', 'plug-b/x.md': 'v1\n' })
  const base = await run(options(root, { executors: { harness: async job => done(job) } }))
  writeFileSync(join(root, 'plug-a/x.md'), 'v2\n')
  const next = await run(options(root, { executors: { harness: async job => done(job) }, baseline: baselineSide(runs(root), base.id, 'main') }, ['e2e/a']))
  const notes = next.comparisons[0]!.notes
  assert.equal(notes.length, 2, JSON.stringify(notes))
  assert.match(notes[0]!, /^plugin \/.*\/plug-a: changed \([0-9a-f]{12} → [0-9a-f]{12}\)$/)
  assert.match(notes[1]!, /^plugin \/.*\/plug-b: loaded only by main:fake$/)
})

test('WARN medians count each case once, however many of its trials each side scored', async () => {
  const root = project({ ...harness('big', 3), ...harness('small', 3) })
  const tokens = (job: Parameters<Executor>[0]) => ({ input_tokens: job.case.name === 'big' ? 100 : 10, output_tokens: 0 })
  const base = await run(options(root, { executors: { harness: async job => done(job, { usage: tokens(job) }) } }))
  // Two of big's three trials end in an infra error: fewer big trials scored, none cheaper.
  const next = await run(options(root, { executors: { harness: async job => (job.case.name === 'big' && job.trial > 1 ? { ...done(job), exit: 'infra_error', retryable: false, reason: 'auth' } : done(job, { usage: tokens(job) })) }, baseline: baselineSide(runs(root), base.id, 'main') }))
  assert.deepEqual(next.comparisons.map(c => [c.cases, c.warns]), [[2, []]])
})

test('a trial that crashes after its attempts keeps what it spent; one that crashes during a cancel is cancelled', async () => {
  const root = project(harness('c', 1))
  const inTheWay = (job: Parameters<Executor>[0]) => mkdirSync(join(dirname(dirname(dirname(job.out.transcript))), 'artifacts/in-the-way'), { recursive: true })
  const r = await run(options(root, { executors: { harness: async job => (inTheWay(job), done(job, { usage: { input_tokens: 5900, output_tokens: 1, cost_usd: 1.2 } })) } }))
  assert.deepEqual(readTrials(runs(root), r.id).map(t => [t.status, t.attempts, t.usage]), [['error', 1, { input_tokens: 5900, output_tokens: 1, cost_usd: 1.2 }]])

  const ctl = new AbortController()
  const c = await run(options(root, { signal: ctl.signal, executors: { harness: async job => (inTheWay(job), ctl.abort(new Error('cancelled')), done(job)) } }))
  assert.deepEqual(readTrials(runs(root), c.id).map(t => t.status), ['cancelled'])
})

test('an extraction that a later grading attempt replaced leaves no findings.json on disk', async () => {
  const root = project({
    'suites/e2e/cases/x/case.yaml': 'name: x\nexecutor: { kind: harness, harness: claude-code, prompt: go }\nextract: { from: out.txt, to: findings.json, with: j }\ngraders: [{ kind: judge, judge: j, question: "fine?", target: out.txt }]\ntrials: 1\n',
    'suites/e2e/cases/x/fixture/a.txt': 'x\n',
  })
  let calls = 0
  const finding = '{"findings":[{"file":"a.txt","line":1,"severity":"high","category":"bug","title":"t","explanation":"e"}]}'
  const answers = [() => reply(finding), () => { throw new InfraError('judge 429', { retryable: true }) }, () => reply('not json'), () => reply('{"pass": true, "rationale": "ok"}')]
  const provider = { id: 'anthropic', complete: async () => answers[calls++]!() } as unknown as Provider
  const r = await run(options(root, { executors: { harness: async job => done(job) }, judgeProvider: () => provider }))
  assert.deepEqual(readdirSync(join(r.dir, 'trials/e2e/x/fake/1/artifacts')), ['out.txt'])
})

test('a failed run ends its event stream with run.failed', async () => {
  const root = project(harness('c', 1))
  const events: RunEvent[] = []
  const executor: Executor = async job => (mkdirSync(join(dirname(dirname(dirname(job.out.transcript))), 'trial.json'), { recursive: true }), done(job))
  await assert.rejects(run(options(root, { executors: { harness: executor }, listener: e => events.push(e) })))
  assert.equal(events.at(-1)!.type, 'run.failed')
})

test('a schema file gone since load is a config error, before any run is written', async () => {
  const root = project({ ...harness('c', 1, '[{ kind: json-schema, artifact: out.json, schema: ../../schemas/s.json }]'), 'suites/e2e/schemas/s.json': '{}' })
  const o = options(root, { executors: { harness: async job => done(job) } })
  rmSync(join(root, 'suites/e2e/schemas/s.json'))
  await assert.rejects(run(o), (e: Error) => e instanceof ConfigError && /e2e\/c: schema \.\.\/\.\.\/schemas\/s\.json cannot be read: ENOENT/.test(e.message))
  assert.equal(existsSync(runs(root)), false)
})

test('a workdir the subject made read-only is still removed, and the trial keeps its outcome and spend', async () => {
  const root = project(harness('c', 1))
  const events: RunEvent[] = []
  const r = await run(options(root, { listener: e => events.push(e), executors: { harness: async job => {
    // What `go mod download` leaves under HOME: 0555 directories of 0444 files.
    const mod = join(job.workdir.home, 'go/pkg/mod/example.com/m@v1')
    mkdirSync(mod, { recursive: true })
    writeFileSync(join(mod, 'go.mod'), 'module m\n')
    chmodSync(join(mod, 'go.mod'), 0o444)
    for (let d = mod; d !== job.workdir.home; d = dirname(d)) chmodSync(d, 0o555)
    return done(job, { usage: { input_tokens: 500, output_tokens: 50, cost_usd: 2 } })
  } } }))
  const [t] = readTrials(runs(root), r.id)
  assert.deepEqual([t!.status, t!.usage, r.verdicts.map(v => v.verdict), r.notes], ['pass', { input_tokens: 500, output_tokens: 50, cost_usd: 2 }, ['PASS'], []])
  assert.deepEqual(events.filter(e => e.type === 'trial.finished').length, 1)
  assert.deepEqual(workLeft(root, r.id), [])
})

test('a workdir that cannot be removed at all is a redacted note, never the trial\'s outcome', async () => {
  const root = project(harness('c', 1))
  let parent = ''
  // A "key" that is part of every workdir path, so the note must be redacted.
  const r = await run(options(root, { env: { ANTHROPIC_API_KEY: 'wd/litmus/' }, executors: { harness: async job => {
    // Its parent is read-only, so no chmod inside the workdir can free it.
    parent = dirname(job.workdir.root)
    chmodSync(parent, 0o555)
    return done(job)
  } } })).finally(() => chmodSync(parent, 0o755))
  const [t] = readTrials(runs(root), r.id)
  assert.deepEqual([t!.status, r.verdicts.map(v => v.verdict)], ['pass', ['PASS']])
  assert.equal(r.notes.length, 1)
  assert.match(r.notes[0]!, /^workdir .*\[REDACTED\].* was not removed: /)
  assert.ok(!r.notes[0]!.includes('wd/litmus/'))
})

test('when the store itself fails, the listener still hears run.failed', async () => {
  const root = project(harness('c', 1))
  const events: RunEvent[] = []
  const listener = (e: RunEvent) => {
    events.push(e)
    if (e.type === 'run.started') chmodSync(join(runs(root), e.run, 'events.jsonl'), 0o444)
  }
  await assert.rejects(run(options(root, { executors: { harness: async job => done(job) }, listener })), /EACCES/)
  assert.equal(events.at(-1)!.type, 'run.failed')
})

test('the retry budget is exact: 1 + retries attempts for an error that stays retryable', async () => {
  const root = project(harness('c', 1))
  const r = await run(options(root, { executors: { harness: async job => blip(job) } }))
  assert.deepEqual(readTrials(runs(root), r.id).map(t => [t.status, t.attempts]), [['error', 3]])
})

test('only a retryable infra error is retried: a thrown bug, a case error, or an unmarked infra result is attempted once', async () => {
  const root = project(harness('c', 1))
  const attempts = async (executor: Executor) => readTrials(runs(root), (await run(options(root, { executors: { harness: executor } }))).id).map(t => [t.status, t.attempts])
  assert.deepEqual(await attempts(async () => { throw new TypeError('bug') }), [['error', 1]])
  assert.deepEqual(await attempts(async () => { throw new ConfigError('change.patch does not apply') }), [['error', 1]])
  assert.deepEqual(await attempts(async job => ({ ...done(job), exit: 'infra_error', reason: 'no retryable flag' })), [['error', 1]])
  assert.deepEqual(await attempts(async () => { throw new InfraError('socket hang up', { retryable: true }) }), [['error', 3]])
})

test('grading is retried only for a retryable infra error, and at most retries times', async () => {
  const root = project(harness('g', 1, '[{ kind: judge, judge: j, question: "fine?", target: out.txt }]'))
  const judged = async (fail: () => never) => {
    let calls = 0
    const provider = { id: 'anthropic', complete: async () => (calls++, fail()) } as unknown as Provider
    const r = await run(options(root, { executors: { harness: async job => done(job) }, judgeProvider: () => provider }))
    return [readTrials(runs(root), r.id)[0]!.status, calls]
  }
  assert.deepEqual(await judged(() => { throw new InfraError('judge auth', { retryable: false }) }), ['error', 1])
  assert.deepEqual(await judged(() => { throw new InfraError('judge 429', { retryable: true }) }), ['error', 3])
})

test('a timed-out trial whose grading fails is still a fail, with the grading error in its reason', async () => {
  const root = project(harness('g', 1, '[{ kind: judge, judge: j, question: "fine?", target: out.txt }]'))
  const provider = { id: 'anthropic', complete: async () => { throw new InfraError('judge 429', { retryable: true }) } } as unknown as Provider
  const r = await run(options(root, { executors: { harness: async job => done(job, { exit: 'model_failure', reason: 'timeout after 5s' }) }, judgeProvider: () => provider }))
  const [t] = readTrials(runs(root), r.id)
  assert.deepEqual([t!.status, r.verdicts.map(v => v.verdict)], ['fail', ['FAIL']])
  assert.match(t!.reason!, /^timeout after 5s; grading failed: judge 429$/)
})

test('the default backoff doubles from 1 s, is capped at 30 s, and jitters down to half', () => {
  const random = Math.random
  try {
    Math.random = () => 0.999999
    assert.deepEqual([1, 2, 3, 5, 6, 9].map(a => Math.round(defaultBackoff(a))), [1000, 2000, 4000, 16000, 30000, 30000])
    Math.random = () => 0
    assert.deepEqual([1, 6].map(defaultBackoff), [500, 15000])
  } finally {
    Math.random = random
  }
})

test('a config named twice is refused before anything runs', async () => {
  const root = project(harness('c', 1))
  await assert.rejects(run(options(root, { configs: ['fake', 'fake'] })), (e: Error) => e instanceof ConfigError && /config named twice/.test(e.message))
  assert.equal(existsSync(runs(root)), false)
})

test('the case hash covers the prompt and the judges a case calls, not its tags', async () => {
  const root = project({
    'suites/e2e/suite.yaml': 'name: e2e\ndefaults: { tags: [one] }\n',
    'suites/e2e/prompt.md': 'v1\n',
    'suites/e2e/cases/c/case.yaml': 'name: c\nexecutor: { kind: harness, harness: claude-code, prompt_file: ../../prompt.md }\ngraders: [{ kind: judge, judge: j, question: "fine?", target: out.txt }]\ntrials: 1\n',
    'suites/e2e/cases/c/fixture/a.txt': 'x\n',
  })
  const provider = { id: 'anthropic', complete: async () => reply('{"pass": true, "rationale": "ok"}') } as unknown as Provider
  const go = async (base?: string) => run(options(root, { executors: { harness: async job => done(job) }, judgeProvider: () => provider, ...(base ? { baseline: baselineSide(runs(root), base) } : {}) }))
  const excluded = async (change: () => void) => {
    const base = await go()
    change()
    return (await go(base.id)).comparisons[0]!.excluded.map(x => x.case)
  }
  assert.deepEqual(await excluded(() => writeFileSync(join(root, 'suites/e2e/suite.yaml'), 'name: e2e\ndefaults: { tags: [two] }\n')), [])
  assert.deepEqual(await excluded(() => writeFileSync(join(root, 'suites/e2e/prompt.md'), 'v2\n')), ['e2e/c'])
  const config = join(root, 'litmus.config.yaml')
  assert.deepEqual(await excluded(() => writeFileSync(config, readFileSync(config, 'utf8').replace('claude-judge', 'claude-judge-2'))), ['e2e/c'])
})

test('a cancelled run compares nothing, and writes no comparison.json', async () => {
  const root = project(harness('c', 4))
  const ctl = new AbortController()
  setTimeout(() => ctl.abort(new Error('cancelled')), 50)
  const r = await run(options(root, { configs: ['fake', 'fake-b'], executors: { harness: async job => (await tick(30), done(job)) }, signal: ctl.signal }))
  assert.deepEqual([r.manifest.status, r.comparisons, existsSync(join(r.dir, 'comparison.json'))], ['cancelled', [], false])
})

test('the listener hears every event redacted, even one a producer left raw', async () => {
  const root = project(harness('c', 1))
  const KEY = 'sk-ant-planted-listener-0123456789'
  const events: RunEvent[] = []
  await run(options(root, { env: { ANTHROPIC_API_KEY: KEY }, listener: e => events.push(e), executors: { harness: async job => {
    job.emit({ type: 'trial.retry', key: job.key, attempt: 1, reason: `said ${KEY}` })
    return done(job)
  } } }))
  const text = JSON.stringify(events)
  assert.ok(!text.includes(KEY) && text.includes('[REDACTED]'))
})

test('a cancel during grading retries nothing: no judge call and no retry event', async () => {
  // Extraction calls its judge directly, outside gradeAll's cancel handling.
  const root = project({
    'suites/e2e/cases/x/case.yaml': 'name: x\nexecutor: { kind: harness, harness: claude-code, prompt: go }\nextract: { from: out.txt, to: findings.json, with: j }\ngraders: [{ kind: file-exists, path: findings.json }]\ntrials: 1\n',
    'suites/e2e/cases/x/fixture/a.txt': 'x\n',
  })
  const ctl = new AbortController()
  let calls = 0
  // The 429 settles the judge's race first and the cancel lands just after, so
  // grading sees a retryable error on a run that is already cancelled.
  const provider = { id: 'anthropic', complete: async () => { calls++; queueMicrotask(() => ctl.abort(new Error('cancelled'))); throw new InfraError('judge 429', { retryable: true }) } } as unknown as Provider
  const events: RunEvent[] = []
  const r = await run(options(root, { executors: { harness: async job => done(job) }, judgeProvider: () => provider, signal: ctl.signal, listener: e => events.push(e) }))
  assert.deepEqual([readTrials(runs(root), r.id)[0]!.status, calls, events.filter(e => e.type === 'trial.retry')], ['cancelled', 1, []])
})

test('when the last grading attempt fails after its extraction succeeded, no findings.json is left', async () => {
  const root = project({
    'suites/e2e/cases/x/case.yaml': 'name: x\nexecutor: { kind: harness, harness: claude-code, prompt: go }\nextract: { from: out.txt, to: findings.json, with: j }\ngraders: [{ kind: judge, judge: j, question: "fine?", target: out.txt }]\ntrials: 1\n',
    'suites/e2e/cases/x/fixture/a.txt': 'x\n',
  })
  const finding = '{"findings":[{"file":"a.txt","line":1,"severity":"high","category":"bug","title":"t","explanation":"e"}]}'
  let calls = 0
  // Each grading attempt extracts, then the judge fails with an error that is not retried.
  const provider = { id: 'anthropic', complete: async () => (++calls % 2 === 1 ? reply(finding) : (() => { throw new InfraError('judge auth', { retryable: false }) })()) } as unknown as Provider
  const r = await run(options(root, { executors: { harness: async job => done(job) }, judgeProvider: () => provider }))
  assert.equal(readTrials(runs(root), r.id)[0]!.status, 'error')
  assert.deepEqual(readdirSync(join(r.dir, 'trials/e2e/x/fake/1/artifacts')), ['out.txt'])
})

test('a credential only in process.env is scrubbed too, since the harness reads its keys from there', async () => {
  const root = project(harness('c', 1))
  const KEY = 'sk-ant-planted-process-env-0123456789'
  const saved = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = KEY
  try {
    const r = await run(options(root, { env: {}, executors: { harness: async job => done(job, { reason: `printed ${KEY}` }) } }))
    assert.equal(readTrials(runs(root), r.id)[0]!.reason, 'printed [REDACTED]')
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = saved
  }
})

test('freeing a read-only workdir never follows a link out of it', async () => {
  const root = project(harness('c', 1))
  const outside = join(root, 'outside')
  mkdirSync(join(outside, 'sub'), { recursive: true })
  writeFileSync(join(outside, 'sub/keep.txt'), 'keep\n')
  chmodSync(join(outside, 'sub'), 0o555)
  chmodSync(outside, 0o555)
  try {
    const r = await run(options(root, { executors: { harness: async job => {
      const locked = join(job.workdir.home, 'locked')
      mkdirSync(locked)
      symlinkSync(outside, join(locked, 'out'))
      chmodSync(locked, 0o555)
      return done(job)
    } } }))
    assert.deepEqual([readTrials(runs(root), r.id)[0]!.status, r.notes, workLeft(root, r.id)], ['pass', [], []])
    assert.deepEqual([statSync(outside).mode & 0o777, statSync(join(outside, 'sub')).mode & 0o777, readFileSync(join(outside, 'sub/keep.txt'), 'utf8')], [0o555, 0o555, 'keep\n'])
  } finally {
    chmodSync(outside, 0o755)
    chmodSync(join(outside, 'sub'), 0o755)
  }
})

test('an extraction\'s spend is part of the trial\'s grading usage', async () => {
  const root = project({
    'suites/e2e/cases/x/case.yaml': 'name: x\nexecutor: { kind: harness, harness: claude-code, prompt: go }\nextract: { from: out.txt, to: findings.json, with: j }\ngraders: [{ kind: regex, target: out.txt, pattern: done }]\ntrials: 1\n',
    'suites/e2e/cases/x/fixture/a.txt': 'x\n',
  })
  const finding = '{"findings":[{"file":"a.txt","line":1,"severity":"high","category":"bug","title":"t","explanation":"e"}]}'
  const provider = { id: 'anthropic', complete: async () => reply(finding, { input_tokens: 11, output_tokens: 5 }) } as unknown as Provider
  const r = await run(options(root, { executors: { harness: async job => done(job) }, judgeProvider: () => provider }))
  const [t] = readTrials(runs(root), r.id)
  assert.deepEqual(t!.grading_usage, { input_tokens: 11, output_tokens: 5 })
})
