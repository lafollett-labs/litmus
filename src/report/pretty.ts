import type { RunEvent, Verdict } from '../core/types.ts'
import { comparisonLines, errorReason, summaryLine, verdictLine, type Paint, type RunReport } from './format.ts'
import { standing } from './gate.ts'

export type Sink = { write: (text: string) => void; tty: boolean }

// Live on a TTY: settled verdicts scroll by and one status line at the bottom
// is redrawn in place. Anywhere else the same lines, without the status line,
// so a CI log reads top to bottom.
export function pretty(sink: Sink, paint: Paint): { event: (e: RunEvent) => void; finish: (r: RunReport) => void } {
  let total = 0
  let finished = 0
  let completed = 0 // finished and not cancelled
  let width = 0
  const running = new Set<string>()
  let status = false
  let ended = false // a cancelled or failed run draws no status line under its last words

  const line = (text: string) => {
    clear()
    sink.write(`${text}\n`)
    draw()
  }
  const clear = () => {
    if (status) sink.write('\r\x1b[2K')
    status = false
  }
  const draw = () => {
    if (!sink.tty || ended || total === 0 || finished === total) return
    sink.write(paint('dim', `${finished}/${total} trials · ${running.size} running`))
    status = true
  }

  return {
    event(e) {
      switch (e.type) {
        case 'run.started':
          total = e.jobs
          line(paint('bold', `litmus run ${e.run} · ${e.jobs} trial${e.jobs === 1 ? '' : 's'}`))
          break
        case 'trial.queued':
          width = Math.max(width, e.key.slice(0, e.key.lastIndexOf('#')).length)
          break
        case 'trial.started':
          running.add(e.key)
          clear()
          draw()
          break
        case 'trial.retry':
          line(paint('dim', `  retry  ${e.key} after attempt ${e.attempt}: ${e.reason}`))
          break
        case 'trial.finished':
          running.delete(e.key)
          finished++
          if (e.status !== 'cancelled') completed++
          clear()
          draw()
          break
        case 'case.settled':
          line(verdictLine(e.verdict, paint, width))
          break
        case 'run.cancelled':
          ended = true
          line(paint('unsure', `cancelled: ${completed}/${total} trials completed; cases it stopped were not settled`))
          break
        case 'run.failed':
          ended = true
          line(paint('error', `litmus failed: ${e.error}`))
          break
        case 'run.finished':
        case 'trial.step':
        case 'trial.usage':
          break
      }
    },
    finish(r) {
      clear()
      for (const c of r.comparisons) sink.write(`\n${comparisonLines(c, paint).join('\n')}\n`)
      if (r.notes.length) sink.write(`\n${r.notes.map(n => paint('dim', `note  ${n}`)).join('\n')}\n`)
      sink.write(`\n${summaryLine(r.verdicts, paint)}\n`)
      const why = reasons(r)
      sink.write(`${why.length ? `${why.join('\n')}\n` : ''}exit ${r.exit}\n`)
    },
  }
}

// What decided the exit code, so a red CI job says which case to open.
function reasons(r: RunReport): string[] {
  const id = (v: Verdict) => `${v.case}@${v.config}`
  const out: string[] = []
  for (const v of r.verdicts) {
    const s = standing(v, r.gate)
    const why = errorReason(r.trials, v)
    const tail = why === undefined ? '' : ` — ${why}`
    if (s === 'blocking') out.push(`  blocks  ${id(v)} ${v.verdict}${tail}`)
    else if (s === 'infra') out.push(`  infra   ${id(v)} ${v.verdict}${tail}`)
  }
  for (const c of r.comparisons) if (c.verdict === 'REGRESSION') out.push(`  blocks  ${c.a} → ${c.b} REGRESSION`)
  return out
}
