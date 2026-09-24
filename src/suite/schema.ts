import { z } from 'zod'
import { NAME } from '../core/ids.ts'

// The file formats in docs/ARCHITECTURE.md, as code. Every object is strict: a
// misspelled key ("trails: 5") is an error rather than a silently ignored default,
// because a typo that quietly runs one trial instead of five is a wrong verdict.

const name = z.string().regex(NAME, 'must be lowercase letters, digits, . _ - and start alphanumeric')
const positiveInt = z.int().min(1)
const effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
const lineRange = z
  .tuple([positiveInt, positiveInt])
  .refine(([start, end]) => start <= end, 'lines must be [start, end] with start <= end')

// ── litmus.config.yaml ───────────────────────────────────────────────────────

const modelConfig = {
  model: z.string().min(1),
  effort: effort.optional(),
  // Provider-specific parameters pass through untouched (ADR 0001).
  params: z.record(z.string(), z.unknown()).optional(),
}

export const ConfigDef = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('anthropic'), ...modelConfig }),
  z.strictObject({ provider: z.literal('bedrock'), ...modelConfig, region: z.string().min(1).optional() }),
  // OpenRouter's `models` and `route` tell it to answer with another model when
  // the first fails. An eval that silently measured a different model is worse
  // than an ERROR (ARCHITECTURE § Provider).
  z
    .strictObject({ provider: z.literal('openrouter'), ...modelConfig })
    .refine(d => !d.params || !('models' in d.params || 'route' in d.params), {
      message: 'params.models and params.route are OpenRouter model fallbacks, which litmus never enables',
      path: ['params'],
    }),
  z.strictObject({ provider: z.literal('fake'), model: z.string().default('fake') }),
])
export type ConfigDef = z.infer<typeof ConfigDef>

// Judges and extractors are models too, and take exactly what a config takes:
// a key that is wrong for the provider is refused, not silently ignored and
// still folded into the judge's hash.
export const JudgeDef = ConfigDef
export type JudgeDef = z.infer<typeof JudgeDef>

export const ConfigFile = z.strictObject({
  suites: z.array(z.string().min(1)).min(1),
  results: z.string().min(1).default('./.litmus/runs'),
  concurrency: positiveInt.default(4),
  retries: z.int().min(0).default(2),
  configs: z.record(name, ConfigDef).refine(c => Object.keys(c).length > 0, 'at least one config is required'),
  judges: z.record(name, JudgeDef).default({}),
  pricing: z
    .record(z.string().min(1), z.strictObject({ input: z.number().min(0), output: z.number().min(0) }))
    .default({}),
  compare: z
    .strictObject({
      tolerance: z.number().min(0).lt(1).default(0.05), // δ
      resamples: z.int().min(100).default(2000),
      seed: z.int().default(1),
      warn_ratio: z.number().gt(1).default(1.5),
    })
    .prefault({}),
  redact: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name')).default([]),
})
export type ConfigFile = z.infer<typeof ConfigFile>

// ── suite.yaml ───────────────────────────────────────────────────────────────

const policy = z.enum(['all', 'rate'])
// Open at 1: a Wilson lower bound never reaches 1, so a threshold of 1 could
// never PASS. A case that needs every trial to pass uses policy: all.
const threshold = z.number().gt(0).lt(1)

const runSettings = {
  trials: positiveInt.optional(),
  min_trials: positiveInt.optional(),
  policy: policy.optional(),
  threshold: threshold.optional(),
  timeout_s: positiveInt.optional(),
  tags: z.array(name).optional(),
}

export const SuiteFile = z.strictObject({
  name,
  description: z.string().optional(),
  defaults: z.strictObject(runSettings).default({}),
})
export type SuiteFile = z.infer<typeof SuiteFile>

// ── case.yaml ────────────────────────────────────────────────────────────────

const ModelExecutor = z.strictObject({
  kind: z.literal('model'),
  prompt: z.string().min(1).optional(),
  prompt_file: z.string().min(1).optional(),
  max_tokens: positiveInt.default(8000),
})

const HarnessExecutor = z.strictObject({
  kind: z.literal('harness'),
  harness: z.literal('claude-code'),
  prompt: z.string().min(1).optional(),
  prompt_file: z.string().min(1).optional(),
  plugins: z.array(z.string().min(1)).default([]),
  // [] or [project]. The user and local sources are the operator's own
  // settings, hooks and memory; loading them would make a trial measure the
  // machine it ran on.
  setting_sources: z.array(z.literal('project')).max(1).default([]),
  max_turns: positiveInt.default(30),
  allow_shell: z.boolean().default(false),
  allow_network: z.boolean().default(false),
  allow_hooks: z.boolean().default(false), // hooks and MCP servers run as host processes, outside the gate
})

// Exactly one of an inline prompt or a prompt file: "/review" is a prompt and
// prompt.md is a file, and guessing which one a string means is how a harness
// ends up being sent the literal text "prompt.md".
export const Executor = z
  .discriminatedUnion('kind', [ModelExecutor, HarnessExecutor])
  .superRefine((e, ctx) => {
    if ((e.prompt === undefined) === (e.prompt_file === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'give exactly one of prompt or prompt_file' })
    }
  })
export type Executor = z.infer<typeof Executor>

const bounds = { min: z.int().min(0).default(1), max: z.int().min(0).optional() }
const target = z.string().min(1).default('transcript') // an artifact name, or "transcript"

// min defaults to 1 (never pass on zero), so a lone `max: 0` could never pass.
// Refused here, at load, instead of failing every trial after the money is spent.
const boundsOrdered = (b: { min: number; max?: number | undefined }) => b.max === undefined || b.min <= b.max
const boundsMessage = 'max is below min (min defaults to 1; set min: 0 to allow zero)'

function compiles(pattern: string, flags: string | undefined): boolean {
  try {
    new RegExp(pattern, flags)
    return true
  } catch {
    return false
  }
}

// The schemas a json-schema grader can name as litmus:<name> instead of a file.
export const BUILTIN_SCHEMAS: ReadonlySet<string> = new Set(['litmus:findings'])

export const Grader = z.discriminatedUnion('kind', [
  z
    .strictObject({ kind: z.literal('regex'), target, pattern: z.string().min(1), flags: z.string().optional(), ...bounds })
    .refine(boundsOrdered, boundsMessage)
    .refine(g => compiles(g.pattern, g.flags), 'pattern or flags are not a valid regular expression'),
  z.strictObject({ kind: z.literal('json-schema'), artifact: z.string().min(1), schema: z.string().min(1) }),
  z.strictObject({ kind: z.literal('file-exists'), path: z.string().min(1), exists: z.boolean().default(true) }),
  z.strictObject({ kind: z.literal('tool-used'), tool: z.string().min(1), ...bounds }).refine(boundsOrdered, boundsMessage),
  z.strictObject({ kind: z.literal('command'), run: z.string().min(1), timeout_s: positiveInt.default(120) }),
  z
    .strictObject({
      kind: z.literal('review-match'),
      artifact: z.string().min(1).default('findings.json'),
      window: z.int().min(0).default(5),
      pass: z
        .strictObject({
          min_recall: z.number().min(0).max(1).optional(),
          max_false_positives: z.int().min(0).optional(),
          max_decoy_hits: z.int().min(0).optional(),
          max_duplicates: z.int().min(0).optional(),
          max_nits: z.int().min(0).optional(),
          max_findings: z.int().min(0).optional(),
          min_claims_correct: z.number().min(0).max(1).optional(),
        })
        .default({}),
      confirm: name.optional(),
    })
    // Without a judge there is no claims_correct, and a bound on a metric that
    // is never computed would quietly never apply.
    .refine(g => g.pass.min_claims_correct === undefined || g.confirm !== undefined, 'min_claims_correct needs confirm: <judge>'),
  z.strictObject({ kind: z.literal('judge'), judge: name, question: z.string().min(1), target }),
])
export type Grader = z.infer<typeof Grader>

export const Extract = z.strictObject({
  from: z.string().min(1).default('final_message'), // "final_message", or an artifact path in the workdir
  to: z.string().min(1).default('findings.json'),
  with: name,
})
export type Extract = z.infer<typeof Extract>

export const CaseFile = z.strictObject({
  name,
  description: z.string().optional(),
  expect: z.enum(['pass', 'fail']).default('pass'),
  subject: z.string().min(1).optional(),
  executor: Executor,
  extract: Extract.optional(),
  graders: z.array(Grader).min(1),
  ...runSettings,
})
export type CaseFile = z.infer<typeof CaseFile>

// ── truth.yaml ───────────────────────────────────────────────────────────────

const Bug = z.strictObject({
  id: name,
  file: z.string().min(1),
  lines: lineRange,
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  category: z.string().min(1),
  summary: z.string().min(1),
  proof: z.string().min(1),
  fix: z.string().min(1),
})

const Decoy = z.strictObject({
  id: name,
  file: z.string().min(1),
  lines: lineRange,
  summary: z.string().min(1),
})

export const TruthFile = z
  .strictObject({
    kind: z.enum(['seeded', 'clean']),
    bugs: z.array(Bug).default([]),
    decoys: z.array(Decoy).default([]),
  })
  .superRefine((t, ctx) => {
    if (t.kind === 'seeded' && t.bugs.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['bugs'], message: 'a seeded case needs at least one bug' })
    }
    if (t.kind === 'clean' && t.bugs.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['bugs'], message: 'a clean case has no bugs' })
    }
    const ids = [...t.bugs, ...t.decoys].map(x => x.id)
    const dup = ids.find((id, i) => ids.indexOf(id) !== i)
    if (dup) ctx.addIssue({ code: 'custom', message: `duplicate bug or decoy id "${dup}"` })
  })
export type TruthFile = z.infer<typeof TruthFile>
export type Bug = z.infer<typeof Bug>
export type Decoy = z.infer<typeof Decoy>

// ── litmus:findings ──────────────────────────────────────────────────────────

// Model output, so extra keys (a "confidence", a top-level "summary") are
// allowed and ignored: they cost the review nothing. Missing or mistyped
// required fields still fail.
export const Finding = z
  .object({
    file: z.string().min(1),
    line: positiveInt,
    end_line: positiveInt.optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    category: z.string().optional(),
    title: z.string().min(1),
    explanation: z.string().min(1),
    fix: z.string().optional(),
  })
  .refine(f => f.end_line === undefined || f.end_line >= f.line, 'end_line must be >= line')

export const Findings = z.object({ findings: z.array(Finding) })
export type Finding = z.infer<typeof Finding>
export type Findings = z.infer<typeof Findings>
