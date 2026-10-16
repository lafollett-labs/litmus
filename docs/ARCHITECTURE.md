# Architecture

This file is the contract. Code that disagrees with it is a bug, or this file is
out of date, and both get fixed in the same pull request. Before 1.0.0, a minor
version may change any contract here; the CHANGELOG records each change.

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
├── validate/    # checks each case on a disposable copy, and runs each seeded bug's proof
└── cli/         # litmus list | run | compare | baseline | validate | serve
ui/              # Vue 3 + Vite single-page runner, a client of the server
suites/examples/ # smoke, canaries, code-review: examples only, never a release gate
test/            # node --test, plus Playwright for the UI
litmus.config.yaml   # this repository's own config: the example suites, the fake provider,
                     #   and a live anthropic config (sonnet-5) with its pricing
```

## Configuration: `litmus.config.yaml`

This file lives where you run litmus. Suite roots are searched in the order
listed, and a suite name defined under two roots is an error. So is a root
that holds no suite, a directory under a root with `suite.yml` or `cases/` but
no `suite.yaml`, a suite with no case under `cases/`, and a broken symlink
under a root or `cases/`. Entries whose
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
  warn_ratio: 1.5

redact: []                           # extra environment variable names whose values are scrubbed from output
```

Each `redact` entry must be an environment variable name
(`^[A-Za-z_][A-Za-z0-9_]*$`), not a value.

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
| `warn_ratio` | > 1 |

Keys never appear in this file. Each provider reads its key from the standard
environment variables: `ANTHROPIC_API_KEY`, the AWS credential chain, and
`OPENROUTER_API_KEY`. The Anthropic provider uses `ANTHROPIC_API_KEY` and
nothing else. It never falls back to `ANTHROPIC_AUTH_TOKEN` or to a saved login
profile, whose `base_url` could send the eval to another host and bill another
account. A Bedrock config takes its region from `region`, then `AWS_REGION`,
then `AWS_DEFAULT_REGION`, and an empty value counts as unset. With none of
them set, a run that would use the config, or a judge on bedrock that a
selected case calls, is refused with a config error (exit 2) before it
starts. A config the run only names, with no trial on it, is not checked.

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

`fake.yaml` is the suite author's own script, and it stands in for the model.
It can therefore read its `text_file` from anywhere the author points it,
including a case's `truth.yaml`. Scripting the right answer is how the grading
pipeline is tested for $0, and under a `fake` config there is no subject to hide
anything from. A judge may not use the `fake` provider: `fake.yaml` scripts
the subject, trial by trial, so a fake judge would read the subject's scripted
reply as its verdict. Grading on a fake config uses graders that need no judge.

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
| `expect` | `pass` |
| `executor.max_tokens` (model) | 8000 |
| `executor.max_turns` (harness) | 30 |
| `executor.setting_sources`, `plugins` | `[]` |
| `executor.allow_shell`, `allow_network`, `allow_hooks` | `false` |
| `extract.from`, `extract.to` | `final_message`, `findings.json` |
| grader `target` (regex, judge) | `transcript` |
| grader `min` (regex, tool-used) | 1 |
| `regex.flags` | none: JavaScript `RegExp` flags such as `i` or `m`; `g` is always added, and the pattern must compile with its flags at load |
| `file-exists.exists` | `true` |
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
`proof/`; its real path is checked as well as the one written. A directory
subject is never sent to the model, only hashed. This rule catches authoring
mistakes, such as a wrong relative path. It is not a boundary against the
suite's own author, who writes the prompt and could put the answers in it
directly. That is why a hard link, which has a path of its own, is not chased.

A case directory may hold no symlink (entries named `.git` or `.DS_Store`
aside, which the case hash skips). A run that selects such a case is refused
when it hashes the case, and `validate` reports it.

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

Every bug needs `category`, `proof` and `fix`, and its `fix` file must exist
when the case loads. A seeded case has at least one bug, and a clean case has
none. Bug and decoy ids are unique across both lists.

The `litmus:findings` schema is what a reviewer produces. Line numbers refer
to the tree the subject saw, which is the post-change tree. It is model output,
so extra keys (a `confidence`, a top-level `summary`) are allowed and ignored.
A missing or mistyped required field fails:

```ts
type Finding = {
  file: string
  line: number               // first line, >= 1
  end_line?: number          // last line, inclusive, >= line; defaults to line
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  category?: string
  title: string
  explanation: string
  fix?: string
}
type Findings = { findings: Finding[] }
```

### `litmus validate`

`validate` loads the suites as `run` does, so it checks the schemas, the file
references and the rules above. A suite or case that fails to load (a
`min_trials` above `trials`, a `rate` threshold outside (0, 1), an unknown
judge name, any other load error) stops it before any case is checked: it
prints the error and `invalid: the suites do not load`, and exits 1.

It then checks each selected case on a disposable copy of its post-change
tree, never on the suite itself, and runs every seeded bug's proof on a copy
of its own:

```
for each seeded bug:
    copy = temp copy of fixture/ → apply change.patch → overlay proof/
    run bug.proof in copy (scrubbed env)       → must exit non-zero
    apply bug.fix to copy; run bug.proof again → must exit 0
```

It fails a case in any of these situations:

- the case directory holds a symlink, or anything that is neither a file nor
  a directory (`.git` and `.DS_Store` aside). This is reported first, and
  nothing else is checked for the case
- the post-change tree cannot be built (see Sandbox): the fixture holds a
  `.git` entry, `change.patch` does not apply, or the patch creates a symlink
- a harness case's plugins, or under `setting_sources: [project]` its
  fixture, declare hooks or MCP servers without `allow_hooks: true`, or break
  another plugin rule (see the harness executor)
- a harness case with `setting_sources: [project]` has a fixture
  `.claude/settings.json` (or `settings.local.json`) that sets any key other
  than `$schema`
- a harness case's plugin lies inside a suite, or contains one
- `proof` is not a directory or cannot be read, or a `proof/` path also
  exists in the post-change tree, runs through a file there, or is (or
  contains) a `.git` entry
- a bug's or decoy's `file` is not a regular file in the post-change tree,
  spelled exactly as on disk (review-match compares paths case-sensitively),
  or its `lines` run past the end of it
- a suite root lies inside a harness case's subject root
- for a seeded bug, any of:
  - its `fix` lies outside the case (links followed), or does not exist
  - its proof passes before the fix, or times out before the fix
  - the fix does not apply after `change.patch`
  - its proof still fails with the fix applied
  - its fix changes a `proof/` file or adds to a directory only `proof/`
    made (a fix that rewrote its proof would pass it without touching the
    bug; what the proof itself changes on its first run is not counted)

It warns in three situations:

- a `rate`-policy case has fewer trials than the policy needs to return PASS
  (see Verdicts)
- a pass bound is set on a metric that can never be defined for the case, such
  as `min_recall` on a clean case
- a bug's fix leaves the bug's own `file` unchanged, so its proof may be cured
  some other way (a Go `TestMain` that exits 0, say)

`run` makes the load checks too. Before the run starts, it also refuses with
a config error (exit 2) a selected case whose directory holds a symlink, a
bedrock config with no region, and a harness case on a provider other than
`anthropic` or `bedrock`. The workdir and harness checks (a symlink after the
patch, a fixture `.git`, hooks, MCP and fixture settings, a plugin in or
around a suite) it makes per trial, as each attempt's workdir is built and its
session starts. Each one makes that trial an `error`, so the case settles
ERROR and `run` exits 3. Only `validate` reports these before anything is
spent. The `proof/`, `fix`, ground-truth and subject-root checks, the warnings and the
proof runs are `validate`'s alone. (In a run, the harness gate simply denies
reads under a suite root.) A proof is a suite author's command, run as the
command grader runs one: in its own process group, with a scrubbed env and the case's
`timeout_s`. Ctrl-C or SIGTERM kills that group, removes the copy, and exits
130 or 143 with nothing reported, since a cut-short validate vouches for no
case.

## Flow of a run

```
run = select(cases) × configs × trials(case)
write run.json                           # resolved configs (no secrets); case, subject, judge and plugin hashes

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
        result.exit == model_failure                -> fail        # graders ran for metrics only; a grading error goes in the reason
        grading raised InfraError after retries     -> error
        every grader passed                         -> pass
        else                                        -> fail
    write trial.json, transcript.jsonl, artifacts/   # usage summed over every attempt
    when every trial of (case, config) is settled:
        verdict = policy(trials); emit case.settled

on finish or cancel:
    write verdicts.json                  # settled cases only
on finish, if the run has more than one config, or --baseline was given:
    compare                              # a cancelled run compares nothing
    if at least one comparison resulted:
        write comparison.json
```

| How the executor stopped | `exit` | Retried | Trial status |
| - | - | - | - |
| It finished, including a refusal, a truncation or unparseable output | `ok` | No | `pass` or `fail`, decided by the graders |
| A harness timeout or max turns | `model_failure` | Never | `fail` |
| A model-executor timeout, throttling (408, 409, 429), 5xx or network | `infra_error` (retryable) | Up to `retries`, with backoff | `error` once the retries run out |
| The harness's Agent SDK threw, or its session ended with no result message | `infra_error` (retryable) | Up to `retries`, with backoff | `error` once the retries run out |
| Auth failure (including a harness API-error turn with no status whose text names auth or billing), another 4xx, or a missing key | `infra_error` (not retryable) | Never | `error` |
| The operator cancelled | `cancelled` | Never | `cancelled` |
| The workdir could not be built (a patch that no longer applies), or an executor threw | none | Only a retryable `InfraError` | `error`, with the reason; the run goes on |
| The trial threw outside its attempts (the store could not move its files) | none | Never | `error`, with the reason; the run goes on |

A trial with no executor result records `exit: infra_error`, whatever the
reason says.

A review loop that never converges is exactly what litmus is meant to catch, so
a harness timeout or max-turns stop is a model failure, and it is never
retried. A single model call that times out is almost always a stalled
connection, so for the `model` executor a timeout is a retryable infra error.
A timeout and a cancel travel on different abort reasons, so they can't be
confused. An answer that arrives after either has fired is classified by it,
never accepted: a provider or SDK that answers late did not answer in time.
The model executor races the call against the clock, so a provider that
ignores its signal and never settles still times out.

Retries back off exponentially (1 s, 2 s, 4 s ... up to 30 s), each step
jittered down to as little as half its length, and a cancel cuts a backoff
short. Once a run is cancelled no new trial starts, the
ones in flight end `cancelled`, and no further case settles. The run writes the
verdicts of the cases that settled before it stopped.

A grading retry emits `trial.retry` too, with its reason prefixed `grading:`.
A listener that throws is ignored, so a closed SSE socket never stops a run.
If litmus cannot record even an error trial (the store cannot be written),
every worker stops, `run.failed` is emitted, `run.json` is marked `failed`,
and the run rejects with the error. The listener hears every event whether or
not the store could record it, so a live view sees `run.failed` even when the
store is what failed. A run that names one config twice is refused before it
starts.

A workdir is removed when its attempt ends. A subject can leave directories it
cannot write (Go's module cache under `HOME` is read-only), so when the first
removal fails every directory in the workdir is made writable, without
following links, and removal is tried again. A workdir that still will not go
is reported in the run's notes. It never changes the trial's status or
record.

What a case's hash covers, and which trials WARN's medians use, is in
§ Comparison.

**Effective `min_trials`.** A run can ask for fewer trials than the case
defines, through `--trials`, a trial-key selector, the UI, or a rerun. The
verdict then uses `min(min_trials, trials requested)`. When `min_trials` is not
set, it defaults to ceil(requested / 2). Running one passing trial is PASS, not
INCONCLUSIVE.

## Sandbox

**Workdirs.** Each attempt gets a fresh root,
`os.tmpdir()/litmus/<run>/<key-slug>-<key-hash>-<attempt>/`, where the key
hash is the first 12 hex digits of the trial key's SHA-256. The hash keeps two
keys that slug alike apart. The root holds `work/` (the workdir, the subject's
cwd), `home/` (`HOME` for child processes) and `claude/` (`CLAUDE_CONFIG_DIR`
for the harness), and the whole root is removed when the attempt is done with
it. The workdir is used by its real path,
so a `TMPDIR`, or a `litmus/` under it, that is a symlink is judged where it
lands. It is never placed inside the results store or a suite root, compared
case-folded. Nor is it placed anywhere with instructions in its real
ancestors that Claude Code would load: `CLAUDE.md`, `CLAUDE.local.md`,
`AGENTS.md`, `.claude/CLAUDE.md` or `.claude/rules/`. It is built in five steps:

1. `fixture/` is copied. A fixture that is itself a symlink is refused, as is
   a symlink inside it, a `.git` entry in any case (`.GIT` is
   `.git` on a case-insensitive volume), or anything that is not a regular file
   or directory (a FIFO, a socket) is refused.
2. `git init`, and the tree is committed on `main`.
3. If the case has a `change.patch`, the branch `litmus/change` is created
   with the patch committed on it. `HEAD` is `litmus/change`.
4. The post-change tree is scanned again, `.git` included, and any symlink is
   refused. A patch can create one.
5. The builder takes a snapshot of every file (path, size and hash).

Git runs only while the workdir is being built, before the subject starts. Its
environment holds only `PATH`, `HOME` (set to the workdir),
`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` and
`GIT_TERMINAL_PROMPT=0`. Every call passes `-c core.hooksPath=/dev/null`,
`core.fsmonitor=false`, `maintenance.auto=false`, `gc.auto=0`,
`commit.gpgsign=false`, `user.name=litmus` and `user.email=litmus@localhost`.
`maintenance.auto` and `gc.auto` stop a detached git from outliving the
build. The gate also refuses the subject any write under `<workdir>/.git/`.

After the executor exits, **the files the subject wrote** are found by
comparing against the snapshot, not by asking git. Files are read without
following a link or blocking on a FIFO, and an artifact is copied only if its
bytes still hash to what the snapshot saw. That way nothing the
subject wrote into `.git/` ever runs.

**Child processes.** Litmus spawns three kinds of child process: the harness,
`command` graders and `validate` proofs. Each one gets a scrubbed environment:

- `PATH`, `LANG`, `LC_*`, `TERM` and `TMPDIR`.
- `HOME`, pointed at the attempt's `home/`.
- The toolchain variables `GOCACHE`, `GOMODCACHE`, `GOPATH`, `GOFLAGS`,
  `GOTOOLCHAIN` and `npm_config_cache`, when they are set. `GOFLAGS` and
  `GOTOOLCHAIN` are the operator's own settings, so they carry through to the
  `go` runs in `command` graders and proofs (`GOTOOLCHAIN=local` makes a case
  that needs a newer Go fail instead of downloading one).
- For the harness only: the credential variables its provider needs (for
  `anthropic`, `ANTHROPIC_API_KEY`; for `bedrock`, the region as `AWS_REGION`,
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`,
  `AWS_BEARER_TOKEN_BEDROCK`, whichever are set, and with `AWS_PROFILE`, also
  `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE`, defaulting to the
  operator's `~/.aws` files), `CLAUDE_CONFIG_DIR`, and
  the Claude Code flags listed under the harness executor.

This keeps credentials out of the environment and out of the usual dotfile
locations. **It does not contain a hostile process**, which can still read any
file the operator can read. Four paths are uncontained until the container
executor lands (see "After 0.1.0" in the plan):

- a `command` grader, which runs code the subject may have written
- a `validate` proof, which runs a suite author's command
- `allow_shell`, which gives the subject a real shell
- `allow_hooks`, which runs plugin and project hooks

A shell command, hook or MCP server started by the harness is a child of the
harness process, so it inherits the harness's credentials.

A `command` grader leads its own process group, and the whole group is killed
when the shell exits or times out. A process that leaves the group (`setsid`)
is not killed. Once the shell has exited, the grade waits 2 s for the rest of
its output and then finishes on the shell's exit code.

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
- Not retryable: auth failures, other 4xx responses, and a missing key. The
  same request would fail again, so the trial settles as `error` without using
  up its retries.

An AWS credential failure is retryable. Resolving credentials goes over the
network (SSO, IMDS, STS), and an empty chain fails before anything reaches the
model. The error carries the credential provider's own message, such as an
expired SSO session's `aws sso login` hint.

An OpenRouter answer's content may be a string or an array of parts. A
refusal arrives in its own field, and it is the answer when there is no
content. An empty answer is the model's result only when its finish reason says
why (`length` or `content_filter`). Otherwise it is a retryable infra error,
since that is how an upstream hiccup looks through OpenRouter. OpenRouter can
also report a failure inside a 200: a top-level `error`, an `error`
on the choice, `finish_reason: "error"`, or no choice at all. None of these is
an answer to grade, so each is an `InfraError`, classified by its code as an
HTTP status would be (with no code, retryable).

A refusal or a truncated response is returned as text, and the graders judge
it. SDK retries are turned off, because the runner owns retries. Server-side
model fallbacks are never enabled: a fallback answers with a different model,
and an eval that silently measures the wrong model is worse than an ERROR. The
config refuses at load each provider's switch for them: Anthropic's
`fallbacks` (on an `anthropic` or a `bedrock` config), and OpenRouter's
`models`, `route` and `openrouter/auto`. OpenRouter's routing between hosts of the same model is not a model fallback,
and stays on.

Usage counts cached input tokens (cache reads and writes) as input tokens. When
a provider reports no cost, the pricing fallback prices all of them at the full
input rate. That is approximate: cache reads are overpriced (they bill at about
0.1×), and cache writes are underpriced by up to 2×. For a bring-your-own-key
OpenRouter request, cost is OpenRouter's fee plus the upstream charge it reports.
If the upstream charge is missing, no cost is recorded and the pricing fallback
estimates it.

### Executor

```ts
type ExecJob = {
  key: string                                    // trial key
  case: LoadedCase
  configName: string
  config: ConfigDef
  trial: number
  attempt: number
  workdir: Workdir
  suiteRoots: string[]                           // every configured suite root: the gate never lets a subject reach one
  out: { artifacts: string; transcript: string } // owned by the store; the executor writes here
  pricing: ConfigFile['pricing']
  emit: (e: RunEvent) => void
  redact: Redactor                               // applied to everything the executor writes or emits
  signal: AbortSignal                            // the operator's cancel
}
type Executor = (job: ExecJob) => Promise<ExecutorResult>
type ExecutorResult = {
  exit: 'ok' | 'model_failure' | 'infra_error' | 'cancelled'
  reason?: string
  retryable?: boolean                            // infra_error only
  artifacts: Record<string, string>              // name -> absolute path
  transcript: string                             // absolute path to transcript.jsonl
  usage: Usage
  wall_clock_ms: number
}
```

**`model`** makes one provider call.

- **Prompt.** The prompt can use three placeholders:
  - `{{fixture}}`: every file in the workdir apart from `.git/`, each with its
    path and line numbers
  - `{{diff}}`: the contents of `change.patch`
  - `{{file:<path>}}`: a single file from the workdir

  A file that holds a NUL byte renders as `=== name === (binary, N bytes)`.
  A `{{file:…}}` that points outside the workdir, or cannot be read, is a
  config error, and the trial is an `error`.
- **System prompt.** The subject's content, when the case has a subject.
- **Artifacts.** It always writes `response.txt`. It writes `findings.json`
  when the response has a JSON object to extract: the last ```` ```json ````
  fenced block if there is one, otherwise the whole response if that parses
  as a JSON object. When neither exists, `findings.json` is not written. A
  `json-schema` grader then fails the trial; it is not a model failure.
- **Reason.** When the provider reports a stop reason, an `ok` trial records
  it as `reason: "stop_reason: <x>"`.

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
- `CLAUDE_CONFIG_DIR` is the attempt's fresh `claude/` directory, and
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and
  `ENABLE_CLAUDEAI_MCP_SERVERS=false` are set. `persistSession: false` is
  passed. MCP config is always strict, with no configured servers
  (`strictMcpConfig: true`, `mcpServers: {}`); `allow_hooks` only lets a
  plugin's or the fixture's MCP declarations past the refusal below.
- The case's plugins are loaded. A plugin, or under
  `setting_sources: [project]` the fixture, that would start a host process
  is refused unless the case sets `allow_hooks: true`. That means
  hooks, MCP servers or LSP servers, and they are uncontained, like
  `allow_shell`. The rules for plugins:
  - `plugin.json` may hold only the keys `name`, `version`, `description`,
    `author`, `homepage`, `repository`, `license`, `keywords`, `commands`,
    `agents`, `skills` and `$schema`. `allow_hooks` also admits the process
    keys (`hooks`, `mcpServers`, `lspServers`, `monitors`, `statusLine`); any
    other key is refused either way.
  - `commands`, `agents` and `skills` are a path or a list of paths, and each
    must resolve inside the plugin.
  - `.claude-plugin` must be a directory and `plugin.json` a regular file.
    A FIFO or device anywhere in the tree is refused, and so is a socket
    where a component would be read.
  - The plugin may not ship `hooks/hooks.json`, `.mcp.json`, `.lsp.json` or
    `monitors/monitors.json`.
  - It may not be a symlink, or contain one anywhere.
  - It may not lie inside a suite, nor contain one: its manifest could point a
    component into the suite, and the loader reads it before the gate runs.
  - Every markdown file in it, its `.git` included, has its frontmatter
    checked. The frontmatter is read with Claude Code's own fence (the closing
    `---` need not start a line) and with the strict one. It must parse, every
    top-level key must be a plain string, and none may be a `<<` merge key.
    That refuses outright the shapes Claude Code's YAML reads differently from
    the spec (a quoted `<<` merges there, and `[hooks]` becomes `hooks`). No
    key may be `hooks`, `mcpServers`, `lspServers`, `monitors`, `statusLine`
    or `isolation`. Under `setting_sources: [project]`, the same goes for
    markdown under a fixture `.claude/` directory at any depth, and a fixture
    `.mcp.json` needs `allow_hooks`. Without `[project]` the fixture's hooks,
    MCP and `.claude/` files are not scanned.
  - `allow_hooks: true` waives only the process signals (the process files,
    manifest keys and frontmatter keys above). A symlink, a key that isn't
    plain, a merge key, a parse failure and `isolation` are refused either
    way, since they are the gate's own checks.
  - A plugin that lies inside a suite root is refused before the session
    starts: the gate would deny every read of its own files.
- Credentials: `anthropic` requires `ANTHROPIC_API_KEY`, and a claude.ai login
  is never used. `bedrock` sets `CLAUDE_CODE_USE_BEDROCK=1` and passes the AWS
  credential variables, including `AWS_BEARER_TOKEN_BEDROCK`. With
  `AWS_PROFILE`, it points `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE`
  at the operator's own files, because `HOME` is redirected. A run that pairs
  a harness case with a config on any other provider (`openrouter`, `fake`)
  is refused with a config error before it starts.
- `maxTurns` comes from the case, and the trial's timeout aborts the session.
- **Result.** A turn that ends on an API error arrives as a `success` result
  with `is_error` set, and its text is the error. It is an `infra_error`,
  classified by `api_error_status` like any provider error, and never graded.
  Tokens come from `modelUsage`, which covers every model call in the session,
  subagents included; `usage` covers the main loop only. Cost is
  `total_cost_usd`.

Every tool call passes through a default-deny gate. The gate is a PreToolUse
hook, not only `canUseTool`: Claude Code approves read-only tools, and tools
that settings allow, without ever asking `canUseTool`, while a PreToolUse hook
fires on every call, subagents' included.

| Tool | Allowed when |
| - | - |
| Read, Glob, Grep, LS | The realpath is inside the workdir, or inside a plugin or subject root (read-only), and not inside any suite root. A Glob or Grep is also refused when a suite root lies anywhere below its base, since it would descend into it |
| Write, Edit, MultiEdit, NotebookEdit | The realpath is inside the workdir, and not under `<workdir>/.git/` or `final_message.txt`. Under `setting_sources: [project]`, also not `.mcp.json`, and not under a `.claude/` directory at any depth: Claude Code discovers `.claude/` skills, agents and commands between a touched file and the cwd, so the session would load them as its own config |
| Agent, Task (subagents) | With no `isolation`. Their tool calls pass through the same gate; a worktree or remote agent would not |
| TodoWrite, Skill | Always |
| Bash, BashOutput, KillShell, KillBash | `allow_shell: true` |
| WebFetch, WebSearch, `mcp__*` | `allow_network: true` (`mcp__*` also needs `allow_hooks: true`) |
| Anything else | Never |

Every refusal is written to the transcript. The trial's artifacts are:

- the files the subject wrote, found by the snapshot
- `final_message.txt`

The gate refuses any realpath inside a configured suite root, even one that is
also inside a plugin or subject root. A private suite kept in the plugin repo
it evaluates therefore stays out of reach.

The case's own directory, its suite and its suite root are always deny roots,
whatever the runner passes. The gate fails closed: a call it cannot judge (an
unreadable path, a path through a file) is a denial with the error as its
reason. Paths are compared by their on-disk case (`realpath.native`), and names
that may not exist yet are compared case-folded, so a case variant on a
case-insensitive volume is judged as the real name.

Paths are resolved the way the tool would resolve them, then judged:

- Only a glob field (Glob's `pattern`, Grep's `glob`) is a pattern. Every
  other path field is judged literally, as the tool opens it.
- A pattern is relative to the tool's `path`, and its reach is its literal
  prefix. Wildcards, classes, braces and groups (extglob or a bare `( | )`)
  all end that prefix.
- A pattern holding `..` or `~`, or a brace, class or group that holds `/`, is
  refused, and so is a path starting with `~`.
- A `..` segment in any path field is refused. The OS applies it after any
  symlink before it, while resolving it would drop it from the path as spelt.
- A symlink is judged by where it lands. A dangling symlink on the way is
  refused, since writing through it would create its target, wherever that is.
- A directory subject is its own read root. A file subject's read root is the
  folder it sits in.

### Extract

`extract: { from, to, with }` runs after an executor that finishes with `ok`
and before the graders.

- `from` is `final_message` or the name of an artifact. `final_message`
  reads `final_message.txt`, falling back to `response.txt`.
- `with` names one of the `judges`.

Any artifact already at `to` is dropped before extracting, so it never
stands in for an extraction that failed. The extractor sends litmus's
built-in extraction prompt and the target schema (`litmus:findings`), then
writes `to` as an artifact. It is identified by a hash of the judge definition
plus the prompt version. That hash is recorded in `trial.json` only;
`run.json` holds the judge hashes. The case hash covers the judge hashes and
the extract prompt version, so a comparison excludes a case whose extractor
or judges differ between the sides. This lets a real `/review` skill be scored
without changing the format it writes.

An extraction that yields nothing says why:
- there was no source, or it was empty, which is never extracted into zero findings
- the reply was not `litmus:findings`, or it stopped at the extractor's token cap
- `to` could not be written, because a subject can plant a directory there.

The graders then fail on the missing artifact, and the reason is recorded with
the trial. The extracted findings are redacted before
they are written.

### Grader

```ts
type TrialResult = ExecutorResult & { workdir: string; home: string }
type GradeContext = {
  case: LoadedCase                         // its truth, if any, is case.truth
  judge(name: string): Judge               // ConfigError for an unknown name
  signal: AbortSignal
  redact: Redactor
}
type Grader = (spec: GraderSpec, trial: TrialResult, ctx: GradeContext) => Promise<{
  grader: string
  pass: boolean
  score?: number                           // 0..1
  metrics?: Record<string, number | null>
  rationale?: string                       // shown in the UI, including on a pass; redacted
  details?: ReviewDetails                  // review-match only: every finding's outcome; redacted
  usage?: Usage                            // what its judge calls spent
}>                                         // throws InfraError when a judge's provider fails
```

Every judge, confirm and extract call has its own deadline, raced against the
call as the model executor's is: 300 s, or 1 s per 20 tokens the call may
write when that is longer. A call that gives no answer in
time is a retryable `InfraError`. The material sent to a judge or extractor is
capped at 400,000 characters: past that the head and tail are kept, with a
marker saying how much of the middle was cut. The cap is part of the prompt
version.

A trial passes when its executor finished (`exit == ok`) and every one of its
graders passes. A cancel during grading rejects the whole grading step: it
never leaves a partial set of grades that would read as a failed trial. A cancelled, failed or errored trial never passes, whatever
its graders say.

| Grader | Passes when |
| - | - |
| `regex` | The pattern matches the target (an artifact or `transcript`) between `min` and `max` times. An empty match does not count, and counting stops once past `max`, when `matches` reads null (a lower bound, not a count). `transcript` is what the subject wrote: its messages and tool calls, not litmus's prompt and not tool results, which are the fixture it read |
| `json-schema` | The artifact parses and validates against the schema (`litmus:findings`, or a path to a JSON Schema). A schema file is Draft-07 when its `$schema` says so, and 2020-12 otherwise. An unknown keyword or format is a config error, and the trial is an `error` |
| `file-exists` | The path exists (or does not) in the workdir after the trial. A path that leads outside the workdir through a symlink fails. A path that is absolute or contains `..` is a config error at grading, and the trial is an `error` |
| `tool-used` | A tool was called between `min` and `max` times, read from the transcript. Useful for capping subagent fan-out |
| `command` | A shell command, run in the workdir after the trial with the scrubbed environment, exits 0 within `timeout_s`. Its output is redacted before it is cut to its last 4,000 bytes. **Uncontained** (see Sandbox) |
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

Paths are normalized before they are compared: backslashes become `/`, a
finding's leading workdir path (absolute, or its realpath) is stripped, and
the path is posix-normalized, which also drops a leading `./`.

The metrics are below. A metric is null when its denominator is 0.

```
recall            = matched / bugs                    # also recall_critical, _high, _medium, _low: always present, null for a severity the truth lacks
precision         = matched / (matched + false_positives + decoy_hits)
precision_all     = matched / findings
false_positives, decoy_hits, duplicates, nits, findings, matched, bugs   # counts
confirmed                                             # a count; only with confirm
claims_correct    = confirmed / matched               # only with confirm
```

Its result's `details` hold the outcomes for the UI's Findings tab:
`matched` (file, line, title, bug), `missed` (bug ids), and `unmatched`
(file, line, title, and `as`: decoy_hit, duplicate, nit or false_positive,
with `near`, the decoy or bug it fell within reach of). They stay bounded, so
`trial.json` stays readable: in the details and the rationale alike, a file
or title is redacted and then clipped at 500 characters (a clip through a
secret would leave a prefix no redactor matches), and `unmatched` lists the
first 500, with `omitted` counting the rest, which the metrics still count. The UI reads these,
never the rationale: a title is the subject's text, and prose parsed back out
of a rationale would let a title forge a line of its own.

The `pass` bounds are `min_recall`, `max_false_positives`, `max_decoy_hits`,
`max_duplicates`, `max_nits`, `max_findings` and `min_claims_correct`. A bound
that is not set does not apply. Nor does a bound whose metric is null, such as
`min_recall` on a clean case; its rationale says "n/a". A grade where no bound
applied has checked nothing, so it fails. At load, a review-match must set a
bound that can apply to its truth: on a clean case, one other than
`min_recall` and `min_claims_correct`. More than 1,000 findings fail the grade
rather than being matched. On a seeded case, the load-time rule is stricter:
some review-match in the case must set `min_recall` above 0 or
`min_claims_correct`, because with `max_*` bounds alone, or `min_recall: 0`, an
empty review would pass at recall 0. Matching grows
roughly with the cube of the bug count, so a case with dozens of bugs grades
in seconds rather than milliseconds; the few seeded bugs a case usually has
cost nothing.

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

  The case hash covers the whole case directory (`case.yaml`, `truth.yaml`,
  `fixture/`, `change.patch`, `proof/`, `fix/`, `fake.yaml`; `.git` and
  `.DS_Store` aside), the resolved prompt, every `json-schema` file its
  graders read (inside the case or not), the settings resolved from the suite's
  `defaults` (tags aside), the hashes of the judges it calls, and the extract
  prompt version when it extracts. An edit to ground truth would otherwise be
  blamed on the model. Editing a suite's `defaults` therefore excludes, against
  an older baseline, every case whose resolved settings it changes. A `command`
  grader's script outside the case is not covered, since litmus cannot tell
  what it reads. A difference in a subject or plugin hash does not exclude a
  case, because comparing subject versions is a real use. It is listed in the
  comparison's `notes` instead: `<case>: subject changed (<old12> → <new12>)`,
  `plugin <root>: changed (<old12> → <new12>)`, or
  `plugin <root>: loaded only by <side>`, where `<old12>` and `<new12>` are
  the first 12 hex digits of each hash. A
  plugin is known by its absolute root, so a baseline recorded from another
  checkout reads as two `loaded only by` notes rather than one `changed`.
- **Flips.** Every case whose verdict changed is listed with its old and new
  verdicts. This is the headline of the comparison, not a footnote.
- **Suite verdict.** D is the mean over paired cases of B's observed success
  rate minus A's. The verdict is about these cases, not about a population of
  cases like them. That is a choice: only trial noise is uncertain, and a drop
  concentrated in a few cases is a REGRESSION of the suite, whatever the other
  cases do. Three of ten collapsing from 30/30 to 0/30 reads about
  [−0.33, −0.26]. D's 95% interval is MOVER (Zou & Donner), recovered from
  each side's own interval for each case:

  ```
  lo = D − √Σ[(p̂B − lB)² + (uA − p̂A)²] / cases
  hi = D + √Σ[(uB − p̂B)² + (p̂A − lA)²] / cases       # clamped to [−1, 1]
  ```

  A side's interval is Wilson from 9 scored trials, and exact
  (Clopper–Pearson) below 9. Wilson's coverage dips at small n: 30/30 against
  a single failure would read as a REGRESSION about one time in twelve with
  nothing changed, and 7 v 7 trials at 0.5 claims a change 2.87% of the time
  in each direction. 9 is the smallest cutover at which no single-case cell
  claims more than 2.5% in either direction. The interval is deterministic:
  pairs are summed in case-id order, so the same records always give the same
  interval to the last bit.

  With δ = `compare.tolerance`:

  ```
  if no paired cases:                    INCONCLUSIVE
  elif ci.hi < -δ:                       REGRESSION
  elif ci.lo > δ:                        IMPROVEMENT
  elif -δ <= ci.lo and ci.hi <= δ:       NO CHANGE
  else:                                  INCONCLUSIVE    # run more trials
  ```

  Calibration. With both sides drawn from the same true rate, a single case
  claims a change at most 2.5% of the time in each direction. The worst cell
  over 1 to 60 trials a side is 2.32%, and a test counts every pair of trial
  counts from 1 to 30 exactly, at rates from 0.01 to 0.99.

  Across many cases the interval pays for trial noise once. Its coverage is
  conservative near rates of 0 and 1 (98–99.7%), and a little narrow at
  mid-range rates (about 88–91% at 9 to 12 trials a side, about 93–94% at
  30), because Wilson's half-width shrinks there.
  A tolerance above zero absorbs that: at δ = 0.05 no many-case null suite
  tried read as REGRESSION more than 2.3% of the time. At δ = 0 about twice the
  nominal share do, and the comparison's `notes` say so. (Clopper–Pearson for
  every side would restore full coverage at a cost in power.)

  Power, measured by simulation: a real drop of 0.9 to 0.75 across 30 cases at
  5 trials is called a REGRESSION about 43% of the time, and 0.9 to 0.7 across
  10 cases at 10 trials about 76%.

  Centred on the observed rates rather than on posterior means, it stays
  unbiased at unequal trial counts. A posterior mean pulls 1/1 to 0.75 and 5/5
  to 0.92, so two sides that never failed would read as a confident
  regression. One case at 1/1 against 0/1 is INCONCLUSIVE.

  NO CHANGE takes evidence from trials. At δ = 0.05, two identical all-pass
  sides reach NO CHANGE from 6 cases × 30 trials, 31 × 10, 109 × 5 or
  201 × 3. Smaller suites come out INCONCLUSIVE, which is why `run` treats a
  comparison's INCONCLUSIVE as information rather than a failure (see CLI).

  A case is excluded, and never flips, when its hash differs between the sides
  or is missing on one of them, or when only one side ran it. A case one side
  could not score is excluded from the interval but still flips, since a case
  that stopped scoring is news.
- **WARN.** Raised for a metric when the ratio of B's median to A's falls
  outside [1/`warn_ratio`, `warn_ratio`]. A side's median is the median over
  the paired cases of each case's median over its scored trials (an errored
  or cancelled trial did no work). Every case counts once, so neither a
  baseline that ran more cases nor a case that scored more trials on one side
  can raise a WARN on its own. The metrics are total tokens,
  cost, wall-clock time, tool calls, and findings. A metric is skipped when
  A's median is 0 or missing, or B's is missing, or either is not finite. A WARN never changes an exit code.

### Addressing runs and comparisons

| Form | Means |
| - | - |
| `<run id>` | That run. It must hold exactly one config |
| `<run id>:<config>` | That config within that run |
| `baseline:<name>[:<config>]` | The run stored under that baseline name. Baseline names use the NAME grammar |
| `config:<name>` | The latest finished run that includes that config (a cancelled or failed run holds only part of its cases; name it by id instead). "Latest" is by start time to the millisecond, since a run id resolves only to the second |

- `litmus run --config a,b` compares every later config against the first.
- `litmus run --baseline <name>` compares each config against the config of
  the same name in the baseline run. A config missing from the baseline is
  reported (in the run's outcome, for the CLI to print) and skipped.
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
    ├── run.json                          # manifest: id, parent, status (running, finished, cancelled, failed),
    │                                     #   started/finished, litmus version,
    │                                     #   selection, configs (no secrets), case, subject, judge and plugin hashes
    ├── events.jsonl                      # every event, in order; the UI can replay a run from it
    ├── verdicts.json                     # Verdict[]
    ├── comparison.json                   # Comparison[], when there are any
    └── trials/<suite>/<case>/<config>/<n>/
        ├── trial.json                    # TrialRecord
        ├── transcript.jsonl              # TranscriptEntry per line
        └── artifacts/
```

The tree shows the default `results: ./.litmus/runs`. `baselines.json` always
sits beside the `results` directory, in its parent, wherever `results` points.

The record shapes are the types in `src/core/types.ts`. Runs are append-only,
and each JSON file is written to a temporary name and renamed into place, so
a reader never sees half of one. A `run.json` that does not parse is skipped
when runs are listed.
Each attempt writes under the trial's `.attempts/<n>/`, so a retry never
appends to the transcript of the attempt before it. Only the kept attempt
becomes the trial's `transcript.jsonl` and `artifacts/`, and the others are
removed. `trial.json` records the subject's usage summed over every attempt,
and, separately, `grading_usage`: the judge, confirm and extract calls, each
priced by its judge's model. It also records the extractor's reason when an
extraction yielded nothing.
A rerun is a new run, and its `run.json` names the parent run it came from.
`run.json` also records each case's case hash, and a hash of each plugin root
the run loaded.

**Redaction.** Before anything is written to disk or printed by a reporter, the
exact values of these environment variables are replaced with `[REDACTED]`.
The values are read from the process environment and from any environment the
run is given, because the harness reads its credentials from the process:

- `ANTHROPIC_API_KEY`
- `OPENROUTER_API_KEY`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_SESSION_TOKEN`
- `AWS_BEARER_TOKEN_BEDROCK`
- every variable named in `redact`

Redaction happens once, where events and records are produced, so events.jsonl,
the SSE stream, the CLI and every reporter get the same scrubbed text. An
executor redacts its transcript, the `trial.step` events that mirror it, every
artifact it copies out (byte-exact, so a binary file survives), each
artifact's name (a name that redaction makes collide takes a `~n` suffix) and
its result's reason. JSON is redacted before it is stringified, and a step summary
before it is cut.
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
  | { type: 'run.failed'; run: string; error: string }   // litmus itself broke; best effort
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
| POST | `/api/runs` | Start a run: `{ select?, configs?, trials?, baseline?, rerun?: { run, only: VerdictKind[] } }`. `select` defaults to `[]`, and `configs` may be left out as `--config` may. Answers 202 `{ id }` once the run has one, or `{ id: null, message }` for a rerun with nothing to do; 503 while the server is shutting down |
| GET | `/api/runs` | Run history |
| GET | `/api/runs/:id` | Manifest, verdicts, comparison |
| GET | `/api/runs/:id/events` | Server-sent events: the backlog first, then the live stream |
| POST | `/api/runs/:id/cancel` | Cancel the run: 202 `{ id }`, or 409 when it is not running |
| GET | `/api/runs/:id/trial?key=<encoded trial key>` | Trial record, transcript and artifacts |
| GET | `/api/compare?a=&b=` | Compare two runs, using the forms under Addressing runs and comparisons |
| PUT | `/api/baselines/:name` | Set a baseline to a run: `{ run }`. Answers 200 `{ name, run }` |

A body must be `application/json` (415 otherwise) and at most 1 MiB (413
otherwise). A request the operator got wrong (a bad selector, an unknown
config, a body that does not parse, a malformed run id) is a 400 with
`{ error }`. So is an unknown run named to `/api/compare` or
`PUT /api/baselines/:name`. Only the `/api/runs/:id` routes answer 404 for a
run that does not exist; a trial the run lacks and a route that does not
exist are 404 too. Every error message the server sends or logs is redacted
as the CLI's would be: a YAML error quotes the line it failed on. A 500 says
only `internal error`. Each event on the stream carries its index as its `id`, so a
client that reconnects with `Last-Event-ID` (a plain number; anything else is
ignored) gets only what it missed; the stream ends after `run.finished`,
`run.cancelled` or `run.failed`. For a run that is not live in this server
(it is over, crashed, or is running in another process such as the CLI), a
request with nothing left to send gets a 204, the one answer that stops an
EventSource reconnecting; a client following a run started elsewhere reads
its status from `/api/runs/:id` instead. A
trial's artifacts come back as text when they are UTF-8 and at most 8 MiB,
as a size with `binary` when binary, as a size with `truncated` when larger,
and as `{ missing: true }` when the file is gone or leads outside. One
response inlines at most 32 MiB of artifact text in all, counted as the text
costs in JSON, so a trial with many large artifacts can always be viewed;
past that, each comes back as a size with `truncated`. A transcript over
64 MiB comes back empty with `transcript_truncated`. Every
file the server reads, a UI file included, must resolve inside its directory
with links followed (a linked directory cannot lead out), and is read
without following a final link.

Any path outside `/api` serves the built UI (`ui/dist`), with `index.html` for
a path that is not a file, so the UI's own routes survive a reload. A method
other than GET or HEAD there is a 405. Every
response says `nosniff`, forbids framing (`frame-ancestors 'none'`, since a
framed page could borrow the operator's clicks), and sends no referrer.
`litmus serve` stops on Ctrl-C: it drops open connections at once, cancels
the live runs, waits for each to be written, and exits 0. A port in use is
exit 2.

The CLI runs in-process on the same runner module. The UI is a client of the
API and nothing else.

## UI

- **Toolbar:** Run all, Run selected, Rerun failed, Rerun flaky, Rerun
  errored and Cancel, plus a multi-select of configs and a trial count.
- **Tree:** suite → case → config → trial.
  - Each row has a checkbox and a status icon. Suite, case and config rows
    also carry a counts badge (`✓ 12 ✗ 2 ~ 1 ! 0 ? 0`); trial rows do not.
  - Checking a case or suite runs it on the toolbar's configs. Checking a
    config or trial runs those trial keys on their own config, so the toolbar's
    trial count does not apply to them. When both kinds are checked, every
    key's config must also be chosen in the toolbar, or the run is refused
    with the reason. The same holds for a config or trial row checked under a
    checked case or suite, whose config or trial number the toolbar's configs
    and trial count would leave out. A trial numbered
    past its case's own count cannot be checked: no selector names it.
  - The tree is a WAI-ARIA tree: arrows move, Right and Left open and close,
    Home and End jump, Space checks a row and Enter opens it.
  - A text filter and status chips narrow the tree.
  - Status icons: queued (hollow), running (spinner), pass (a green circle),
    fail (a red square), flaky (an amber diamond), error (a grey triangle),
    inconclusive (outlined), cancelled (struck through), and `none` (dotted)
    for a config never run. The shape carries the status as well as the colour.
- On load, the UI opens the newest run.
- **Detail pane** for a trial:
  - **Transcript:** a timeline of messages, tool calls and refusals, modelled
    on Playwright's UI mode.
  - **Graders:** each result with its reasoning and metrics.
  - **Findings:** on a trial graded by `review-match` only: matched bugs,
    missed bugs, false positives, decoy hits, duplicates and nits, set against
    the ground truth.
  - **Usage:** subject tokens and cost, grading tokens and cost, time,
    attempts and tool calls.
  - **Artifacts:** each artifact with its size, and its text when it is text.
- A run that the stream stops following while its record still says running
  is shown as running elsewhere (the CLI's); one whose server went away is
  shown as lost.
- **Compare view:** a grid of cases × configs with a verdict in each cell. The
  flip list sits on top, next to the suite verdict and any WARN metrics. A
  two-side form compares any two sides, written in the forms under Addressing
  runs and comparisons. Each comparison also lists its excluded cases and its
  notes.

## CLI

```
litmus list [select...]                          # the tree, with the latest verdicts
litmus run [select...] --config a,b [--trials N] [--baseline name]
           [--allow-flaky] [--allow-inconclusive] [--reporter pretty|json|ctrf|junit] [--out path]
litmus run --rerun <run> --only fail,flaky,error,inconclusive
litmus compare <side> <side> [--allow-inconclusive] [--out path]
litmus baseline set <name> <run> | litmus baseline list
litmus validate [select...]
litmus serve [--port 4317]
litmus --version                                 # litmus <version>, exit 0
```

Every command takes `--config-file <path>` (default `./litmus.config.yaml`).

`--config` may be left out only when the config file defines exactly one
config. `--rerun` runs the configs of the run it reruns, so it takes neither
`--config` nor selectors. `--rerun` and `--only` each need the other. A
rerun whose `--only` set matches no verdict prints so (to stderr, under a
machine-readable reporter) and exits 0. `baseline set` takes only a finished run: a cancelled
or failed one holds some of its cases, and would quietly shrink every
comparison against it.

**Reporters.** `--reporter` picks the document and `--out` picks where it goes
(stdout by default). stdout shows the live `pretty` view unless a JSON, CTRF
or JUnit document is going there instead, so `--reporter junit --out
junit.xml` gives both. `pretty` on a TTY redraws one status line in place and
is coloured (unless `NO_COLOR` is set); anywhere else it writes the same lines
plainly, top to bottom. It ends with the comparisons, the run's notes (such
as a `--baseline` config the baseline lacks), a count of verdicts, every
verdict or comparison that decided the exit code, and `exit <n>`. A pair
whose trials errored says why on its line (the first distinct reason, the rest
counted), as a CTRF or JUnit failure message does: `ANTHROPIC_API_KEY is not
set`, say.

| Document | One test per | Status |
| - | - | - |
| `json` | (none: the manifest, verdicts, comparisons, notes and exit) | |
| `ctrf` (spec 0.0.0, validated against `src/report/vendor/ctrf.schema.json`) | (case, config) verdict | the gate below decides it: blocking is `failed`, infra is `other`, and anything let through is `passed`, with `flaky: true` for an allowed FLAKY |
| `junit` | (case, config) verdict, plus one per comparison, in a testsuite named `litmus:comparisons` (no suite can have that name) | blocking is a `<failure>`, infra an `<error>`, and a comparison's REGRESSION a `<failure>` |

A cancelled run's CTRF and JUnit also list each (case, config) it stopped
before it settled, as skipped, so a cancelled run never reads as a clean one.
`--out` is checked before anything runs, links followed: a path ending in `/`,
a directory, a parent that is not an existing directory, or a path that cannot
be written is exit 2. If the write still fails after the run (a full disk, a
directory removed meanwhile), the run is already recorded, and a `run` or
`compare` that would have exited 0 exits 3; a blocking result keeps its code.
A `run.json` or `verdicts.json` that does not parse (hand-edited, or a disk
fault), or a `run.json` without its configs, cases, judges or plugins, is a
config error wherever a command must read that run, and the message names the
file. Listing runs, and picking one for `config:<name>`, skips such a run. A
`trial.json` that does not parse is skipped. `--out` is written whenever a run
ends, finished or cancelled: a rerun with nothing to rerun,
or a run litmus could not finish, leaves any file already there untouched. A reader
that closes early (`litmus run | head`) stops the output, not the run: it
finishes, is written, and exits with its real code.

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

`run` and `validate` cancel on SIGINT or SIGTERM, and exit 130 or 143;
`serve` stops (see Server) and exits 0. A second signal leaves at once. If
litmus itself fails mid-run (the store cannot be written), the run is marked
`failed` and `run` exits 3.

Inside `run`, only a comparison's REGRESSION blocks. Its INCONCLUSIVE and NO
CHANGE are reported, and neither changes the exit code, since small suites
rarely have the evidence for NO CHANGE.

`compare` exits 0 on NO CHANGE or IMPROVEMENT, and 1 on REGRESSION. It also
exits 1 on INCONCLUSIVE, unless `--allow-inconclusive` is passed. It exits 2
on a usage or config error.

`validate` exits 0 when every case is valid and 1 otherwise, including when a
suite or case fails to load (an unknown judge name among them). It exits 2
only on a usage error, a config file that will not load, or a bad selector.
Warnings don't affect its exit code.

Any command exits 3 on any other failure (a results directory litmus cannot
read, say), with one redacted line on stderr and no stack trace, so
infrastructure trouble never reads as a REGRESSION.
