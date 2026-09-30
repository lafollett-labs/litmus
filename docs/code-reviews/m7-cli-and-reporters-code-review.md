# Code Review: m7-cli-and-reporters

**Verdict:** 🔄 CHANGES REQUESTED (round 2)

| | |
| - | - |
| **Branch** | `m7-cli-and-reporters` (Gate 1, local, before any PR; stacked on M6) |
| **Reviewer** | @Cali LaFollett (PE-Vue) |
| **Review Round** | 1 |
| **Reviewed SHA** | `761c7fb` |
| **Title** | M7: CLI and reporters |
| **Date** | 2026-09-30 |

---

## Summary

PE-Vue verified:

- The exit logic against the spec pseudocode.
- Every addressing error, over 14 probes.
- Cancel exits: SIGINT 130 and SIGTERM 143.
- CTRF, with formats checked strictly: it validates for every verdict shape.
- JUnit well-formedness under `xmllint`.
- The TTY status line, captured with `script(1)`.
- Redaction of a planted key through every reporter.

The findings are about what happens around the run:

- A bad `--out` path crashed after the run, with exit 1.
- `run | head` exited 0 and left the run at `running`.
- The json reporter printed the unredacted in-memory manifest.
- "Latest" was random for runs started in the same second.
- 8 of 11 rule mutants survived.

At the reviewed SHA, `npm run check` is clean, and 465 tests pass with 4 (live) skipped.

## Findings Overview

| Severity | In Scope | Out of Scope |
| - | - | - |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 1 | 0 |
| 🟡 MEDIUM | 4 | 0 |
| 🟢 LOW | 4 | 0 |
| ℹ️ INFO | 3 | 0 |

## Findings and dispositions

| ID | Finding | Disposition |
| - | - | - |
| HIGH-001 | A bad `--out` path crashed after the run with an uncaught ENOENT and exit 1, which reads as a blocking verdict. A torn trial.json and a corrupt baselines.json crashed the same way | Fixed in `e6243a5` and `1030cb3`. `--out` is checked before anything runs; a missing directory or a directory as the target is exit 2. A late write failure is reported, and `run` exits 3. Readers skip a torn trial.json, and a corrupt baselines.json is a ConfigError. Tested, and the pre-check mutant is killed |
| MEDIUM-001 | The EPIPE handler exited 0 mid-run and left run.json `running` | Fixed in `e6243a5`. A closed pipe stops output; the run finishes, is written, and exits with its real code. The test closes the pipe after the first chunk and gets exit 1 with `finished`. The old handler, as a mutant, fails it |
| MEDIUM-002 | The json reporter printed the unredacted in-memory manifest | Fixed in `1030cb3`. `finish()` returns the manifest redacted, and `run()` redacts the verdicts, comparisons and notes it returns. The test plants a key in a config value and checks every reporter. The unredacted return, as a mutant, fails it |
| MEDIUM-003 | "Latest" was random for runs started in the same second | Fixed in `1030cb3`: `listRuns` orders by `started_at` (milliseconds), then id. The test covers two runs in one second whose suffixes sort the other way. The same bug surfaced independently in M9's e2e run |
| MEDIUM-004 | 8 of 11 mutants survived | Tests added for: `config:<name>` skipping a cancelled run; a two-config run needing `:<config>`; list showing the newest verdict and ignoring a run still marked running; SIGTERM 143; `--rerun` with selectors and with `--config`, against a run that exists. M1, M2, M3, M4, M6, M7 and M8 are killed. M5 (the second signal ignored) is **accepted as untested**: nothing in the fake stack hangs on cancel, so a first signal always completes, and no test can tell the two paths apart |
| LOW-001 | One unreadable verdicts.json crashed `list` | Fixed in `e6243a5`: that run is skipped. Tested with a torn run.json |
| LOW-002 | A rerun with nothing to do printed prose to a machine-readable stdout | Fixed in `e6243a5`: the message goes to stderr under json, ctrf and junit. Tested |
| LOW-003 | When litmus itself failed, the live view got nothing, and the stderr message was not redacted | Fixed in `1030cb3` and `e6243a5`. `run.failed` reaches the listener even when the store cannot be written, the CLI prints `exit 3`, and the message is redacted |
| LOW-004 | A cancelled run's CTRF and JUnit showed only its settled cases, all green | Fixed in `e6243a5`: each stopped (case, config) is `skipped` ("cancelled before it settled"). Tested through SIGTERM with JUnit |
| INFO-001 | Signal handlers were installed for every command | Adopted: only `run` installs them |
| INFO-002 | `validateFormats: false` hides nothing today | Kept: the one format field (`timestamp`) is checked by hand |
| INFO-003 | `baseline set` accepted an unfinished run | Adopted in `1030cb3`: only a finished run can be a baseline |

At `2709ce8`, `npm run check` is clean, and 474 tests pass with 4 (live) skipped.

## Review Round 2

| | |
| - | - |
| **Review Round** | 2 |
| **Reviewed SHA** | `813dd2b` (round-1 fixes: `761c7fb..813dd2b`) |
| **Reviewer** | PE-Vue |

PE-Vue marked every round-1 finding RESOLVED except LOW-004, which was partly fixed. It confirmed:

- `run | head` exits 1, with `finished`.
- A cancelled CTRF validates with ajv-formats.
- The `argv[2]` gate matches every run that executes.
- Accepting M5 as untested is reasonable: the fake's sleep honours abort, and back-to-back signals coalesce.

It found two MEDIUM:

- The signal tests fail under load.
- Five of the round's fixes had no test that fails without them.

| ID | Finding | Disposition |
| - | - | - |
| MEDIUM-001 | The signal tests sent a signal on every stdout chunk, so one landing in teardown killed the child (7 of 8 failed under 8-way load) | Fixed in `bf09370`. A shared `runUntil` acts once, on the first match. All three signalling tests use it. 8-way concurrent runs of the signal and store tests: 8 of 8 green |
| MEDIUM-002 | Five fixes had no test that fails without them: (a) list's catch, (b) `run.failed` reaching the listener when the store cannot write, (c) the redacted failure reason, (d) CTRF skipped entries, (e) exit 3 on a late write failure | Fixed in `bf09370`. (a) tears a finished run's verdicts.json. (b) and (c) make the whole run directory read-only mid-run, events.jsonl included; they assert that the live view prints `litmus failed:` and `exit 3`, that the reason is `[REDACTED]` on stdout and on stderr, and that the store never held the event. (d) validates a cancelled CTRF against the vendored schema. (e) removes the `--out` directory mid-run. All five mutants now fail the suite |
| LOW-001 | stderr had no EPIPE handler | Fixed in `8531268`: a closed log reader is ignored |
| LOW-002 | Some `--out` paths got past the pre-check, and compare turned a REGRESSION into exit 2 when its write failed | Fixed in `8531268`. A trailing `/`, a parent that is not an existing directory, and links (followed) are checked. Compare keeps its verdict's exit, and only a 0 becomes 3. Two new exit-2 rows |
| LOW-003 (round-1 LOW-004) | A cancelled run's documents left out pairs that never started a trial | Fixed in `8531268`. The stopped set comes from the pairs the run queued (`RunReport.scheduled`). Unit-tested with a pair that never started |
| INFO-001 | listRuns compared `started_at` as a string | Adopted: parsed times, with an unparseable time sorting oldest |
| INFO-002 | A torn verdicts.json crashed compare with exit 1 | Adopted: `readRun` makes it a ConfigError (exit 2). Tested |
| INFO-003 | The live view printed `exit 0` before a late write failure made it 3 | Adopted: the document is written first, and the view ends with the exit really returned. Tested |
| INFO-004 | The signal gate depends on the command being `argv[0]` | Adopted: commented at the gate |

At `f1f8bb0`, `npm run check` is clean, and 477 tests pass with 4 (live) skipped.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
