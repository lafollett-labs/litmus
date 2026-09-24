import { countCheck, readTranscript } from './common.ts'
import type { Grader } from './types.ts'

// Counts calls the subject made, including ones the gate denied: a cap on
// subagent fan-out is about what the subject tried to do.
export const toolUsed: Grader<'tool-used'> = async (spec, trial) => {
  const entries = readTranscript(trial.transcript)
  if (!entries) return { grader: 'tool-used', pass: false, rationale: 'the transcript is missing' }
  const n = entries.filter(e => e.kind === 'tool_call' && e.tool === spec.tool).length
  const c = countCheck(n, spec)
  return { grader: 'tool-used', pass: c.pass, metrics: { calls: n }, rationale: `${spec.tool} was called ${n} time(s); want ${c.want}` }
}
