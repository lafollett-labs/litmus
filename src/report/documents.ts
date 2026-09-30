import type { TrialRecord, Verdict } from '../core/types.ts'
import { LITMUS_VERSION } from '../runner/run.ts'
import { verdictLine, plain, type RunReport } from './format.ts'
import { standing } from './gate.ts'

export type DocumentFormat = 'json' | 'ctrf' | 'junit'

export function render(format: DocumentFormat, r: RunReport): string {
  switch (format) {
    case 'json':
      return `${JSON.stringify(json(r), null, 2)}\n`
    case 'ctrf':
      return `${JSON.stringify(ctrf(r), null, 2)}\n`
    case 'junit':
      return junit(r)
  }
}

// litmus's own shape: the run's manifest and everything it decided.
function json(r: RunReport) {
  return { run: r.manifest, verdicts: r.verdicts, comparisons: r.comparisons, notes: r.notes, exit: r.exit }
}

const id = (v: Verdict) => `${v.case}@${v.config}`
const suiteOf = (v: Verdict) => v.case.slice(0, v.case.indexOf('/'))
const trialsOf = (r: RunReport, v: Verdict) => r.trials.filter(t => t.case === v.case && t.config === v.config)
const ms = (iso: string) => Date.parse(iso)
const span = (ts: TrialRecord[]) => ({
  duration: Math.round(ts.reduce((n, t) => n + t.wall_clock_ms, 0)),
  ...(ts.length ? { start: Math.min(...ts.map(t => ms(t.started_at))), stop: Math.max(...ts.map(t => ms(t.finished_at))) } : {}),
})
// Why a test that did not pass the gate did not: its verdict line, uncoloured.
const message = (v: Verdict) => verdictLine(v, plain).replace(/\s+/g, ' ')

// One CTRF test per (case, config) verdict, with its status decided by the
// same gate as the exit code: a FLAKY let through by --allow-flaky is passed
// (and flaky), and infrastructure trouble is `other`, never `failed`.
function ctrf(r: RunReport) {
  const status = (v: Verdict) => ({ ok: 'passed', blocking: 'failed', infra: 'other' })[standing(v, r.gate)] as 'passed' | 'failed' | 'other'
  const tests = r.verdicts.map(v => {
    const ts = trialsOf(r, v)
    const s = status(v)
    return {
      name: id(v),
      testId: id(v),
      status: s,
      rawStatus: v.verdict,
      ...span(ts),
      suite: [suiteOf(v)],
      ...(s === 'passed' ? {} : { message: message(v) }),
      retries: ts.reduce((n, t) => n + Math.max(0, t.attempts - 1), 0),
      ...(v.verdict === 'FLAKY' && s === 'passed' ? { flaky: true } : {}),
      parameters: { config: v.config },
      extra: {
        verdict: v.verdict,
        inconclusive_reason: v.inconclusive_reason,
        policy: v.policy,
        expect: v.expect,
        trials: v.trials,
        scored: v.scored,
        successes: v.successes,
        errors: v.errors,
        success_rate: v.success_rate,
        interval: v.interval,
        pass_at_k: v.pass_at_k,
        pass_pow_k: v.pass_pow_k,
      },
    }
  })
  const count = (s: string) => tests.filter(t => t.status === s).length
  const start = ms(r.manifest.started_at)
  const stop = r.manifest.finished_at ? ms(r.manifest.finished_at) : start
  return {
    reportFormat: 'CTRF',
    specVersion: '0.0.0',
    runId: r.manifest.id,
    timestamp: new Date(stop).toISOString(),
    generatedBy: 'litmus',
    results: {
      tool: { name: 'litmus', version: LITMUS_VERSION },
      summary: {
        tests: tests.length,
        passed: count('passed'),
        failed: count('failed'),
        skipped: 0,
        pending: 0,
        other: count('other'),
        flaky: tests.filter(t => t.flaky).length,
        suites: new Set(r.verdicts.map(suiteOf)).size,
        start,
        stop,
        duration: stop - start,
      },
      tests,
      extra: { comparisons: r.comparisons, notes: r.notes, exit: r.exit },
    },
  }
}

const xml = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
    // XML 1.0 has no escape for these; a control character would make the file unreadable.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '�')

// JUnit XML, one testsuite per suite and one testcase per (case, config).
// Blocking verdicts are failures, infrastructure trouble is an error, and a
// comparison's REGRESSION is a failed testcase of its own, since it blocks too.
function junit(r: RunReport): string {
  const suites = new Map<string, Verdict[]>()
  for (const v of r.verdicts) suites.set(suiteOf(v), [...(suites.get(suiteOf(v)) ?? []), v])
  const seconds = (n: number) => (n / 1000).toFixed(3)
  const out = ['<?xml version="1.0" encoding="UTF-8"?>']
  const all = r.verdicts.map(v => standing(v, r.gate))
  const regressions = r.comparisons.filter(c => c.verdict === 'REGRESSION')
  out.push(`<testsuites name="litmus" tests="${r.verdicts.length + r.comparisons.length}" failures="${all.filter(s => s === 'blocking').length + regressions.length}" errors="${all.filter(s => s === 'infra').length}">`)
  for (const [name, vs] of suites) {
    const ss = vs.map(v => standing(v, r.gate))
    const time = vs.reduce((n, v) => n + span(trialsOf(r, v)).duration, 0)
    out.push(`  <testsuite name="${xml(name)}" tests="${vs.length}" failures="${ss.filter(s => s === 'blocking').length}" errors="${ss.filter(s => s === 'infra').length}" skipped="0" time="${seconds(time)}">`)
    for (const v of vs) {
      const s = standing(v, r.gate)
      const head = `    <testcase classname="${xml(name)}" name="${xml(id(v))}" time="${seconds(span(trialsOf(r, v)).duration)}"`
      if (s === 'ok') {
        out.push(`${head}/>`)
        continue
      }
      const tag = s === 'blocking' ? 'failure' : 'error'
      out.push(`${head}>`, `      <${tag} message="${xml(message(v))}" type="${v.verdict}"/>`, '    </testcase>')
    }
    out.push('  </testsuite>')
  }
  if (r.comparisons.length) {
    out.push(`  <testsuite name="comparisons" tests="${r.comparisons.length}" failures="${regressions.length}" errors="0" skipped="0" time="0.000">`)
    for (const c of r.comparisons) {
      const head = `    <testcase classname="comparisons" name="${xml(`${c.a} → ${c.b}`)}" time="0.000"`
      if (c.verdict !== 'REGRESSION') out.push(`${head}/>`)
      else out.push(`${head}>`, `      <failure message="${xml(`REGRESSION: Δ ${c.delta?.toFixed(2)} over ${c.cases} cases`)}" type="REGRESSION"/>`, '    </testcase>')
    }
    out.push('  </testsuite>')
  }
  out.push('</testsuites>')
  return `${out.join('\n')}\n`
}
