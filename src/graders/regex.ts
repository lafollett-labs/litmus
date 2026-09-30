import { ConfigError } from '../core/errors.ts'
import { countCheck, readArtifact, readTranscript, subjectText } from './common.ts'
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
    if (!art) return { grader: 'regex', pass: false, rationale: `${spec.target} was not produced` }
    text = art.text
  }
  // An empty match is no match: `TODO|` or `x*` would otherwise count every position.
  const n = [...text.matchAll(re)].filter(m => m[0].length > 0).length
  const c = countCheck(n, spec)
  return { grader: 'regex', pass: c.pass, metrics: { matches: n }, rationale: `/${spec.pattern}/${flags} matched ${spec.target} ${n} time(s); want ${c.want}` }
}
