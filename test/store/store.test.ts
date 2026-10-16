import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigError } from '../../src/core/errors.ts'
import { redactor } from '../../src/core/redact.ts'
import { baselineRun, baselines, listRuns, readEvents, readRun, RunStore, setBaseline, type RunManifest } from '../../src/store/store.ts'
import { tree } from '../helpers/tmp.ts'

const manifest = (id: string): RunManifest => ({ id, status: 'running', started_at: 't', litmus_version: '0', selection: [], configs: {}, cases: [], judges: {}, plugins: {} })
const ID = '2026-09-30T01-02-03Z-a1b2'

test('every record and event is redacted before it is written, even one no producer scrubbed', () => {
  const results = join(tree({ '.keep': '' }), 'runs')
  const s = RunStore.create(results, { ...manifest(ID), selection: ['k"e\\y'] }, redactor(['k"e\\y']))
  s.event({ type: 'trial.retry', key: 'e2e/c@f#1', attempt: 1, reason: 'said k"e\\y' })
  s.verdicts([])
  mkdirSync(s.trialDir({ suite: 'e2e', case: 'c', config: 'f', trial: 1 }), { recursive: true })
  s.writeTrial({ key: 'e2e/c@f#1', case: 'e2e/c', config: 'f', trial: 1, reason: 'said k"e\\y' } as unknown as Parameters<RunStore['writeTrial']>[0])
  for (const f of ['run.json', 'events.jsonl', 'trials/e2e/c/f/1/trial.json']) {
    const text = readFileSync(join(s.dir, f), 'utf8')
    assert.ok(!text.includes('k\\"e') && !text.includes('k"e'), f)
    assert.ok(text.includes('[REDACTED]'), f)
  }
})

test('a run id is never reused, and readers refuse what is not a run id', () => {
  const results = join(tree({ '.keep': '' }), 'runs')
  RunStore.create(results, manifest(ID), redactor([]))
  assert.throws(() => RunStore.create(results, manifest(ID), redactor([])), (e: Error) => e instanceof ConfigError && e.message === `run ${ID} already exists`)
  assert.throws(() => readRun(results, '../etc'), /not a run id/)
  assert.equal(listRuns(results)[0]!.id, ID)
})

test('a torn last event line is skipped, not fatal', () => {
  const results = join(tree({ '.keep': '' }), 'runs')
  const s = RunStore.create(results, manifest(ID), redactor([]))
  s.event({ type: 'run.started', run: ID, jobs: 1 })
  appendFileSync(join(s.dir, 'events.jsonl'), '{"type":"trial.que')
  assert.deepEqual(readEvents(results, ID).map(e => e.type), ['run.started'])
})

test('baselines name runs beside the runs directory, and an unknown name says what exists', () => {
  const root = tree({ '.keep': '' })
  const results = join(root, '.litmus/runs')
  RunStore.create(results, manifest(ID), redactor([]))
  setBaseline(results, 'main', ID)
  assert.deepEqual(baselines(results), { main: ID })
  assert.equal(baselineRun(results, 'main'), ID)
  assert.throws(() => baselineRun(results, 'nope'), /no baseline named "nope" \(have: main\)/)
  assert.throws(() => setBaseline(results, 'x', '2026-01-01T00-00-00Z-ffff'), /no run/)
  // A ':' would be read as the config in baseline:<name>[:<config>].
  assert.throws(() => setBaseline(results, 'main:fake', ID), /must match/)
  assert.ok(readFileSync(join(root, '.litmus/baselines.json'), 'utf8').includes(ID))
})

test('records are replaced whole, never left half-written, and one torn run.json hides no other run', () => {
  const results = join(tree({ '.keep': '' }), 'runs')
  const s = RunStore.create(results, manifest(ID), redactor([]))
  // A leftover from a write that was killed is replaced by the rename, never left beside it.
  writeFileSync(join(s.dir, 'verdicts.json.tmp'), 'torn')
  s.verdicts([])
  s.finish('finished')
  assert.deepEqual(readdirSync(s.dir).sort(), ['run.json', 'trials', 'verdicts.json'])
  const torn = '2026-09-30T01-02-04Z-c3d4'
  mkdirSync(join(results, torn))
  writeFileSync(join(results, torn, 'run.json'), '{"id": "2026-09-')
  assert.deepEqual(listRuns(results).map(m => [m.id, m.status]), [[ID, 'finished']])
})
