import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TrialRecord, Warn } from '../core/types.ts'
import { readRegular } from '../sandbox/snapshot.ts'
import { median } from '../stats/intervals.ts'

// What a trial.json records beyond its status: how many tool calls the
// transcript holds, and how many findings its findings.json lists, when it
// has a valid one. WARN compares the medians of both across a side's trials.
export function readTrial(dir: string, artifacts: Record<string, string>): { tool_calls: number; findings: number | null } {
  let toolCalls = 0
  const transcript = join(dir, 'transcript.jsonl')
  if (existsSync(transcript)) {
    for (const line of readFileSync(transcript, 'utf8').split('\n')) {
      if (!line) continue
      try {
        if ((JSON.parse(line) as { kind?: string }).kind === 'tool_call') toolCalls++
      } catch {
        // a torn line
      }
    }
  }
  let findings: number | null = null
  const path = artifacts['findings.json']
  const data = path === undefined ? undefined : readRegular(path, 64 << 20)
  if (data) {
    try {
      const v = JSON.parse(data.toString('utf8')) as { findings?: unknown }
      if (Array.isArray(v.findings)) findings = v.findings.length
    } catch {
      // not JSON: no count
    }
  }
  return { tool_calls: toolCalls, findings }
}

const METRIC: Record<Warn['metric'], (r: TrialRecord) => number | null | undefined> = {
  tokens: r => r.usage.input_tokens + r.usage.output_tokens,
  cost_usd: r => r.usage.cost_usd,
  wall_clock_ms: r => r.wall_clock_ms,
  tool_calls: r => r.tool_calls,
  findings: r => r.findings,
}

// Each WARN metric as the median over cases of each case's median over its
// scored trials. Every case counts once, so a side that scored more trials of
// an expensive case does not read as the model getting more expensive. A
// cancelled or errored trial did not do the work, so it would drag a median
// toward zero and read as an agent quitting early.
export function sideMetrics(records: TrialRecord[]): Partial<Record<Warn['metric'], number>> {
  const byCase = new Map<string, TrialRecord[]>()
  for (const r of records) if (r.status === 'pass' || r.status === 'fail') byCase.set(r.case, [...(byCase.get(r.case) ?? []), r])
  const finite = (xs: (number | null | undefined)[]) => xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  const out: Partial<Record<Warn['metric'], number>> = {}
  for (const [metric, of] of Object.entries(METRIC) as [Warn['metric'], (r: TrialRecord) => number | null | undefined][]) {
    const m = median(finite([...byCase.values()].map(rs => median(finite(rs.map(of))))))
    if (m !== null) out[metric] = m
  }
  return out
}
