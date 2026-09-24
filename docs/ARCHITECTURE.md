# Architecture

This file is the contract. Code that disagrees with it is a bug, or this file is
out of date, and both get fixed in the same pull request. Until 0.1.0, contracts
can change freely.

## Vocabulary

| Term | Meaning |
| - | - |
| Suite | A named directory of cases that share a purpose and default settings |
| Case | One scenario: its fixture, its prompt, the subject under test, its graders and its pass rule |
| Subject | What is being tested: a prompt, a system instruction, a skill or a plugin, identified by a hash of its content |
| Configuration | One named combination of provider, model and effort. It is one column in a comparison |
| Trial | One execution of one case under one configuration. A case runs N trials per configuration |
| Attempt | One try at a trial. A trial that hits an infra error is attempted again, up to `retries` |
| Run | A selection of cases × a set of configurations × N trials, executed once and stored |
| Executor | Turns a case, a configuration and a trial into a transcript, artifacts and usage |
| Provider | Gives an executor, a judge or an extractor access to a model |
| Grader | Scores a trial: code (deterministic) or judge (a pinned LLM) |
| Extractor | A pinned model that converts free-form output into a structured artifact before grading |
| Success | A trial that met its case's expectation (defined under Verdicts) |
| Verdict | The settled outcome for one case under one configuration, computed from all its trials |
| Comparison | Two configurations over the same cases: the cases that flipped, and a suite-level verdict |
| Baseline | A stored run that later runs compare against |

Every suite, case and config name matches `^[a-z0-9][a-z0-9._-]*$`, and a suite
or case name must also equal the name of its directory. Names become path
segments and parts of trial keys, so this grammar is enforced when the files
are loaded.

```
case id    <suite>/<case>                        code-review/go-token-expiry
trial key  <suite>/<case>@<config>#<n>           code-review/go-token-expiry@opus-5.5#3
run id     <utc timestamp>-<4 hex>               2026-09-24T15-04-05Z-a1b2
```

## Layout

```
src/
├── core/        # types, ids, hashing, errors, redaction: nothing here does I/O
├── suite/       # load and validate litmus.config.yaml, suite.yaml, case.yaml, truth.yaml
├── providers/   # anthropic, bedrock, openrouter, fake, all behind one interface
├── sandbox/     # workdirs, fixture copies, scrubbed child-process environments
├── executors/   # model, harness (claude-code)
├── graders/     # regex, json-schema, file-exists, tool-used, command, review-match, judge; extract
├── stats/       # intervals, pass@k and pass^k, verdict policies, paired comparison
├── runner/      # expand a selection into jobs, schedule them, retry, cancel, emit events
├── store/       # write and read runs on disk, baselines
├── report/      # pretty terminal output, CTRF, JUnit, JSON
├── server/      # HTTP API and server-sent events on 127.0.0.1
└── cli/         # litmus list | run | compare | baseline | validate | serve
ui/              # Vue 3 + Vite single-page runner, a client of the server
suites/examples/ # smoke, canaries, code-review: examples only, never a release gate
test/            # node --test, plus Playwright for the UI
litmus.config.yaml   # this repository's own config: the example suites and the fake provider
```

## Configuration: `litmus.config.yaml`

This file lives where you run litmus. Suite roots are searched in the order
listed, and a suite name defined under two roots is an error. So is a root
that holds no suite, a directory under a root with `suite.yml` or `cases/` but
no `suite.yaml`, and a broken symlink under a root or `cases/`. Entries whose
names start with `.` or `_` are never suites or cases and are skipped. Judge
names in `extract.with`, `judge` graders and `review-match.confirm` must be
defined under `judges`.

```yaml
suites:
  - ./suites/examples
  - ../private-evals/suites          # gating suites live outside this repo
results: ./.litmus/runs
concurrency: 4
retries: 2                           # extra attempts per trial, for infra errors only

configs:
  opus-5.5:
    provider: anthropic
    model: claude-opus-5-5
    effort: medium                   # low | medium | high | xhigh | max
  opus-5.5-bedrock:
    provider: bedrock
    model: anthropic.claude-opus-5-5
    region: us-east-1
    effort: medium
  sonnet-5-or:
    provider: openrouter
    model: anthropic/claude-sonnet-5
  fake:
    provider: fake

judges:                              # judges and extractors both use these
  default:
    provider: anthropic
    model: claude-haiku-4-5

pricing:                             # USD per million tokens, used when a provider reports no cost
  claude-opus-5-5: { input: 4, output: 20 }

compare:
  tolerance: 0.05                    # δ, the band a difference must clear to count
  resamples: 2000
  seed: 1
  warn_ratio: 1.5

redact: []                           # extra environment variable names whose values are scrubbed from output
```

A config can also carry `params`, which are provider-specific request fields
passed through untouched. `params` is recorded in `run.json`, so it must never
hold a credential. Credentials come only from the environment (below). When
the config loads, `params` is walked at every depth, and it is refused if any
key there:

- matches `/key|token|secret|password|passw|auth|credential|cookie|bearer|session/i`
- is `headers`, since request headers are exactly where a credential would go

The same walk also refuses a string value that equals the live value of any
credential variable litmus knows about (the Redaction list below, which
includes every variable named in `redact`). A name-based check can't prove a
value is harmless, so `params` is for model behaviour (sampling, the thinking
type, output format). Transport and auth settings are never allowed there. The
name check is deliberately broad: `budget_tokens` and `max_tokens` match it
too, so token budgets go through `effort` and the executor's `max_tokens`.

`compare` values are validated when the config loads:

| Key | Valid range |
| - | - |
| `tolerance` | 0 ≤ δ < 1 |
| `resamples` | an integer ≥ 100 |
| `seed` | an integer |
| `warn_ratio` | > 1 |

Keys never appear in this file. Each provider reads its key from the standard
environment variables: `ANTHROPIC_API_KEY`, the AWS credential chain, and
`OPENROUTER_API_KEY`. The Anthropic provider uses `ANTHROPIC_API_KEY` and
nothing else. It never falls back to `ANTHROPIC_AUTH_TOKEN` or to a saved login
profile, whose `base_url` could send the eval to another host and bill another
account. A Bedrock config takes its region from `region`, then `AWS_REGION`,
then `AWS_DEFAULT_REGION`. With none of them set, it is a config error.

## Suite and case files

```
suites/examples/code-review/
├── suite.yaml
└── cases/
    └── go-token-expiry/
        ├── case.yaml
        ├── prompt.md           # when the case uses prompt_file
        ├── fixture/            # the only thing the subject ever sees
        ├── change.patch        # optional: the change under review
        ├── truth.yaml          # ground truth
        ├── proof/              # proof tests, overlaid on a validation copy only
        ├── fix/                # one patch per seeded bug
        └── fake.yaml           # scripted responses, read only by the fake provider
```

**Hidden from the subject:** everything except `fixture/` and `change.patch`.
`truth.yaml`, `proof/`, `fix/` and `fake.yaml` never enter a workdir, and
`{{fixture}}` never renders them. A workdir is built only from `fixture/` and
`change.patch`, under the OS temp directory, so no relative path reaches the
case directory.

`validate` fails a case whose tree contains a symlink **after the change is
applied**. A patch can create a symlink too, and an absolute link could point
back at the case's ground truth.

`suite.yaml`:

```yaml
name: code-review
description: Seeded-bug review of small codebases
defaults:
  trials: 3
  min_trials: 2                # default ceil(trials / 2)
  policy: all                  # all | rate
  threshold: 0.8               # rate policy only
  timeout_s: 600
  tags: [review]
```

`case.yaml`:

```yaml
name: go-token-expiry
description: An off-by-one in token expiry. Flagging the constant-time compare is a false positive
expect: pass                   # pass | fail; see Verdicts
subject: ../../../../skills/review/SKILL.md   # optional; its content hash is the subject version
executor:
  kind: model                  # model | harness
  prompt_file: prompt.md       # or prompt: "inline text"; exactly one
  max_tokens: 8000
# executor:
#   kind: harness
#   harness: claude-code
#   prompt: "/review"
#   plugins: [../../../../plugins/code-reviewer]
#   setting_sources: [project]   # [] (default) or [project]; see the harness executor
#   max_turns: 60
#   allow_shell: false
#   allow_network: false
#   allow_hooks: false
# extract: { from: final_message, to: findings.json, with: default }
graders:
  - kind: json-schema
    artifact: findings.json
    schema: litmus:findings
  - kind: review-match
    window: 5
    pass: { min_recall: 1.0, max_false_positives: 1, max_decoy_hits: 0, max_nits: 5 }
trials: 5
tags: [go, security]
```

Settings resolve in this order: the case, then the suite's `defaults`, then the
built-ins (`trials: 3`, `min_trials: ceil(trials / 2)`, `policy: all`,
`threshold: 0.8`, `timeout_s: 600`). Tags from the suite and the case are
merged.

Defaults for the rest of the case:

| Key | Default |
| - | - |
| `executor.max_tokens` (model) | 8000 |
| `executor.max_turns` (harness) | 30 |
| `executor.setting_sources`, `plugins` | `[]` |
| `executor.allow_shell`, `allow_network`, `allow_hooks` | `false` |
| `extract.from`, `extract.to` | `final_message`, `findings.json` |
| grader `target` (regex, judge) | `transcript` |
| grader `min` (regex, tool-used) | 1 |
| `command.timeout_s` | 120 |
| `review-match.artifact`, `window` | `findings.json`, 5 |

Every directory under a suite's `cases/` is a case and must hold a `case.yaml`.
The exceptions are directories whose names start with `_` or `.`, which can
hold shared files. `fixture/`, `change.patch`, `fake.yaml` and `truth.yaml`
are optional, but one that is present as the wrong type, or as a broken link,
is an error rather than an absence.

A `subject` is a file (a prompt, a skill's `SKILL.md`) or, for a harness case,
a directory (a plugin), and never a symlink. A directory is hashed by its tree: each regular file's
relative path, executable bit and content. `.git` and `.DS_Store` are left out,
and a symlink or special file is refused. A `prompt_file` or a file `subject`
may not point at any case's `case.yaml`, `truth.yaml`, `fake.yaml`, `fix/` or
`proof/`, by its written path or its real one. A directory subject is never
sent to the model, only hashed. This rule catches authoring mistakes, such as a
wrong relative path or a stale symlink. It is not a boundary against the suite's
own author, who writes the prompt and could put the answers in it directly.
That is why a hard link, which has a path of its own, is not chased.

`truth.yaml`:

```yaml
kind: seeded                   # seeded | clean
bugs:
  - id: expiry-off-by-one
    file: internal/auth/token.go
    lines: [41, 44]            # inclusive [start, end], in the post-change tree
    severity: high             # critical | high | medium | low
    category: correctness
    summary: A token is accepted for one second past expiry (>= where > belongs)
    proof: go test ./internal/auth -run TestExpiryBoundary
    fix: fix/expiry-off-by-one.patch
decoys:
  - id: constant-time-compare
    file: internal/auth/token.go
    lines: [60, 62]
    summary: subtle.ConstantTimeCompare is deliberate
```

The `litmus:findings` schema is what a reviewer produces. Line numbers refer
to the tree the subject saw, which is the post-change tree. It is model output,
so extra keys (a `confidence`, a top-level `summary`) are allowed and ignored.
A missing or mistyped required field fails:

```ts
type Finding = {
  file: string
  line: number               // first line
  end_line?: number          // last line, inclusive; defaults to line
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  category?: string
  title: string
  explanation: string
  fix?: string
}
type Findings = { findings: Finding[] }
```

### `litmus validate`

`validate` checks the schemas, the file references and the rules above. It
also runs every seeded bug's proof on a disposable copy of the case, never on
the suite itself:

```
for each seeded bug:
    copy = temp copy of fixture/ → apply change.patch → overlay proof/
    run bug.proof in copy (scrubbed env)       → must exit non-zero
    apply bug.fix to copy; run bug.proof again → must exit 0
```

It fails a case in any of these situations:

- the tree contains a symlink after the change is applied
- the fixture contains a `.git` entry
- a `proof/` path also exists under `fixture/`
- `min_trials` exceeds `trials`, or a `rate` threshold is outside (0, 1)
- a harness case's plugins or fixture declare hooks or MCP servers without
  `allow_hooks: true`
- a harness case with `setting_sources: [project]` has a fixture
  `.claude/settings.json` (or `settings.local.json`) that sets any key other
  than `$schema`
- a suite root lies inside one of the case's plugin or subject roots

It warns in two situations:

- a `rate`-policy case has fewer trials than the policy needs to return PASS
  (see Verdicts)
- a pass bound is set on a metric that can never be defined for the case, such
  as `min_recall` on a clean case

The same checks run when a suite is loaded for `run`. `validate` adds only the
proof runs.

## Flow of a run

```
run = select(cases) × configs × trials(case)
write run.json                           # resolved configs (no secrets), hashes of every suite, case, subject, judge and extractor

for each job, at most `concurrency` at once:
    for attempt in 1 .. 1 + retries:
        workdir = sandbox.workdir(case)  # fresh every attempt; see Sandbox
        result  = executor(case, config, trial, workdir, events)
        if result.exit == infra_error and result.retryable and attempt <= retries:
            emit trial.retry; back off; continue
        break
    if result.exit in (ok, model_failure):
        if result.exit == ok and case.extract:
            extract(result)              # InfraError → retried like grading
        grade(result)                    # InfraError → retry grading only, never the executor
    status = match:
        result.exit == cancelled,
          or the run's cancel aborted this trial    -> cancelled   # checked first, so a cancel can never pass
        result.exit == infra_error                  -> error       # never graded
        grading raised InfraError after retries     -> error
        result.exit == model_failure                -> fail        # graders ran for metrics only
        every grader passed                         -> pass
        else                                        -> fail
    write trial.json, transcript.jsonl, artifacts/   # usage summed over every attempt
    when every trial of (case, config) is settled:
        verdict = policy(trials); emit case.settled

on finish or cancel:
    write verdicts.json                  # settled cases only
    if the run has more than one config, or --baseline was given:
        write comparison.json
```

| How the executor stopped | `exit` | Retried | Trial status |
| - | - | - | - |
| It finished, including a refusal, a truncation or unparseable output | `ok` | No | `pass` or `fail`, decided by the graders |
| A harness timeout or max turns | `model_failure` | Never | `fail` |
| A model-executor timeout, throttling (408, 409, 429), 5xx or network | `infra_error` (retryable) | Up to `retries`, with backoff | `error` once the retries run out |
| Auth failure, another 4xx, or a missing key | `infra_error` (not retryable) | Never | `error` |
| The operator cancelled | `cancelled` | Never | `cancelled` |

A review loop that never converges is exactly what litmus is meant to catch, so
a harness timeout or max-turns stop is a model failure, and it is never
retried. A single model call that times out is almost always a stalled
connection, so for the `model` executor a timeout is a retryable infra error.
A timeout and a cancel travel on different abort reasons, so they can't be
confused.

**Effective `min_trials`.** A run can ask for fewer trials than the case
defines, through `--trials`, a trial-key selector, the UI, or a rerun. The
verdict then uses `min(min_trials, trials requested)`. When `min_trials` is not
set, it defaults to ceil(requested / 2). Running one passing trial is PASS, not
INCONCLUSIVE.

## Sandbox

**Workdirs.** Each workdir is created under
`os.tmpdir()/litmus/<run>/<key-slug>-<attempt>/`. It is never placed under
`.litmus/`, a suite root, or any directory with a `CLAUDE.md` or `AGENTS.md`
in its ancestors. It is built in five steps:

1. `fixture/` is copied. A symlink or a `.git` entry anywhere in it is
   refused.
2. `git init`, and the tree is committed on `main`.
3. If the case has a `change.patch`, the branch `litmus/change` is created
   with the patch committed on it. `HEAD` is `litmus/change`.
4. The post-change tree is scanned again, and any symlink is refused. A patch
   can create one.
5. The builder takes a snapshot of every file (path, size and hash).

Git runs only while the workdir is being built, before the subject starts. It
runs with `PATH` alone for its environment, and with `GIT_CONFIG_NOSYSTEM=1`,
`GIT_CONFIG_GLOBAL=/dev/null`, `core.hooksPath=/dev/null` and
`core.fsmonitor=false`. The gate also refuses the subject any write under
`<workdir>/.git/`.

After the executor exits, **the files the subject wrote** are found by
comparing against the snapshot, not by asking git. That way nothing the
subject wrote into `.git/` ever runs.

**Child processes.** Litmus spawns three kinds of child process: the harness,
`command` graders and `validate` proofs. Each one gets a scrubbed environment:

- `PATH`, `LANG`, `LC_*`, `TERM` and `TMPDIR`.
- `HOME`, pointed at a temporary directory created for the trial.
- The toolchain cache variables `GOCACHE`, `GOMODCACHE`, `GOPATH` and
  `npm_config_cache`, when they are set.
- For the harness only, the one credential its provider needs.

This keeps credentials out of the environment and out of the usual dotfile
locations. **It does not contain a hostile process**, which can still read any
file the operator can read. Four paths are uncontained until the container
executor lands (see "After 0.1.0" in the plan):

- a `command` grader, which runs code the subject may have written
- a `validate` proof, which runs a suite author's command
- `allow_shell`, which gives the subject a real shell
- `allow_hooks`, which runs plugin and project hooks

A shell command, hook or MCP server started by the harness is a child of the
harness process, so it inherits the harness's credential.

## Contracts

### Provider

```ts
interface Provider {
  id: 'anthropic' | 'bedrock' | 'openrouter' | 'fake'
  complete(req: {
    model: string
    system?: string
    messages: { role: 'user' | 'assistant'; content: string }[]
    max_tokens: number
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    params?: Record<string, unknown>     // provider-specific, passed through
    signal: AbortSignal
    trace?: { case_id: string; trial: number; attempt: number; fake_file?: string }
  }): Promise<{
    text: string
    stop_reason: string | null
    usage: { input_tokens: number; output_tokens: number; cost_usd?: number }
    raw: unknown                         // the parsed response body only
  }>
}
```

Every provider error is classified at the boundary and thrown as `InfraError`:

- Retryable: 408, 409, 429, 5xx, and connection failures. Also retryable:
  - a stream that fails in flight (a dropped connection, a body that ends
    before `message_stop`, malformed SSE)
  - an error event mid-stream, which has no HTTP status, unless its type says
    the request itself was wrong (`invalid_request_error`, an auth, permission
    or billing error, `not_found_error`, `request_too_large`)
- Not retryable: auth failures, other 4xx responses, a missing key, and an AWS
  credential chain that finds nothing. The same request would fail again, so
  the trial settles as `error` without using up its retries.

OpenRouter can report a failure inside a 200: a top-level `error`, an `error`
on the choice, `finish_reason: "error"`, or no choice at all. None of these is
an answer to grade, so each is an `InfraError`, classified by its code as an
HTTP status would be (with no code, retryable).

A refusal or a truncated response is returned as text, and the graders judge
it. SDK retries are turned off, because the runner owns retries. Server-side
model fallbacks are never enabled: a fallback answers with a different model,
and an eval that silently measures the wrong model is worse than an ERROR. The
config refuses at load each provider's switch for them: Anthropic's
`fallbacks`, and OpenRouter's `models`, `route` and `openrouter/auto`.
OpenRouter's routing between hosts of the same model is not a model fallback,
and stays on.

Usage counts cached input tokens (cache reads and writes) as input tokens. When
a provider reports no cost, the pricing fallback prices all of them at the full
input rate. That is approximate: cache reads are overpriced (they bill at about
0.1×), and cache writes are underpriced by up to 2×. For a bring-your-own-key
OpenRouter request, cost is OpenRouter's fee plus the upstream charge it reports.

### Executor

```ts
interface Executor {
  kind: 'model' | 'harness'
  execute(job: {
    case: Case; config: Config; trial: number; attempt: number; workdir: string
    emit: (e: TrialEvent) => void; signal: AbortSignal
  }): Promise<{
    exit: 'ok' | 'model_failure' | 'infra_error' | 'cancelled'
    reason?: string
    retryable?: boolean                   // infra_error only
    artifacts: Record<string, string>     // name -> path under the trial's artifacts dir
    transcript: string                    // path to transcript.jsonl
    usage: { input_tokens: number; output_tokens: number; cost_usd?: number }
    wall_clock_ms: number
  }>
}
```

**`model`** makes one provider call.

- **Prompt.** The prompt can use three placeholders:
  - `{{fixture}}`: every file in the workdir apart from `.git/`, each with its
    path and line numbers
  - `{{diff}}`: the contents of `change.patch`
  - `{{file:<path>}}`: a single file from the workdir
- **System prompt.** The subject's content, when the case has a subject.
- **Artifacts.** It always writes `response.txt`. It writes `findings.json`
  when the response has a JSON object to extract: the last ```` ```json ````
  fenced block if there is one, otherwise the whole response if that parses
  as a JSON object. When neither exists, `findings.json` is not written. A
  `json-schema` grader then fails the trial; it is not a model failure.

**`harness: claude-code`** drives Claude Code through
`@anthropic-ai/claude-agent-sdk`. It runs in the workdir (`cwd`) with a
scrubbed environment and these settings:

- **Prompt.** The harness prompt is rendered with the same placeholders as the
  `model` prompt, so `{{diff}}` puts the change in front of a subject that has
  no shell. `subject` only identifies the version by its hash; the harness
  loads the subject itself, as a plugin or through the fixture.
- **Settings.** `settingSources` is always passed explicitly, because leaving
  it out would load the operator's own settings. The value is `[]`, or
  `['project']` when the case asks for it. `['project']` loads `CLAUDE.md` or
  `AGENTS.md` and `.claude/` from the fixture. The `user` and `local` sources
  are never allowed. A fixture's `.claude/settings.json` may set only
  `$schema`: permissions, env, hooks and helper commands would otherwise run
  or approve things outside the gate. Managed (policy) settings on the host
  still load; the SDK gives no way to turn them off.
- **Permissions.** `permissionMode: 'default'` is set explicitly, and
  `disallowedTools` lists every tool class the case has not allowed.
- `CLAUDE_CONFIG_DIR` is a fresh directory created for the trial, and
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` is set. MCP config is strict, with no
  servers unless `allow_hooks` is set.
- The case's plugins are loaded. A plugin or fixture that declares hooks or MCP
  servers is refused unless the case sets `allow_hooks: true`. Hooks run as
  host processes outside the gate, so they are uncontained, like
  `allow_shell`.
- Credentials: `anthropic` requires `ANTHROPIC_API_KEY`, and a claude.ai login
  is never used. `bedrock` sets `CLAUDE_CODE_USE_BEDROCK=1` and passes the AWS
  credential variables. Pairing a harness with `openrouter` or `fake` is a
  config error.
- `maxTurns` comes from the case, and the trial's timeout aborts the session.

Every tool call passes through a default-deny gate. The gate is a PreToolUse
hook, not only `canUseTool`: Claude Code approves read-only tools, and tools
that settings allow, without ever asking `canUseTool`, while a PreToolUse hook
fires on every call, subagents' included.

| Tool | Allowed when |
| - | - |
| Read, Glob, Grep | The realpath is inside the workdir, or inside a plugin or subject root (read-only), and not inside any suite root |
| Write, Edit, MultiEdit, NotebookEdit | The realpath is inside the workdir, and not under `<workdir>/.git/` |
| Agent (subagents), TodoWrite, Skill | Always. Subagent tool calls pass through the same gate |
| Bash | `allow_shell: true` |
| WebFetch, WebSearch, `mcp__*` | `allow_network: true` (`mcp__*` also needs `allow_hooks: true`) |
| Anything else | Never |

Every refusal is written to the transcript. The trial's artifacts are:

- the files the subject wrote, found by the snapshot
- `final_message.txt`

The gate refuses any realpath inside a configured suite root, even one that is
also inside a plugin or subject root. A private suite kept in the plugin repo
it evaluates therefore stays out of reach.

### Extract

`extract: { from, to, with }` runs after an executor that finishes with `ok`
and before the graders.

- `from` is `final_message` or the name of an artifact.
- `with` names one of the `judges`.

The extractor sends litmus's built-in extraction prompt and the target schema
(`litmus:findings`), then writes `to` as an artifact. It is identified by a
hash of the judge definition plus the prompt version. That hash is recorded in
`trial.json` and `run.json`. A comparison refuses to pair two results whose
extractor hashes differ, and the same goes for judges. This lets a real
`/review` skill be scored without changing the format it writes.

### Grader

```ts
interface Grader {
  kind: string
  grade(trial: TrialResult, ctx: { case: Case; truth?: Truth; judges: Judges; signal: AbortSignal }): Promise<{
    grader: string
    pass: boolean
    score?: number                         // 0..1
    metrics?: Record<string, number | null>
    rationale?: string                     // shown in the UI, including on a pass
  }>                                       // throws InfraError when a judge's provider fails
}
```

A trial passes when its executor finished (`exit == ok`) and every one of its
graders passes. A cancelled, failed or errored trial never passes, whatever
its graders say.

| Grader | Passes when |
| - | - |
| `regex` | The pattern matches the target (an artifact or `transcript`) between `min` and `max` times |
| `json-schema` | The artifact parses and validates against the schema (`litmus:findings`, or a path to a JSON Schema) |
| `file-exists` | The subject created (or did not create) the path |
| `tool-used` | A tool was called between `min` and `max` times, read from the transcript. Useful for capping subagent fan-out |
| `command` | A shell command, run in the workdir after the trial with the scrubbed environment, exits 0 within `timeout_s`. **Uncontained** (see Sandbox) |
| `review-match` | Findings matched against `truth.yaml` meet the case's `pass` bounds (below) |
| `judge` | A pinned binary judge answers yes to its `question` about its `target` |

**`review-match`** pairs findings with bugs as a maximum-cardinality matching,
not greedily. Suppose finding A is nearest bug 1 but also within reach of bug
2, and finding B can only reach bug 1. Greedy pairing gives A to bug 1 and
leaves B and bug 2 unmatched. A maximum matching scores both.

It measures how far apart two line ranges are:

```
gap(a, b) = 0 if the ranges overlap, else the number of lines between them
```

It then pairs findings with bugs:

```
candidates = (finding, bug) pairs in the same file (normalized path) with gap <= window
pairs = a maximum-cardinality one-to-one matching over candidates
        # among the maximum matchings: smallest total gap,
        # then earliest bugs in truth order, then earliest findings

for each unmatched finding:
    if it is within window of a decoy:           decoy hit       # any severity
    elif it is within window of a matched bug:   duplicate       # a second report of a found bug
    elif truth.kind == seeded and its severity is info or low:
                                                 nit
    else:                                        false positive  # on a clean case, every finding lands here or on a decoy
```

Paths are normalized before they are compared. A leading workdir path
(absolute, or its realpath) is stripped, as are a leading `./` and backslashes.

The metrics are below. A metric is null when its denominator is 0.

```
recall            = matched / bugs                    # also recall_<severity> per severity
precision         = matched / (matched + false_positives + decoy_hits)
precision_all     = matched / findings
false_positives, decoy_hits, duplicates, nits, findings   # counts
claims_correct    = confirmed / matched               # only with confirm
```

The `pass` bounds are `min_recall`, `max_false_positives`, `max_decoy_hits`,
`max_duplicates`, `max_nits`, `max_findings` and `min_claims_correct`. A bound
that is not set does not apply. Nor does a bound whose metric is null, such as
`min_recall` on a clean case; its rationale says "n/a".

With `confirm: <judge>`, each matched pair goes to a binary judge. It asks
whether the finding states the seeded bug's mechanism, and whether that
statement is correct. A match earns credit for being in the right place, but a
right place with a false explanation is still wrong.

**`judge`** is identified by a hash of its provider, model, prompt and
parameters. It answers one yes-or-no question and returns
`{ pass, rationale }`. It is never asked to rate anything on a scale.

### Verdicts

A trial is a **success** when it met its case's expectation:

| `expect` | Success |
| - | - |
| `pass` | `status == pass` |
| `fail` | `status == fail` and `exit == ok`: the graders ran and rejected the output |

```
scored    = trials with status pass or fail          # error and cancelled are left out
successes = scored trials that are successes

if scored is empty:                         ERROR
elif expect == fail and any trial passed:   FAIL     # one pass proves a canary broken
elif len(scored) < min_trials:              INCONCLUSIVE (reason: min_trials)
elif policy == all:
    if successes == len(scored):            PASS
    elif successes == 0:                    FAIL
    else:                                   FLAKY
elif policy == rate:
    ci = wilson_95(successes, len(scored))
    if ci.lo >= threshold:                  PASS
    elif ci.hi < threshold:                 FAIL
    else:                                   INCONCLUSIVE (reason: interval)
```

`min_trials` is the effective one described under Flow of a run.

FLAKY exists only under `all`, which is the unit-test-runner reading: it
sometimes passes. Under `rate`, an interval that straddles the threshold is
INCONCLUSIVE, because more trials settle it.

A `rate` case can reach PASS only once `n >= z²·t / (1 − t)`, which is 16
trials for a 0.8 threshold. `validate` warns about cases below that.

Every verdict also stores:

- the raw pass count, the success count, the success rate, and its Wilson 95%
  interval
- pass@k and pass^k on successes, with k = min(3, scored), using the unbiased
  combinatorial estimators
- the error count, and for INCONCLUSIVE, its reason

### Comparison

A comparison takes configuration A (the baseline) and configuration B over
the cases both of them scored.

- **Excluded cases.** A case is listed as excluded, with a reason, in three
  situations:
  - only one side ran it
  - one side could not score it
  - its **case hash** differs between the sides

  The case hash covers `case.yaml`, `truth.yaml`, `fixture/`, `change.patch`,
  `proof/`, `fix/`, and the grader and extractor hashes. An edit to ground
  truth would otherwise be blamed on the model. A difference in a subject or
  plugin hash does not exclude a case, because comparing subject versions is a
  real use. It is listed in the comparison's `notes` instead.
- **Flips.** Every case whose verdict changed is listed with its old and new
  verdicts. This is the headline of the comparison, not a footnote.
- **Suite verdict.** d is the mean over paired cases of B's observed success
  rate minus A's. Its 95% interval comes from a two-level bootstrap:
  1. Each resample draws cases with replacement.
  2. For each case drawn, it draws a difference from a normal distribution
     centred on that case's observed difference.
  3. The spread comes from Jeffreys-smoothed rates, p̃ = (s + ½)/(n + 1), with
     variance p̃(1 − p̃)/n per side. Each draw is clamped to [−1, 1].

  The randomness is a seeded mulberry32, so a comparison is reproducible.

  With δ = `compare.tolerance`:

  ```
  if no paired cases:                    INCONCLUSIVE
  elif ci.hi < -δ:                       REGRESSION
  elif ci.lo > δ:                        IMPROVEMENT
  elif -δ <= ci.lo and ci.hi <= δ:       NO CHANGE
  else:                                  INCONCLUSIVE    # run more trials or cases
  ```

  Resampling cases alone treats each pass rate as exact, so one case at 1/1
  against 0/1 would come out as a certain regression. The per-case draw keeps
  each case's trial uncertainty in the interval.

  Centring on the observed difference, rather than on a posterior mean, keeps
  unequal trial counts unbiased. A posterior mean pulls 1/1 to 0.75 and 5/5 to
  0.92, so two sides that never failed would read as a confident regression.

  NO CHANGE takes real evidence. Two identical all-pass sides reach it at
  δ = 0.05 with about 20 cases × 30 trials, or 200 cases × 10. Smaller suites
  come out INCONCLUSIVE, which is why `run` treats a comparison's
  INCONCLUSIVE as information rather than a failure (see CLI).

- **WARN.** Raised for a metric when the ratio of B's per-trial median to A's
  falls outside [1/`warn_ratio`, `warn_ratio`]. The metrics are total tokens,
  cost, wall-clock time, tool calls, and findings. A metric is skipped when
  A's median is 0 or missing. A WARN never changes an exit code.

### Addressing runs and comparisons

| Form | Means |
| - | - |
| `<run id>` | That run. It must hold exactly one config |
| `<run id>:<config>` | That config within that run |
| `baseline:<name>[:<config>]` | The run stored under that baseline name. Baseline names use the NAME grammar |
| `config:<name>` | The latest run that includes that config |

- `litmus run --config a,b` compares every later config against the first.
- `litmus run --baseline <name>` compares each config against the config of
  the same name in the baseline run. A config missing from the baseline is
  reported and skipped.
- A rerun (`--rerun <run> --only …`) selects (case, config) pairs whose verdict
  is in the set. Its jobs are those pairs, not the cross product of their
  cases and configs.
- A standalone `litmus compare` prints its result and writes it only with
  `--out`, because runs are append-only.

## Storage

```
.litmus/
├── baselines.json                        # { "<name>": "<run id>" }
└── runs/<run id>/
    ├── run.json                          # manifest: id, parent, status, started/finished, litmus version,
    │                                     #   selection, configs (no secrets), hashes
    ├── events.jsonl                      # every event, in order; the UI can replay a run from it
    ├── verdicts.json                     # Verdict[]
    ├── comparison.json                   # Comparison[], when there are any
    └── trials/<suite>/<case>/<config>/<n>/
        ├── trial.json                    # TrialRecord
        ├── transcript.jsonl              # TranscriptEntry per line
        └── artifacts/
```

The record shapes are the types in `src/core/types.ts`. Runs are append-only.
A rerun is a new run, and its `run.json` names the parent run it came from.
`run.json` also records each case's case hash, and a hash of each plugin root
the run loaded.

**Redaction.** Before anything is written to disk or printed by a reporter, the
exact values of these environment variables are replaced with `[REDACTED]`:

- `ANTHROPIC_API_KEY`
- `OPENROUTER_API_KEY`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_SESSION_TOKEN`
- `AWS_BEARER_TOKEN_BEDROCK`
- every variable named in `redact`

Redaction happens once, where events and records are produced, so events.jsonl,
the SSE stream, the CLI and every reporter get the same scrubbed text.
Credentials the AWS SDK resolves from a named profile never pass through
litmus's environment, so they are not in this set. SECURITY.md says so.

## Events

The runner emits one stream. The CLI renders it, the server forwards it as
server-sent events, and the store appends it to `events.jsonl`.

```ts
type RunEvent =
  | { type: 'run.started'; run: string; jobs: number }
  | { type: 'trial.queued' | 'trial.started'; key: string }
  | { type: 'trial.step'; key: string; step: { kind: 'message' | 'tool_call' | 'tool_result' | 'denied'; summary: string } }
  | { type: 'trial.usage'; key: string; usage: Usage }
  | { type: 'trial.retry'; key: string; attempt: number; reason: string }
  | { type: 'trial.finished'; key: string; status: 'pass' | 'fail' | 'error' | 'cancelled'; graders: { grader: string; pass: boolean }[] }
  | { type: 'case.settled'; case: string; config: string; verdict: Verdict }
  | { type: 'run.finished' | 'run.cancelled'; run: string; summary: Record<VerdictKind, number> }
```

## Server

`litmus serve` binds only to `127.0.0.1`. It enforces three checks against
other sites in the operator's browser, which could otherwise start runs that
spend the operator's money or read transcripts:

- **Host.** Every request must have a `Host` of exactly `127.0.0.1:<port>` or
  `localhost:<port>`. Anything else gets a 403.
- **Origin.** A request that changes state (POST, PUT or DELETE) must have an
  `Origin` of `http://127.0.0.1:<port>` or `http://localhost:<port>`. If the
  `Origin` is missing or different, it gets a 403.
- **CORS.** The server never sends CORS headers.

Run ids and trial keys are checked against their grammar. A trial key goes in
a query parameter, percent-encoded with `encodeURIComponent`, and the server
decodes it before checking. Unencoded, its `/` would split a path, and its `#`
would start a fragment that never reaches the server, in a path or a query.

| Method | Path | Does |
| - | - | - |
| GET | `/api/suites` | The case tree, with each case's latest verdict for each config |
| GET | `/api/configs` | Configured configs and judges, with no secrets |
| POST | `/api/runs` | Start a run: `{ select, configs, trials?, rerun?: { run, only: VerdictKind[] } }` |
| GET | `/api/runs` | Run history |
| GET | `/api/runs/:id` | Manifest, verdicts, comparison |
| GET | `/api/runs/:id/events` | Server-sent events: the backlog first, then the live stream |
| POST | `/api/runs/:id/cancel` | Cancel the run |
| GET | `/api/runs/:id/trial?key=<encoded trial key>` | Trial record, transcript and artifacts |
| GET | `/api/compare?a=&b=` | Compare two runs, using the forms under Addressing runs and comparisons |
| PUT | `/api/baselines/:name` | Set a baseline to a run |

The CLI runs in-process on the same runner module. The UI is a client of the
API and nothing else.

## UI

- **Toolbar:** Run all, Run selected, Rerun failed, Rerun flaky, Rerun
  errored and Cancel, plus a multi-select of configs and a trial count.
- **Tree:** suite → case → config → trial.
  - Each row has a checkbox, a status icon, and a counts badge
    (`✓ 12 ✗ 2 ~ 1 ! 0 ? 0`).
  - A text filter and status chips narrow the tree.
  - Status icons: queued (hollow), running (spinner), pass (green), fail
    (red), flaky (amber), error (grey), inconclusive (outlined), cancelled
    (struck through).
- **Detail pane** for a trial:
  - **Transcript:** a timeline of messages, tool calls and refusals, modelled
    on Playwright's UI mode.
  - **Graders:** each result with its reasoning and metrics.
  - **Findings:** matched bugs, missed bugs, false positives, decoy hits and
    nits, set against the ground truth.
  - **Usage:** tokens, cost, time and attempts.
- **Compare view:** a grid of cases × configs with a verdict in each cell. The
  flip list sits on top, next to the suite verdict and any WARN metrics.

## CLI

```
litmus list [select...]                          # the tree, with the latest verdicts
litmus run [select...] --config a,b [--trials N] [--baseline name]
           [--allow-flaky] [--allow-inconclusive] [--reporter pretty|json|ctrf|junit] [--out path]
litmus run --rerun <run> --only fail,flaky,error,inconclusive
litmus compare <side> <side> [--allow-inconclusive] [--out path]
litmus baseline set <name> <run>
litmus validate [select...]
litmus serve [--port 4317]
```

Every command takes `--config-file <path>` (default `./litmus.config.yaml`).

A selector is one of:

- `<suite>`
- `<suite>/<case>`
- a glob such as `code-review/go-*`
- `tag:<tag>`
- a trial key

A selector that matches nothing is an error. A trial-key selector limits a case
to that trial and ignores `--trials`.

Exit codes for `run`:

```
blocking = FAIL | REGRESSION
         | FLAKY                           unless --allow-flaky
         | INCONCLUSIVE (reason interval)  unless --allow-inconclusive
infra    = ERROR | INCONCLUSIVE (reason min_trials)

exit 2 on a usage or config error
else exit 1 if any verdict is blocking
else exit 3 if any verdict is infra      # CI can tell infrastructure trouble from a regression
else exit 0
```

Inside `run`, only a comparison's REGRESSION blocks. Its INCONCLUSIVE and NO
CHANGE are reported, and neither changes the exit code, since small suites
rarely have the evidence for NO CHANGE.

`compare` exits 0 on NO CHANGE or IMPROVEMENT, and 1 on REGRESSION. It also
exits 1 on INCONCLUSIVE, unless `--allow-inconclusive` is passed.

`validate` exits 0 when every case is valid and 1 otherwise. Warnings don't
affect its exit code.

Both exit 2 on a usage or config error.
