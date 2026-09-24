import type { GradeAll, RunExtract } from './types.ts'

export type { GradeAll, GradeContext, Grader, Judge, RunExtract, TrialResult } from './types.ts'

// M4 implements these against the contract in docs/ARCHITECTURE.md § Grader
// and § Extract. Until then they refuse loudly rather than passing anything.
export const gradeAll: GradeAll = async () => {
  throw new Error('graders arrive in M4')
}

export const runExtract: RunExtract = async trial => ({ trial })
