# Architecture

This file is the contract. Code that disagrees with it is a bug, or this file is
out of date, and both get fixed in the same pull request. Until 0.1.0, contracts
can change freely.

## Vocabulary

| Term | Meaning |
| - | - |
| Suite | A named directory of cases that share a purpose and default settings |
| Case | One scenario: its fixture, its prompt, the subject under test, its graders and its pass rule |
| Subject | What is being tested: a prompt, a system instruction, a skill or a plugin, at a specific content hash |
| Configuration | One named combination of provider, model, effort and executor settings. It is one column in a comparison |
| Trial | One execution of one case under one configuration. A case runs N trials per configuration |
| Run | A selection of cases × a set of configurations × N trials, executed once and stored |
| Executor | Takes a case, a configuration and a trial number, and produces a transcript, artifacts and usage |
| Provider | Gives an executor access to a model |
| Grader | Scores a trial: code (deterministic), judge (a pinned LLM), or a human label |
| Verdict | The settled outcome for one case under one configuration, computed from all its trials |
| Comparison | Two configurations over the same cases: the cases that flipped, and a suite-level verdict |
| Baseline | A stored run that later runs compare against |

IDs:

```
case id    <suite>/<case>                        code-review/go-token-expiry
trial key  <suite>/<case>@<config>#<n>           code-review/go-token-expiry@opus-5.5#3
run id     <utc timestamp>-<4 hex>               2026-09-24T15-04-05Z-a1b2
```

## Layout

```
src/
├── core/        # types, ids, hashing, errors: nothing here does I/O
├── suite/       # load and validate litmus.config.yaml, suite.yaml, case.yaml, truth.yaml
├── providers/   # anthropic, bedrock, openrouter, fake, all behind one interface
├── executors/   # model, harness (claude-code), fake
├── graders/     # regex, json-schema, file-exists, tool-used, command, review-match, judge
├── stats/       # intervals, pass@k and pass^k, verdict policies, paired comparison
├── runner/      # expand a selection into jobs, schedule them, retry, cancel, emit events
├── store/       # write and read runs on disk, baselines
├── report/      # pretty terminal output, CTRF, JUnit, JSON
├── server/      # HTTP API and server-sent events on 127.0.0.1
└── cli/         # litmus list | run | compare | baseline | validate | serve
ui/              # Vue 3 + Vite single-page runner, a client of the server
suites/examples/ # smoke, canaries, code-review: examples only, never a release gate
test/            # node --test, plus Playwright for the UI
```

## Configuration: `litmus.config.yaml`

This file lives where you run litmus. Suite roots are searched in the order
listed, and a suite name must be unique across all of them.

```yaml
suites:
  - ./suites/examples
  - ../private-evals/suites          # gating suites live outside this repo
results: ./.litmus/runs
concurrency: 4
retries: 2                           # retries per trial, for infra errors only

configs:
  opus-5.5:
    provider: anthropic
    model: claude-opus-5-5
    effort: medium
  opus-5.5-bedrock:
    provider: bedrock
    model: <bedrock inference profile id>
    region: us-east-1
    effort: medium
  sonnet-5-or:
    provider: openrouter
    model: anthropic/claude-sonnet-5
  fake:
    provider: fake

judges:
  default:
    provider: anthropic
    model: claude-haiku-4-5-20251001

pricing:                             # USD per million tokens, used when a provider reports no cost
  claude-opus-5-5: { input: 4, output: 20 }
```

Keys never appear in this file. Each provider reads its key from the standard
environment variables: `ANTHROPIC_API_KEY`, the AWS credential chain, and
`OPENROUTER_API_KEY`.

## Suite and case files

```
suites/examples/code-review/
├── suite.yaml
└── cases/
    └── go-token-expiry/
        ├── case.yaml
        ├── prompt.md
        ├── fixture/            # the only thing the subject ever sees
        ├── change.patch        # optional: the change under review, applied on a branch
        ├── truth.yaml          # ground truth, never copied into the workdir
        ├── fix/                # one patch per seeded bug
        └── fake.yaml           # scripted responses, used only by the fake provider
```

`suite.yaml`:

```yaml
name: code-review
description: Seeded-bug review of small codebases
defaults:
  trials: 3
  policy: all                  # all | rate
  threshold: 0.8               # rate policy only
  timeout_s: 600
  tags: [review]
```

`case.yaml`:

```yaml
name: go-token-expiry
description: An off-by-one in token expiry. Flagging the constant-time compare is a false positive
expect: pass                   # pass | fail. A canary expects fail, and an unexpected pass counts as FAIL
subject: ../../../../skills/review/SKILL.md   # optional; its content hash becomes the subject version
executor:
  kind: model                  # model | harness
  prompt: prompt.md            # {{fixture}} expands to every fixture file, with paths and line numbers
  max_tokens: 8000
# executor:
#   kind: harness
#   harness: claude-code
#   prompt: "/review"
#   plugins: [../../../../plugins/code-reviewer]
#   setting_sources: [project]   # load CLAUDE.md from the fixture
#   max_turns: 60
#   allow_shell: false
#   allow_network: false
graders:
  - kind: json-schema
    artifact: findings.json
    schema: litmus:findings
  - kind: review-match
    window: 5
    pass: { min_recall: 1.0, max_false_positives: 1, max_decoy_hits: 0 }
trials: 5
tags: [go, security]
```

`truth.yaml`:

```yaml
kind: seeded                   # seeded | clean
bugs:
  - id: expiry-off-by-one
    file: internal/auth/token.go
    lines: [41, 44]
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

`litmus validate` checks every seeded bug in two steps. First the proof command
runs against the fixture, and it must fail. Then the bug's fix is applied, the
proof runs again, and it must pass. A case that fails validation cannot be run.

The `litmus:findings` schema is what a reviewer produces:

```ts
type Finding = {
  file: string
  line: number               // or start_line + end_line
  end_line?: number
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  category?: string
  title: string
  explanation: string
  fix?: string
}
type Findings = { findings: Finding[] }
```

## Flow of a run

```
run = select(cases) × configs × trials(case)
write run.json                       # resolved configs, suite and subject hashes, judge hashes, litmus version

for each job, at most `concurrency` at once:
    workdir = copy(case.fixture)     # git-initialised; change.patch goes on branch litmus/change
    result  = executor(case, config, trial, workdir, events)
    match result.exit:
        ok            -> grade it
        model_failure -> status fail (timeout, max turns, unparseable output: the model did it)
        infra_error   -> retry with backoff up to `retries`, then status error
    write trial.json, transcript.jsonl, artifacts/
    when every trial of (case, config) is done:
        verdict = policy(trials)
        emit case.settled

when every job is done:
    write verdicts.json
    if the run has more than one config, or --baseline was given:
        write comparison.json
```

A timeout or a max-turns stop is a **model failure**, not an infra error. A
review that never converges is exactly what litmus is meant to catch, so it
must never be retried away.

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
    effort?: 'low' | 'medium' | 'high' | 'max'
    signal: AbortSignal
  }): Promise<{
    text: string
    usage: { input_tokens: number; output_tokens: number; cost_usd?: number }
    raw: unknown                   // the provider's response, stored with the transcript
  }>
}
```

Provider errors are classified at the boundary. Throttling, 5xx responses,
network failures and auth failures become `InfraError`. A refusal or a
truncated response is returned as text, and graders judge it.

### Executor

```ts
interface Executor {
  kind: 'model' | 'harness' | 'fake'
  execute(job: {
    case: Case; config: Config; trial: number; workdir: string
    emit: (e: TrialEvent) => void; signal: AbortSignal
  }): Promise<{
    exit: 'ok' | 'model_failure' | 'infra_error'
    reason?: string
    artifacts: Record<string, string>     // name -> path under the trial's artifacts dir
    transcript: string                    // path to transcript.jsonl
    usage: { input_tokens: number; output_tokens: number; cost_usd?: number }
    wall_clock_ms: number
  }>
}
```

- **`model`** renders the prompt, including the subject as the system prompt
  when there is one. It makes one provider call and writes `response.txt`. It
  also writes `findings.json` when the response contains a JSON object that
  parses. It never reads `truth.yaml`.
- **`harness: claude-code`** drives Claude Code through
  `@anthropic-ai/claude-agent-sdk`, with `cwd` set to the workdir. It loads
  the plugins from the case, and loads `CLAUDE.md` from the fixture when
  `setting_sources` includes `project`. Every tool call passes through a
  default-deny gate:
  - File tools may only touch paths inside the workdir.
  - Shell and network are refused unless the case allows them.
  - Every refusal is recorded in the transcript.
  - The provider maps to an environment: `anthropic` uses the API key or the
    existing login, and `bedrock` sets `CLAUDE_CODE_USE_BEDROCK=1`.
  - Artifacts are the files the subject wrote plus its final message.

### Grader

```ts
interface Grader {
  kind: string
  grade(trial: TrialResult, ctx: { case: Case; truth?: Truth; judges: Judges }): Promise<{
    grader: string
    pass: boolean
    score?: number                         // 0..1
    metrics?: Record<string, number>
    rationale?: string                     // shown in the UI, including on a pass
  }>
}
```

A trial passes when every one of its graders passes.

| Grader | Passes when |
| - | - |
| `regex` | The pattern matches the artifact or the transcript between `min` and `max` times |
| `json-schema` | The artifact parses and validates against the schema |
| `file-exists` | The subject created (or did not create) the path |
| `tool-used` | A tool was called between `min` and `max` times, read from the transcript. Useful for capping subagent fan-out |
| `command` | A shell command run in the workdir after the trial exits 0 |
| `review-match` | Findings matched against `truth.yaml` meet the case's `pass` bounds (below) |
| `judge` | A pinned binary judge answers yes (below) |

**`review-match`** pairs findings with bugs one-to-one, starting with the
closest pair.

- A pair matches when the file is the same and the line ranges fall within
  `window` lines of each other.
- An unmatched finding counts as a **decoy hit** if it lands on a decoy.
- Otherwise it counts as a **nit** if its severity is `info` or `low`.
- Otherwise it counts as a **false positive**.

Its metrics:

```
recall    = matched / bugs
precision = matched / (matched + false_positives + decoy_hits)
```

On a `clean` case there are no bugs, so recall is undefined. Only the
false-positive and decoy bounds apply.

**`judge`** is identified by its provider, model, prompt and parameters,
hashed together. Every result records that hash, and a run refuses to compare
two results whose judge hashes differ. A judge answers one yes-or-no question
and returns `{ pass, rationale }`. It asks nothing on a scale.

### Verdicts

Under `policy: all`, the default, the verdict is computed from the trials that
finished with a score:

```
scored = trials with status pass | fail
if scored is empty:                 ERROR
elif len(scored) < min_trials:      INCONCLUSIVE    # too many trials ended in error
elif every scored trial passed:     PASS
elif none passed:                   FAIL
else:                               FLAKY
```

`policy: rate` is for capability suites, where a pass rate below 100% is
expected:

```
ci = wilson_95(passes, len(scored))
if ci.lo >= threshold:              PASS
elif ci.hi < threshold:             FAIL
elif 0 < passes < len(scored):      FLAKY
else:                               INCONCLUSIVE
```

When a case has `expect: fail`, PASS and FAIL are swapped before the verdict is
stored. A canary that passes becomes FAIL, labelled "unexpected pass".

Every verdict also stores the pass rate, its Wilson interval, and pass^k and
pass@k for k = the trial count. Both use the unbiased combinatorial estimators.

### Comparison

A comparison takes configuration A (the baseline) and configuration B over the
cases both ran.

- **Flips.** Every case whose verdict changed is listed, with the old and new
  verdicts. This is the headline of the comparison, not a footnote.
- **Suite verdict.** d = the mean over cases of B's pass rate minus A's. Its 95%
  interval comes from a paired bootstrap over cases, 2,000 resamples with a
  seeded PRNG, so a comparison is reproducible. The tolerance δ defaults to
  0.05:

  ```
  if ci.hi < -δ:                 REGRESSION
  elif ci.lo > δ:                IMPROVEMENT
  elif -δ <= ci.lo and ci.hi <= δ:   NO CHANGE
  else:                          INCONCLUSIVE    # run more trials
  ```

- **WARN.** Raised when the ratio of B's median to A's falls outside
  [1/1.5, 1.5] for tokens, cost, wall-clock time, tool calls, or findings per
  case, even if every verdict is unchanged. Verbosity and fan-out drift
  without any single case failing, so pass/fail alone misses them.

## Storage

```
.litmus/
├── baselines.json                        # { "<name>": "<run id>" }
└── runs/<run id>/
    ├── run.json                          # manifest
    ├── events.jsonl                      # every event, in order; the UI can replay a run from it
    ├── verdicts.json
    ├── comparison.json                   # when there is one
    └── trials/<suite>/<case>/<config>/<n>/
        ├── trial.json
        ├── transcript.jsonl
        └── artifacts/
```

Runs are append-only. A rerun is a new run, and its `run.json` names the
parent run it came from.

## Events

The runner emits one stream. The CLI renders it, the server forwards it as
server-sent events, and the store appends it to `events.jsonl`.

```ts
type RunEvent =
  | { type: 'run.started'; run: string; jobs: number }
  | { type: 'trial.queued' | 'trial.started'; key: string }
  | { type: 'trial.step'; key: string; step: { kind: 'message' | 'tool_call' | 'tool_result' | 'denied'; summary: string } }
  | { type: 'trial.usage'; key: string; usage: Usage }
  | { type: 'trial.finished'; key: string; status: 'pass' | 'fail' | 'error'; graders: GraderSummary[] }
  | { type: 'case.settled'; case: string; config: string; verdict: Verdict }
  | { type: 'run.finished' | 'run.cancelled'; run: string; summary: Summary }
```

## Server

`litmus serve` binds to `127.0.0.1` only. It rejects any request whose `Host`
is not its own address, and any mutating request whose `Origin` is not its own
page. Otherwise another site open in the browser could start runs that spend
the operator's money.

| Method | Path | Does |
| - | - | - |
| GET | `/api/suites` | The case tree, with each case's latest verdict for each config |
| GET | `/api/configs` | Configured configs and judges, with no secrets |
| POST | `/api/runs` | Start a run: `{ select, configs, trials?, rerun?: { run, only: 'failed' \| 'flaky' } }` |
| GET | `/api/runs` | Run history |
| GET | `/api/runs/:id` | Manifest, verdicts, comparison |
| GET | `/api/runs/:id/events` | Server-sent events: the backlog, then the live stream |
| POST | `/api/runs/:id/cancel` | Cancel the run |
| GET | `/api/runs/:id/trials/:key` | Trial record, transcript, artifacts |
| GET | `/api/compare?a=&b=` | Compare two runs or configs |
| PUT | `/api/baselines/:name` | Set a baseline to a run |

The CLI runs in-process on the same runner module. The UI is a client of the
API and nothing else.

## UI

- **Toolbar:** Run all, Run selected, Rerun failed, Rerun flaky and Cancel,
  plus a multi-select of configs and a trial count.
- **Tree:** suite → case → config → trial.
  - Each row has a checkbox, a status icon, and a counts badge
    (`✓ 12 ✗ 2 ~ 1 ! 0`).
  - A text filter and status chips narrow the tree.
  - Status icons: queued (hollow), running (spinner), pass (green), fail
    (red), flaky (amber), error (grey), inconclusive (outlined).
- **Detail pane** for a trial:
  - **Transcript:** a timeline of messages, tool calls and refusals, modelled
    on Playwright's UI mode.
  - **Graders:** each result with its reasoning and metrics.
  - **Findings:** a table of matched, missed, false-positive and decoy hits,
    set against the ground truth.
  - **Usage:** tokens, cost and time.
- **Compare view:** a grid of cases × configs with a verdict in each cell. The
  flip list sits on top, next to the suite verdict and any WARN metrics.

## CLI

```
litmus list [select]                          # the tree, with the latest verdicts
litmus run [select...] --config a,b --trials N [--baseline name] [--reporter pretty|json|ctrf|junit] [--out path]
litmus run --rerun <run> --only failed|flaky
litmus compare <run|config> <run|config>
litmus baseline set <name> <run>
litmus validate [select]                      # schemas, proofs, fixes
litmus serve [--port 4317]
```

A selector is `<suite>`, `<suite>/<case>`, a glob such as
`code-review/go-*`, `tag:go`, or a trial key.

| Exit | Meaning |
| - | - |
| 0 | Every verdict PASS, and no REGRESSION |
| 1 | Any FAIL, FLAKY (unless `--allow-flaky`) or REGRESSION |
| 2 | Usage or config error |
| 3 | Only ERROR verdicts kept it from being 0. CI can tell infrastructure trouble apart from a regression |
