import { ConfigError } from '../core/errors.ts'
import { countCheck, readArtifact, readTranscript, subjectText, unread } from './common.ts'
import type { Grader } from './types.ts'

// `transcript` means what the subject produced (see subjectText), not the
// prompt litmus sent it.
export const regex: Grader<'regex'> = async (spec, trial) => {
  const flags = spec.flags ?? ''
  let re: RegExp
  try {
    re = new RegExp(spec.pattern, flags.includes('g') ? flags : `${flags}g`)
  } catch (e) {
    throw new ConfigError(`regex grader: /${spec.pattern}/${flags} is not a valid regular expression: ${(e as Error).message}`)
  }
  let text: string
  if (spec.target === 'transcript') {
    const entries = readTranscript(trial.transcript)
    if (!entries) return { grader: 'regex', pass: false, rationale: 'the transcript is missing' }
    text = subjectText(entries)
  } else {
    const art = readArtifact(trial, spec.target)
    if (!art) return { grader: 'regex', pass: false, rationale: unread(trial, spec.target) }
    text = art.text
  }
  // An empty match is no match: `TODO|` or `x*` would otherwise count every
  // position. Counted, not collected, and stopped past max: a match-dense
  // 64 MiB artifact would otherwise hold millions of match arrays.
  const stop = spec.max === undefined ? Infinity : spec.max + 1
  let n = 0
  for (const m of text.matchAll(re)) if (m[0].length > 0 && ++n >= stop) break
  const c = countCheck(n, spec)
  const seen = n >= stop ? `more than ${spec.max}` : String(n)
  // A count that stopped past max is a lower bound, not a count: null says so.
  return { grader: 'regex', pass: c.pass, metrics: { matches: n >= stop ? null : n }, rationale: `/${spec.pattern}/${flags} matched ${spec.target} ${seen} time(s); want ${c.want}` }
}
