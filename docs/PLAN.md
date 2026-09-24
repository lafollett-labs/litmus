# Plan to 0.1.0

The milestones run in order. Each one lands as a single pull request made of
small commits, and each has a **done when** line: the evidence the pull request
has to show, as commands and their output. Tick a milestone's box in the same
pull request that finishes it.

Contracts live in [ARCHITECTURE.md](ARCHITECTURE.md). This file says only what
to build and in what order.

## How a milestone lands

```
git switch -c m<N>-<slug> main
repeat:
    one logical change → commit          # each commit passes npm run check && npm test
push → gh pr create                       # body: scope, then the done-when evidence
/code-reviewer:code-reviewer on the PR, until APPROVED   # at most 3 rounds
resolve every external review thread (Copilot included): fix it, or reply with why not
CI green → gh pr merge --squash --delete-branch
```

A squash merge puts one commit per pull request on `main`. The small commits
stay on the branch, and their messages go into the squash commit's body.

## Milestones

- [ ] **M0: Foundation**
  - `package.json`: `type: module`, `engines.node >= 26`, `bin: litmus`, and
    the scripts `check`, `typecheck` (an alias for `check`, which the review
    agents run) and `test`.
  - `tsconfig.json` with Riff's strict flags.
  - `src/core`: ids, content hashing and error classes (`InfraError` with
    `retryable`, `ModelFailure`, `ConfigError`).
  - CI running `check` and `test` on every push and pull request.
  - Done when: `npm run check && npm test` passes locally and in CI on the PR.
    After merge, the `main` ruleset requires the `check` job.

- [ ] **M1: Suites and config**
  - zod schemas for `litmus.config.yaml`, `suite.yaml`, `case.yaml`,
    `truth.yaml` and `litmus:findings`. The rules they enforce:
    - the NAME grammar
    - a name must equal its directory's name
    - exactly one of `prompt` and `prompt_file`
    - `setting_sources` is `[]` or `[project]`
    - `allow_hooks`
    - `extract`
    - `min_trials` defaults to ceil(trials / 2)
  - Suite discovery across several roots, with an error when two suites share
    a name.
  - Paths resolved relative to the file that names them, and subject content
    hashes.
  - The selector parser and matcher: suite, case, glob, `tag:` and trial key.
    A selector that matches nothing is an error.
  - A CLI skeleton (`node:util` `parseArgs`) and `litmus list`.
  - Done when: tests cover a valid and an invalid document for each schema,
    the selector matrix, and discovery across two roots. `litmus list` prints
    the test fixture tree.

- [ ] **M2: Providers**
  - The `Provider` interface, and error classification at the boundary,
    including the retryable and non-retryable `InfraError`s.
  - `fake`, scripted by `fake.yaml`: responses indexed by trial,
    `infra_errors`, `fatal` and `delay_ms`.
  - `anthropic` (`output_config.effort`) and `bedrock` (the Mantle client),
    both with SDK retries off and no server-side fallbacks.
  - `openrouter`, over `fetch`, using the cost it reports.
  - A pricing fallback for providers that report no cost.
  - Done when: tests with a mocked SDK and mocked `fetch` cover usage mapping
    and every error class, and `fake` is fully covered. The live smoke tests
    run under `LITMUS_LIVE=1` wherever a key is present, and the PR says which
    ones ran.

- [ ] **M3: Sandbox and executors**
  - `src/sandbox`:
    - the workdir builder, under the OS temp directory, fresh on every attempt
    - symlinks refused before and after the change is applied
    - git run only while building, with safe config; `change.patch` goes on
      the branch `litmus/change`
    - the file snapshot and the written-file diff
    - the scrubbed child environment
  - `model`: renders `{{fixture}}`, `{{diff}}` and `{{file:<path>}}`, uses the
    subject as the system prompt, and extracts JSON as the contract defines.
  - `harness: claude-code` over the Claude Agent SDK:
    - an explicit `settingSources`, a fresh `CLAUDE_CONFIG_DIR`, auto-memory
      off, and a strict MCP config
    - hooks refused without `allow_hooks`
    - the default-deny gate, confining paths by realpath
    - API-key or Bedrock credentials only
    - transcript capture, and usage taken from the result message
    - timeout and cancel told apart by abort reason
  - Done when: tests prove each of the following.
    - Truth, proof, fix and fake files never reach a workdir.
    - A fixture symlink and a patch-created symlink are both refused.
    - Nothing a subject writes into `.git/` runs.
    - Child environments hold no keys.
    - The gate refuses outside paths, the shell, and hooks.
    - A timeout is a `model_failure` and a cancel is not.

    The harness tests use a scripted `query()` stream. One live harness smoke
    test runs under `LITMUS_LIVE=1`.

- [ ] **M4: Graders and extractors**
  - The graders `regex`, `json-schema`, `file-exists`, `tool-used` and
    `command` (with a scrubbed environment).
  - `review-match`:
    - maximum-cardinality matching
    - decoy, nit and false-positive rules, where every finding on a clean case
      counts
    - `max_nits`, `max_findings`, `precision_all` and recall per severity
    - `confirm: <judge>`, for claim correctness
  - `judge`: a pinned hash and a binary `{ pass, rationale }` answer.
  - `extract`: a pinned, hashed extractor that turns a final message or a
    free-form review into `findings.json`.
  - Graders and extractors throw `InfraError` when their provider fails.
  - Done when: every grader has tests for pass, fail and edge cases, plus a
    **canary**: a known-bad input that must fail. The canaries include "every
    finding labelled `low`", and cover the silent-pass bugs the survey found.
    `review-match` metrics match hand-computed examples, including the case
    that greedy pairing gets wrong.

- [ ] **M5: Statistics and verdicts**
  - The Wilson interval, `minTrialsToPass`, and unbiased pass@k and pass^k
    with k = min(3, scored).
  - The `all` and `rate` policies, where `rate` has no FLAKY. Under
    `expect: fail`, a trial counts as a success only when the graders ran and
    rejected the output, and any pass makes the case FAIL.
  - The two-level bootstrap with a Jeffreys posterior and a seeded mulberry32.
  - Comparison: flips, excluded cases, the suite verdict, and WARN with its
    zero-median skip.
  - Done when: tests match hand-computed values (Wilson for 3/5; 5/5 at 0.8
    is INCONCLUSIVE and 16/16 is PASS). A one-case 1/1 against 0/1 is
    INCONCLUSIVE, not REGRESSION. The same seed gives the same interval every
    time. Every branch of the verdict rules is covered.

- [ ] **M6: Runner and store**
  - Job expansion and a concurrency pool.
  - Attempts, each in a fresh workdir, with infra-only retries and backoff.
    Grading is retried on its own, and usage is summed across attempts.
  - Timeouts, cancellation (the `cancelled` status), and the event stream.
  - The store's writer and reader, with redaction by value.
  - Rerunning by verdict set, and baselines.
  - Done when: an end-to-end test on `fake` produces all five verdicts (PASS,
    FAIL, FLAKY, ERROR and INCONCLUSIVE). The same test also shows that:
    - only infra errors are retried
    - a cancel leaves `cancelled` trials that are not counted as failures
    - `--rerun <run> --only fail` selects exactly the FAIL cases
    - `events.jsonl` replays to the same verdicts
    - a fake key planted in the environment appears in no file under the run

- [ ] **M7: CLI and reporters**
  - `run`, `compare` (every addressing form), `baseline` and `list`.
  - The `pretty` reporter (live on a TTY, plain lines otherwise), plus `json`,
    CTRF and JUnit.
  - Exit codes 0 to 3 as in ARCHITECTURE.md, including `--allow-flaky` and
    `--allow-inconclusive`.
  - Done when: the CLI tests start `node src/cli/main.ts` against fixture
    suites with the `fake` config and check its output and every exit code.
    CTRF output validates against a vendored copy of the CTRF schema.

- [ ] **M8: Server**
  - `node:http` routes as specified, with trial keys passed as a query
    parameter.
  - Server-sent events with the backlog replayed first.
  - An exact `Host` allowlist, `Origin` required on requests that change
    state, and no CORS headers.
  - Serving the static UI.
  - Done when: an API test starts a run, receives the events in order, and
    reads the verdicts. Tests also cover a bad `Host`, and a missing or foreign
    `Origin` on a POST (all rejected), plus cancelling a run.

- [ ] **M9: UI**
  - Vue 3 and Vite, with the scripts `ui:dev`, `ui:build` and `test:ui`.
  - The toolbar, the tree with live status, the detail pane (transcript,
    graders, findings, usage), the compare view, and light and dark themes.
  - Done when: Playwright drives `litmus serve` over the fake suites through
    run all, run one, rerun failed, cancel, opening a trial, and compare.
    `npm run test:ui` passes locally and in CI, the ruleset requires its job,
    and the PR includes screenshots.

- [ ] **M10: Example suites and validate**
  - The repository's own `litmus.config.yaml`, listing `./suites/examples`
    and the `fake` config.
  - `suites/examples/smoke`: every verdict, on `fake`.
  - `suites/examples/canaries`: cases marked `expect: fail`.
  - `suites/examples/code-review`, with three cases:
    - Go: two seeded bugs and one decoy
    - TypeScript: one seeded bug
    - TypeScript: a clean change
  - A proof test in `proof/` and a fix patch for every seeded bug.
  - `litmus validate` with every check in ARCHITECTURE.md: proofs run on a
    disposable copy, symlinks, `proof/` paths duplicated in the fixture,
    hooks, and the rate-policy trial warning. CI runs it with Go installed.
  - Done when: `node src/cli/main.ts validate` passes in CI, and `litmus run
    code-review --config fake` gives the expected verdicts. With a key present,
    the PR records one live run and what it cost.

- [ ] **M11: Release 0.1.0**
  - A README quickstart, with every command run exactly as written.
  - `CHANGELOG.md`, and ARCHITECTURE.md re-read against the code.
  - Version `0.1.0`, the tag `v0.1.0`, and a GitHub release. Nothing is
    published to npm.
  - Done when: a fresh clone passes `npm ci && npm run check && npm test &&
    npm run test:ui`, and the tag is on `origin`.

## After 0.1.0

These are listed in priority order. None of them is part of the 0.1.0 plan.

1. **Convergence.** Multi-round review, with a deterministic fixer that applies
   the fix patches for the bugs a round found. It measures rounds to approval,
   how often the round cap is hit, how often fixed bugs are flagged again, and
   new findings on code nobody changed.
2. **A container executor.** It contains `allow_shell`, `allow_hooks` and the
   `command` grader. Until it exists, those three are uncontained.
3. **Judge calibration.** `litmus judge calibrate` measures TPR and TNR
   against human labels, and reports pass rates corrected for judge error. An
   anchor set is re-scored whenever a judge changes.
4. **More harnesses**: Codex CLI and Gemini CLI. Also an `agent` executor, a
   tool loop run over a provider.
5. **Private-corpus tooling**: seeding helpers, mutation tools for each
   language, and a slice of cases regenerated for each release.
6. **OpenTelemetry export**, using `gen_ai.evaluation.result`.
