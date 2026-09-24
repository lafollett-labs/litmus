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
/code-reviewer:code-reviewer on the PR    # fix findings; at most 3 rounds
CI green → gh pr merge --rebase --delete-branch
```

Rebase-merge keeps the small commits on `main`. Squash would throw them away.

## Milestones

- [ ] **M0: Foundation**
  - `package.json`: `type: module`, `engines.node >= 26`, `bin: litmus`, and the
    scripts `check`, `test`, `test:ui`, `ui:dev` and `ui:build`.
  - `tsconfig.json` with Riff's strict flags.
  - `src/core`: ids, content hashing and error classes (`InfraError`,
    `ModelFailure`, `ConfigError`).
  - CI running `check` and `test` on every push and pull request.
  - Done when: `npm run check && npm test` passes locally and in CI on the PR.

- [ ] **M1: Suites and config**
  - zod schemas for `litmus.config.yaml`, `suite.yaml`, `case.yaml`,
    `truth.yaml` and `litmus:findings`.
  - Suite discovery across several roots, with an error when two suites share
    a name.
  - Paths resolved relative to the file that names them, and subject content
    hashes.
  - The selector parser and matcher: suite, case, glob, `tag:` and trial key.
  - A CLI skeleton (`node:util` `parseArgs`) and `litmus list`.
  - Done when: tests cover a valid and an invalid document for each schema,
    the selector matrix, and discovery across two roots. `litmus list` prints
    the test fixture tree.

- [ ] **M2: Providers**
  - The `Provider` interface, and error classification at the boundary.
  - `fake`, scripted by `fake.yaml`: responses indexed by trial, `error: infra`
    and `delay_ms`.
  - `anthropic`. Load the `claude-api` skill for the current parameter names,
    effort included.
  - `bedrock`.
  - `openrouter`, over `fetch`, using the cost it reports.
  - A pricing fallback for providers that report no cost.
  - Done when: tests with a mocked SDK and mocked `fetch` cover usage mapping
    and every error class. `fake` is fully covered. Each live smoke test passes
    under `LITMUS_LIVE=1` wherever its key is present, and the PR says which
    ones ran.

- [ ] **M3: Executors**
  - The workdir builder. It copies `fixture/`, runs `git init`, and commits.
    `change.patch` goes on the branch `litmus/change`. It never copies
    `truth.yaml`, `fix/` or `fake.yaml`.
  - `model`: renders `{{fixture}}` with paths and line numbers, uses the
    subject as the system prompt, and extracts `findings.json`.
  - `harness: claude-code` over the Claude Agent SDK:
    - the default-deny gate, with file paths confined to the workdir and shell
      and network behind flags
    - transcript capture, and usage taken from the result message
    - the provider mapped to an environment
    - a timeout or the max-turns limit classified as `model_failure`
  - Done when: tests prove that truth files never reach the workdir, that the
    gate refuses outside paths and the shell, and that a timeout is a
    `model_failure`. The harness tests use a scripted `query()` stream. One
    live harness smoke test runs under `LITMUS_LIVE=1`.

- [ ] **M4: Graders and extractors**
  - The graders `regex`, `json-schema`, `file-exists`, `tool-used` and
    `command`.
  - `review-match`: one-to-one pairing, with window, decoy, nit and
    false-positive rules. An optional `confirm: <judge>` step checks claim
    correctness on the matched pairs.
  - `judge`: a pinned hash and a binary `{ pass, rationale }` answer.
  - An `extract` step that runs after the executor and before the graders. A
    pinned model turns a final message or a free-form review file into
    `findings.json`, so a real `/review` skill can be scored without changing
    its output format. The extractor is hashed like a judge.
  - Done when: every grader has tests for pass, fail and edge cases, plus a
    **canary**: a known-bad input that must fail, which guards against the
    silent-pass bugs the survey found. `review-match` metrics match
    hand-computed examples.

- [ ] **M5: Statistics and verdicts**
  - The Wilson interval, and unbiased pass@k and pass^k.
  - The `all` and `rate` policies, and `expect: fail` inversion.
  - A paired bootstrap with a seeded PRNG.
  - Comparison: flips, the suite verdict, and WARN.
  - Done when: tests match hand-computed values (for example, Wilson for 3/5).
    The same seed gives the same bootstrap every time. Every branch of the
    verdict rules is covered.

- [ ] **M6: Runner and store**
  - Job expansion and a concurrency pool.
  - Retries with backoff, for infra errors only.
  - Timeouts, cancellation and the event stream.
  - The store's writer and reader.
  - Rerunning only failed or flaky cases, and baselines.
  - Done when: an end-to-end test on `fake` produces all five verdicts (PASS,
    FAIL, FLAKY, ERROR and INCONCLUSIVE). The same test also shows that:
    - only infra errors are retried
    - cancelling stops the trials in flight
    - `--rerun <run> --only failed` selects exactly the failed cases
    - `events.jsonl` replays to the same verdicts

- [ ] **M7: CLI and reporters**
  - `run`, `compare`, `baseline` and `list`.
  - The `pretty` reporter (live on a TTY, plain lines otherwise), plus `json`,
    CTRF and JUnit.
  - Exit codes as in ARCHITECTURE.md.
  - Done when: the CLI tests start `node src/cli/main.ts` against fixture
    suites with the `fake` config and check its output and exit codes. CTRF
    output validates against a vendored copy of the CTRF schema.

- [ ] **M8: Server**
  - `node:http` routes as specified.
  - Server-sent events with the backlog replayed first.
  - The `Host` and `Origin` checks.
  - Serving the static UI.
  - Done when: an API test starts a run, receives the events in order, and
    reads the verdicts. Tests also show a bad `Host` or `Origin` is rejected
    and that cancelling works.

- [ ] **M9: UI**
  - Vue 3 and Vite: the toolbar, the tree with live status, the detail pane
    (transcript, graders, findings, usage), the compare view, and light and
    dark themes.
  - Done when: Playwright drives `litmus serve` over the fake suites through
    run all, run one, rerun failed, cancel, opening a trial, and compare.
    `npm run test:ui` passes locally and in CI, and the PR includes
    screenshots.

- [ ] **M10: Example suites and validate**
  - `suites/examples/smoke`: every verdict, on `fake`.
  - `suites/examples/canaries`: cases marked `expect: fail`.
  - `suites/examples/code-review`, with three cases:
    - Go: two seeded bugs and one decoy
    - TypeScript: one seeded bug
    - TypeScript: a clean change
  - Proof tests and fix patches for every seeded bug.
  - `litmus validate`, which checks that each proof fails, then passes once its
    fix is applied. CI runs it, with Go installed.
  - Done when: `litmus validate suites/examples` passes in CI. `litmus run
    code-review --config fake` gives the expected verdicts. With a key present,
    the PR records one live run and what it cost.

- [ ] **M11: Release 0.1.0**
  - The README quickstart becomes real, with every command run exactly as
    written.
  - `CHANGELOG.md`, and ARCHITECTURE.md re-read against the code.
  - Version `0.1.0`, the tag `v0.1.0`, and a GitHub release. Nothing is
    published to npm.
  - Done when: a fresh clone passes `npm ci && npm run check && npm test &&
    npm run test:ui`, and the tag is on `origin`.

## After 0.1.0

These are listed in priority order. None of them is part of the 0.1.0 goal.

1. **Convergence.** Multi-round review, with a deterministic fixer that applies
   the fix patches for the bugs a round found. It measures rounds to approval,
   how often the round cap is hit, how often fixed bugs are flagged again, and
   new findings on code nobody changed.
2. **Judge calibration.** `litmus judge calibrate` measures TPR and TNR
   against human labels, and reports pass rates corrected for judge error. An
   anchor set is re-scored whenever a judge changes.
3. **A container executor** for trials that allow the shell.
4. **More harnesses**: Codex CLI and Gemini CLI. Also an `agent` executor, a
   tool loop run over a provider.
5. **Private-corpus tooling**: seeding helpers, mutation tools for each
   language, and a slice of cases regenerated for each release.
6. **OpenTelemetry export**, using `gen_ai.evaluation.result`.
