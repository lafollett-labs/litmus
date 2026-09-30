import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Comparison, Verdict } from '../../src/core/types.ts'
import { render } from '../../src/report/documents.ts'
import { colour, plain, type RunReport } from '../../src/report/format.ts'
import { compareExit, runExit, standing } from '../../src/report/gate.ts'
import { pretty } from '../../src/report/pretty.ts'
import type { RunManifest } from '../../src/store/store.ts'

const verdict = (over: Partial<Verdict>): Verdict => ({
  case: 's/c',
  config: 'fake',
  verdict: 'PASS',
  inconclusive_reason: null,
  policy: 'all',
  expect: 'pass',
  unexpected_pass: false,
  trials: 3,
  scored: 3,
  errors: 0,
  passes: 3,
  successes: 3,
  success_rate: 1,
  interval: { lo: 0.44, hi: 1 },
  k: 3,
  pass_at_k: 1,
  pass_pow_k: 1,
  ...over,
})
const comparison = (over: Partial<Comparison>): Comparison => ({ a: 'a', b: 'b', cases: 1, excluded: [], notes: [], flips: [], delta: 0, interval: { lo: -0.3, hi: 0.3 }, tolerance: 0.05, verdict: 'INCONCLUSIVE', warns: [], ...over })
const manifest: RunManifest = { id: '2026-09-30T01-02-03Z-a1b2', status: 'finished', started_at: '2026-09-30T01:02:03.000Z', finished_at: '2026-09-30T01:02:05.000Z', litmus_version: '0', selection: [], configs: {}, cases: [], judges: {}, plugins: {} }
const report = (over: Partial<RunReport>): RunReport => ({ manifest, verdicts: [], comparisons: [], notes: [], trials: [], gate: { allowFlaky: false, allowInconclusive: false }, exit: 0, ...over })

test('the gate: which verdicts block, which are infrastructure, and what the flags let through', () => {
  const strict = { allowFlaky: false, allowInconclusive: false }
  const lax = { allowFlaky: true, allowInconclusive: true }
  const cases: [Partial<Verdict>, string, string][] = [
    [{ verdict: 'PASS' }, 'ok', 'ok'],
    [{ verdict: 'FAIL' }, 'blocking', 'blocking'],
    [{ verdict: 'FLAKY' }, 'blocking', 'ok'],
    [{ verdict: 'ERROR' }, 'infra', 'infra'],
    [{ verdict: 'INCONCLUSIVE', inconclusive_reason: 'interval' }, 'blocking', 'ok'],
    [{ verdict: 'INCONCLUSIVE', inconclusive_reason: 'min_trials' }, 'infra', 'infra'],
  ]
  for (const [v, s, l] of cases) assert.deepEqual([standing(verdict(v), strict), standing(verdict(v), lax)], [s, l], JSON.stringify(v))
  assert.equal(runExit([verdict({ verdict: 'ERROR' }), verdict({ verdict: 'FAIL' })], [], strict), 1)
  assert.equal(runExit([verdict({ verdict: 'ERROR' })], [], strict), 3)
  assert.equal(runExit([verdict({})], [comparison({ verdict: 'REGRESSION' })], strict), 1)
  assert.equal(runExit([verdict({})], [comparison({ verdict: 'INCONCLUSIVE' })], strict), 0)
  assert.deepEqual(['REGRESSION', 'INCONCLUSIVE', 'NO CHANGE', 'IMPROVEMENT'].map(k => compareExit(comparison({ verdict: k as Comparison['verdict'] }), false)), [1, 1, 0, 0])
  assert.equal(compareExit(comparison({ verdict: 'INCONCLUSIVE' }), true), 0)
})

test('on a TTY the status line is redrawn in place; elsewhere no control codes are written', () => {
  const drive = (tty: boolean) => {
    let out = ''
    const view = pretty({ write: t => (out += t), tty }, plain)
    view.event({ type: 'run.started', run: manifest.id, jobs: 2 })
    view.event({ type: 'trial.queued', key: 's/c@fake#1' })
    view.event({ type: 'trial.started', key: 's/c@fake#1' })
    view.event({ type: 'trial.finished', key: 's/c@fake#1', status: 'pass', graders: [] })
    view.event({ type: 'case.settled', case: 's/c', config: 'fake', verdict: verdict({}) })
    view.finish(report({ verdicts: [verdict({})] }))
    return out
  }
  const live = drive(true)
  assert.ok(live.includes('0/2 trials · 1 running'))
  assert.ok(live.includes('\r\x1b[2K'))
  const logged = drive(false)
  assert.ok(!/\x1b/.test(logged), logged)
  assert.deepEqual(logged.split('\n'), [`litmus run ${manifest.id} · 2 trials`, 'PASS          s/c@fake  3/3  rate 1.00 [0.44, 1.00]', '', '1 verdict: 1 PASS', 'exit 0', ''])
})

test('colour wraps each verdict in its own colour; plain adds nothing', () => {
  let out = ''
  const view = pretty({ write: t => (out += t), tty: false }, colour)
  view.event({ type: 'case.settled', case: 's/c', config: 'fake', verdict: verdict({ verdict: 'FAIL', successes: 0, success_rate: 0 }) })
  assert.ok(out.startsWith('\x1b[31mFAIL'))
})

test('JUnit escapes what XML cannot hold, so an odd label never breaks the file', () => {
  const xml = render('junit', report({ verdicts: [verdict({})], comparisons: [comparison({ a: 'baseline:<a&"b">', b: `x'\u0001`, verdict: 'REGRESSION', delta: -0.5 })], exit: 1 }))
  assert.ok(xml.includes('name="baseline:&lt;a&amp;&quot;b&quot;&gt; → x&apos;�"'), xml)
  assert.ok(!/[\u0000-\u0008]/.test(xml))
  assert.match(xml, /<testsuites name="litmus" tests="2" failures="1" errors="0" skipped="0">/)
})
