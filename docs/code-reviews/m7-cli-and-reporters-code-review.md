# Code Review: m7-cli-and-reporters

**Verdict:** ✅ APPROVED (round 3, locked to `b6bf84e`)

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

## Review Round 3

| | |
| - | - |
| **Review Round** | 3 |
| **Reviewed SHA** | `b6bf84e` (round-2 fixes: `813dd2b..b6bf84e`) |
| **Reviewer** | PE-Vue |

PE-Vue marked all 9 round-2 findings RESOLVED:

- All five round-2 mutants, (a) to (e), now fail `npm test`.
- The signal tests passed 16 of 16 filtered runs and 8 of 8 full-file runs under 8-way load.
- No read-only directory was left behind after about 40 runs of the chmod test, failing ones included.

**✅ APPROVED:** no finding at MEDIUM or above. The findings were fixed after approval, in the commit after `b6bf84e`:

| ID | Finding | Disposition |
| - | - | - |
| LOW-001 | Some `--out` paths still slipped through: a stat error (EACCES, ENAMETOOLONG, ELOOP) crashed with exit 1, `nothere/../x` passed a lexical check and failed after the run, and so did a link to nothing | Fixed. Any errno from the check is a usage error (exit 2). The parent is resolved by the OS (`realpathSync.native`), so every segment must exist, and it must be a directory. A link to nothing is refused. The path written is the path checked. Five new exit-2 rows cover a locked directory, a 300-character name, `nothere/../x`, a dangling link, and a file as the parent |
| LOW-002 | compare printed `exit 0`, then returned 3 when its write failed | Fixed: the write comes first, then the exit really returned is printed. The dangling-link case that reached it is now caught by the pre-check (tested for compare too) |
| INFO-001 | listRuns' parsed-time sort had no killing test, and the chmod test found its run by mtime | Adopted: a store test orders two runs whose `started_at` offsets sort one way as text and the other as time, and `runUntil` hands `act` the output so far, so the test takes the run id from it |

The fix commit `1e52749` passed all 477 tests but **did not typecheck**: compare's `final` kept the `0 | 1` type of `compareExit`. My check step printed nothing, and I missed that it had not passed. It is fixed in the next commit, and at that commit `npm run check` is clean, which I have verified, and 477 tests pass with 4 (live) skipped.

## Gate 2 (PR #10)

Copilot is out of quota, so a fresh PE-Vue with no Gate 1 context stood in for it.

| Round | Reviewed SHA | Found | Outcome |
| - | - | - | - |
| 1 | `7ae327e` | 1 MEDIUM, 5 LOW, 2 INFO | Fixed, as below |
| 2 | `0d29e4c` | 0 at MEDIUM or above; 1 LOW, 4 INFO | **Clean.** All round-1 findings are RESOLVED; 10 of 11 mutants are killed, and the survivor is the accepted compare late-write gap, closed below |

| ID | Finding | Disposition |
| - | - | - |
| MEDIUM-001 | `compare` and `list` exited 1 with a raw stack trace on any store I/O error, or on a `run.json` of the wrong shape, so CI read infrastructure trouble as a REGRESSION | Fixed. `main()` turns any error that is not a usage or config error into one redacted line on stderr and exit 3; the config's redact list is used when it still loads. `listRuns` skips a `run.json` without its configs and cases, as it skips a torn one. Tested: a results directory at mode 000 makes `compare` and `list` exit 3 with one redacted line; a shapeless record no longer breaks `config:<name>`. Both mutants are killed |
| LOW-001 | On a TTY, a failed run's `exit 3` landed on the stale status line | Fixed. After `run.failed` or `run.cancelled` the live view draws no status line. Tested for both; the mutant is killed |
| LOW-002 | ARCHITECTURE said any run record that does not parse is a config error, but a torn `trial.json` is skipped | Fixed: the docs name `run.json` and `verdicts.json` as the config errors, say that listing skips shapeless and torn runs, and that a torn `trial.json` is skipped |
| LOW-003 | Five reporter and exit mutants survived | Tested: a FAIL whose `--out` vanishes keeps exit 1; a CTRF FLAKY that is blocked is failed with no `flaky` key and a message; JUnit replaces every XML 1.0 control character and U+FFFE/U+FFFF. Four of the five are killed. `compare`'s late-write branch has no test: compare's `--out` is checked first and written at once, so no test can make it fail between the check and the write. It shares its rule with `run`'s, which is tested |
| LOW-004 | `--help` listed 130 but not 143 | Fixed: "130 cancelled by SIGINT, 143 by SIGTERM", and compare's exit codes are listed too |
| LOW-005 | A rerun with nothing to rerun, or a failed run, left an old file at `--out` in place | Documented. `--out` is written only when a run finishes, and anything already there is left untouched. Deleting a file litmus did not write would be the bigger surprise |
| INFO-001 | CTRF duration sums trial wall-clocks, so it can exceed stop minus start | Accepted: it is schema-valid, and the sum is the work done |
| INFO-002 | A suite named `comparisons` collided with JUnit's comparisons testsuite | Adopted: the testsuite is `litmus:comparisons`, which is not a NAME. Tested; the mutant is killed |

Round 2:

| ID | Finding | Disposition |
| - | - | - |
| NEW-LOW-001 | Only `listRuns` checked a record's shape. By id, a shapeless `run.json` reached `compare` (exit 3 with a message naming no file) and `baseline set` (recorded) | Fixed. `readRun` checks configs, cases, judges and plugins and throws a ConfigError that names the file (exit 2), and `listRuns` uses the same predicate. Tested by id for `compare` and `baseline set`, and for a record missing only `plugins`; all three mutants are killed |
| NEW-INFO-001 | Exit-2 lines printed absolute paths unredacted | Adopted: a usage or config error goes through the same redactor. Tested; the mutant is killed |
| NEW-INFO-002 | The catch-all can turn a blocking post-run result into 3 if reading the trials back throws | Accepted: those files were just written by this process |
| NEW-INFO-003 | "Written only when a run finishes" misread a cancelled run | Fixed: `--out` is written whenever a run ends, finished or cancelled |
| NEW-INFO-004 | compare's late-write branch is testable on Linux through `/dev/full` | Adopted: a Linux-only test (CI runs Linux) checks that INCONCLUSIVE keeps exit 1 and an allowed one becomes 3 |

## Merge Eligibility (latest)

**Locked to SHA:** `b6bf84e`. The PR opens once M5 and M6 merge and this branch is rebased onto main. It carries the post-approval commit (LOW and INFO fixes only), and Gate 2 reviews it.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
