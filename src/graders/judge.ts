import { readArtifact, readTranscript, renderTranscript } from './common.ts'
import { askJudge } from './judges.ts'
import { judgeRequest } from './prompts.ts'
import type { Grader } from './types.ts'

// The judge is resolved first, so an unknown judge name is a config error on
// every trial rather than hiding behind a missing artifact.
export const judge: Grader<'judge'> = async (spec, trial, ctx) => {
  const j = ctx.judge(spec.judge)
  let material: string
  if (spec.target === 'transcript') {
    const entries = readTranscript(trial.transcript)
    if (!entries) return { grader: 'judge', pass: false, rationale: 'the transcript is missing' }
    material = renderTranscript(entries)
  } else {
    const art = readArtifact(trial, spec.target)
    if (!art) return { grader: 'judge', pass: false, rationale: `${spec.target} was not produced` }
    material = art.text
  }
  const v = await askJudge(j, judgeRequest(spec.question, spec.target, material), ctx.signal)
  return { grader: 'judge', pass: v.pass, rationale: v.rationale }
}
