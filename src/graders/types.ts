import type { ExecutorResult, GraderResult, Usage } from '../core/types.ts'
import type { Redactor } from '../core/redact.ts'
import type { Provider } from '../providers/index.ts'
import type { LoadedCase } from '../suite/load.ts'
import type { Grader as GraderSpec, JudgeDef } from '../suite/schema.ts'

// What a grader sees: the executor's result plus where the workdir is, for
// graders that look at files (file-exists) or run a command in it.
export type TrialResult = ExecutorResult & { workdir: string; home: string }

// A judge or extractor model, pinned. `hash` covers provider, model, effort,
// region, params and the prompt version, so two results graded by different judges
// can never be silently compared.
export type Judge = { name: string; def: JudgeDef; hash: string; provider: Provider }

export type GradeContext = {
  case: LoadedCase
  judge: (name: string) => Judge // throws ConfigError for an unknown judge name
  signal: AbortSignal
  redact: Redactor // the run's; a grader's rationale and anything it writes are produced here, so redacted here
}

export type Grader<K extends GraderSpec['kind'] = GraderSpec['kind']> = (
  spec: Extract<GraderSpec, { kind: K }>,
  trial: TrialResult,
  ctx: GradeContext,
) => Promise<GraderResult> // throws InfraError when a judge's provider fails; never returns pass on an infra error

// Graders run in case order; every grader runs even after one fails, so the UI
// can show the whole picture. An InfraError from any grader aborts grading
// (the runner retries grading only) and propagates. A cancel rejects with the
// signal's reason, and no partial result set is returned.
export type GradeAll = (trial: TrialResult, ctx: GradeContext) => Promise<GraderResult[]>

// Runs a case's `extract` step, if any: writes the target artifact and
// returns the trial with it added, the extractor's hash for trial.json, what
// the extractor call spent, and why nothing was extracted when nothing was.
export type RunExtract = (trial: TrialResult, ctx: GradeContext) => Promise<{ trial: TrialResult; extractor_hash?: string; usage?: Usage; error?: string }>
