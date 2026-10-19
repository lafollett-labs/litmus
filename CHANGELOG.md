# Changelog

All notable changes to litmus. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0.0, a minor version may
change the config, the suite format or the CLI.

## [Unreleased]

### Security

- **A subject could read outside its workdir through Skill arguments.**
  Claude Code expands an `@path` mention in a skill's arguments by reading the
  path itself, without asking the PreToolUse gate. With skills Claude Code
  bundles, a harness subject could list the case directory, read
  `truth.yaml`, or read any file the operator can. The same read happened
  for an `@` mention in a plugin's skill or command body, in a body fed by
  the skill's args (`Review @$ARGUMENTS`), and in a file rendered into a
  harness prompt. The trial env now turns those reads off, and a mention
  reaches the model as text. The session is given only the tools the gate
  can allow.
- **The run store is denied.** A plugin or subject root that held the
  results directory let a subject read earlier trials' `trial.json`, which
  names every matched bug. The store and `baselines.json` are now deny roots.
- **An ungated tool call voids the trial.** A tool call that returns a result
  the gate never judged ends the trial as an infra error. A new test runs the
  real Claude Code binary against a local fake API, so an Agent SDK change
  that skips the gate fails CI. The SDK is now pinned to an exact version.

## [0.1.0] - 2026-10-16

The first release: a runner for LLM and agent evals that runs a suite, one
case or one trial, shows it live, and says which cases flipped between two
models.

### Added

- **Suites and config.** `litmus.config.yaml`, `suite.yaml`, `case.yaml`,
  `truth.yaml` and the `litmus:findings` contract, each validated on load.
  Suites are discovered across several roots. Selectors address a suite, a
  case, a glob, `tag:<tag>` or a single trial; one that matches nothing is an
  error.
- **Providers.** `anthropic`, `bedrock`, `openrouter`, and `fake` for $0
  scripted runs. Keys are read from the environment only, and a pricing table
  covers providers that report no cost.
- **Executors.**
  - `model`: one model call, with the subject as its system prompt.
  - `harness: claude-code`: the Claude Agent SDK, headless, in a fresh workdir
    behind a default-deny gate. Hooks and MCP servers are refused unless the
    case allows them.
- **Graders.** `regex`, `json-schema`, `file-exists`, `tool-used`, `command`,
  `judge` (pinned by hash), and `review-match`, which scores a code review
  against seeded bugs. It reports recall by severity, precision, nits, decoy
  hits and duplicates, and optionally checks each claim with a judge. An
  `extract` step turns a free-form review into findings.
- **Verdicts.**
  - Every case gets PASS, FAIL, FLAKY, ERROR or INCONCLUSIVE.
  - An `all` policy and a `rate` policy, the latter judged on a Wilson
    interval.
  - `expect: fail` for canaries.
  - pass@k and pass^k.
- **Comparison.** Paired comparisons of configs, runs and baselines. Each
  gives its flips, excluded cases, a suite verdict (REGRESSION, IMPROVEMENT,
  NO CHANGE, INCONCLUSIVE) and WARN metrics.
- **Runner and store.**
  - A concurrency pool, with infra-only retries and backoff.
  - Timeouts and cancel.
  - An event stream.
  - Runs on disk, redacted by value.
  - Reruns by verdict, and named baselines.
- **CLI.** `list`, `run`, `compare`, `baseline`, `validate` and `serve`, with
  exit codes CI can act on, and `--version`. Reporters: `pretty` (live on a
  TTY), `json`, CTRF and JUnit. A pair whose trials errored says why in each
  (`ANTHROPIC_API_KEY is not set`, say).
- **Server.** A local HTTP API with server-sent events, on 127.0.0.1 only,
  with exact Host and Origin checks.
- **UI.** A runner in the browser:
  - a live tree of suites, cases, configs and trials, with status icons and
    count badges
  - run all, run selected, rerun failed, flaky or errored, and cancel
  - a trial's transcript, graders, findings, usage and artifacts
  - a compare view
  - light and dark themes
  - keyboard and screen-reader support
- **`litmus validate`.** It checks every case on a disposable copy. It runs
  each seeded bug's proof, which must fail on the change and pass once the
  bug's fix is applied. Ground truth must name real lines in the post-change
  tree, and a fix may not edit its own proof.
- **Example suites.** `smoke` covers every verdict; `canaries` tests the
  graders; `code-review` has a Go case with two seeded bugs and a decoy, a
  TypeScript seeded case, and a TypeScript clean case.

[Unreleased]: https://github.com/lafollett-labs/litmus/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lafollett-labs/litmus/releases/tag/v0.1.0
