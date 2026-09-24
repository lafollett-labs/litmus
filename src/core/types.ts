// The shapes that cross module boundaries: executor → grader → stats → store →
// server → UI. Each mirrors a contract in docs/ARCHITECTURE.md; change both
// together.

export type Usage = { input_tokens: number; output_tokens: number; cost_usd?: number }

// cancelled is the operator stopping the run: never a result, never retried.
export type Exit = 'ok' | 'model_failure' | 'infra_error' | 'cancelled'

// One line of transcript.jsonl. Executors map their native stream onto this so
// graders (tool-used, regex over the transcript) never know which harness ran.
export type TranscriptEntry =
  | { t: number; kind: 'message'; role: 'system' | 'user' | 'assistant'; text: string }
  | { t: number; kind: 'tool_call'; id: string; tool: string; input: unknown }
  | { t: number; kind: 'tool_result'; id: string; text: string; is_error: boolean }
  | { t: number; kind: 'denied'; tool: string; reason: string }
  | { t: number; kind: 'usage'; usage: Usage }

export type ExecutorResult = {
  exit: Exit
  reason?: string
  retryable?: boolean // infra_error only: false when every attempt would fail the same way
  artifacts: Record<string, string> // name -> absolute path
  transcript: string // absolute path to transcript.jsonl
  usage: Usage
  wall_clock_ms: number
}

export type GraderResult = {
  grader: string
  pass: boolean
  score?: number
  metrics?: Record<string, number | null> // null when a ratio's denominator is 0
  rationale?: string
}

export type TrialStatus = 'pass' | 'fail' | 'error' | 'cancelled'

export type TrialRecord = {
  key: string
  run: string
  case: string
  config: string
  trial: number
  status: TrialStatus
  exit: Exit
  reason?: string
  attempts: number // 1 + infra retries
  graders: GraderResult[]
  usage: Usage
  wall_clock_ms: number
  started_at: string
  finished_at: string
  artifacts: string[] // names under artifacts/
  tool_calls: number // from the transcript; WARN compares medians of it
  findings: number | null // entries in findings.json, when the trial produced one
  subject_hash?: string
  extractor_hash?: string
  judge_hashes?: Record<string, string> // judge name -> hash, for every judge a grader called
}

export type VerdictKind = 'PASS' | 'FAIL' | 'FLAKY' | 'ERROR' | 'INCONCLUSIVE'

export type Interval = { lo: number; hi: number }

// `successes` are trials that met the case's expectation: a pass when
// expect: pass, a fail when expect: fail. Verdicts, intervals and comparisons
// are all computed on successes, so a canary that starts passing reads as a
// drop in success rate, the same as any other regression. `passes` keeps the
// raw count of what actually happened.
export type Verdict = {
  case: string
  config: string
  verdict: VerdictKind
  // Why a verdict is INCONCLUSIVE: too few scored trials (infra trouble, exit
  // 3) or an interval that has not cleared the threshold yet (exit 1).
  inconclusive_reason: 'min_trials' | 'interval' | null
  policy: 'all' | 'rate'
  expect: 'pass' | 'fail'
  unexpected_pass: boolean // expect: fail, and at least one trial passed
  trials: number // scheduled
  scored: number // trials that ended pass or fail
  errors: number // trials that ended in infra error after retries
  passes: number // raw trial passes
  successes: number
  success_rate: number | null // null when nothing scored
  interval: Interval | null // Wilson 95% on the success rate
  k: number | null // min(3, scored)
  pass_at_k: number | null
  pass_pow_k: number | null // pass^k
}

export type SuiteVerdictKind = 'REGRESSION' | 'IMPROVEMENT' | 'NO CHANGE' | 'INCONCLUSIVE'

export type Flip = { case: string; from: VerdictKind; to: VerdictKind }

export type Warn = { metric: 'tokens' | 'cost_usd' | 'wall_clock_ms' | 'tool_calls' | 'findings'; a: number; b: number; ratio: number }

export type Comparison = {
  a: string // label for the baseline side
  b: string
  cases: number // cases both sides scored
  excluded: { case: string; reason: string }[] // not paired: one side missing, unscored, or the case itself changed
  notes: string[] // differences worth knowing that do not exclude a case (subject or plugin versions)
  flips: Flip[]
  delta: number | null // mean over cases of B's success rate minus A's
  interval: Interval | null // paired bootstrap 95%
  tolerance: number
  verdict: SuiteVerdictKind
  warns: Warn[]
}

export type RunEvent =
  | { type: 'run.started'; run: string; jobs: number }
  | { type: 'trial.queued' | 'trial.started'; key: string }
  | { type: 'trial.step'; key: string; step: { kind: 'message' | 'tool_call' | 'tool_result' | 'denied'; summary: string } }
  | { type: 'trial.usage'; key: string; usage: Usage }
  | { type: 'trial.retry'; key: string; attempt: number; reason: string }
  | { type: 'trial.finished'; key: string; status: TrialStatus; graders: { grader: string; pass: boolean }[] }
  | { type: 'case.settled'; case: string; config: string; verdict: Verdict }
  | { type: 'run.finished' | 'run.cancelled'; run: string; summary: Record<VerdictKind, number> }
