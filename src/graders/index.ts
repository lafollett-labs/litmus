import type { GraderResult } from '../core/types.ts'
import type { Grader as GraderSpec } from '../suite/schema.ts'
import { command } from './command.ts'
import { fileExists } from './file-exists.ts'
import { jsonSchema } from './json-schema.ts'
import { judge } from './judge.ts'
import { regex } from './regex.ts'
import { reviewMatch } from './review-match.ts'
import { toolUsed } from './tool-used.ts'
import type { GradeAll, GradeContext, TrialResult } from './types.ts'

export type { GradeAll, GradeContext, Grader, Judge, RunExtract, TrialResult } from './types.ts'
export { runExtract } from './extract.ts'
export { EXTRACT_PROMPT_VERSION, JUDGE_PROMPT_VERSION, judgeHash, makeJudges } from './judges.ts'

// One at a time, in case order. A failed grade is a result, so the next grader
// still runs and the UI shows the whole picture. A throw is not: an InfraError
// from a judge's provider stops grading at once and propagates, because the
// runner retries grading as a whole and a partial set of grades must never
// reach a verdict.
export const gradeAll: GradeAll = async (trial, ctx) => {
  const results: GraderResult[] = []
  // A cancel is the operator's and is never graded (executors/deadline.ts):
  // a grader that settles "cancelled" must not leave a result set that reads
  // like a failed trial.
  for (const spec of ctx.case.spec.graders) {
    if (ctx.signal.aborted) throw ctx.signal.reason
    let r: GraderResult
    try {
      r = await grade(spec, trial, ctx)
    } catch (e) {
      throw ctx.signal.aborted ? ctx.signal.reason : e // a cancel inside a judge call is still the cancel
    }
    if (ctx.signal.aborted) throw ctx.signal.reason
    // A rationale quotes what the subject wrote, a command printed or a judge said.
    results.push(r.rationale === undefined ? r : { ...r, rationale: ctx.redact.text(r.rationale) })
  }
  return results
}

function grade(spec: GraderSpec, trial: TrialResult, ctx: GradeContext): Promise<GraderResult> {
  switch (spec.kind) {
    case 'regex':
      return regex(spec, trial, ctx)
    case 'json-schema':
      return jsonSchema(spec, trial, ctx)
    case 'file-exists':
      return fileExists(spec, trial, ctx)
    case 'tool-used':
      return toolUsed(spec, trial, ctx)
    case 'command':
      return command(spec, trial, ctx)
    case 'review-match':
      return reviewMatch(spec, trial, ctx)
    case 'judge':
      return judge(spec, trial, ctx)
  }
}
