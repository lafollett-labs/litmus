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

// The per-trial median of each WARN metric over a side's scored trials. A
// cancelled or errored trial did not do the work, so it would drag a median
// toward zero and read as an agent quitting early.
export function sideMetrics(records: TrialRecord[]): Partial<Record<Warn['metric'], number>> {
  const scored = records.filter(r => r.status === 'pass' || r.status === 'fail')
  const out: Partial<Record<Warn['metric'], number>> = {}
  const put = (metric: Warn['metric'], xs: (number | null | undefined)[]) => {
    const m = median(xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)))
    if (m !== null) out[metric] = m
  }
  put('tokens', scored.map(r => r.usage.input_tokens + r.usage.output_tokens))
  put('cost_usd', scored.map(r => r.usage.cost_usd))
  put('wall_clock_ms', scored.map(r => r.wall_clock_ms))
  put('tool_calls', scored.map(r => r.tool_calls))
  put('findings', scored.map(r => r.findings))
  return out
}
