# Code Review: m6-runner-and-store

**Verdict:** ✅ APPROVED (round 2, locked to `bdbca9e`)

| | |
| - | - |
| **Branch** | `m6-runner-and-store` (Gate 1, local, before any PR; stacked on M5) |
| **Reviewer** | @Cali LaFollett (PE-Vue) |
| **Review Round** | 1 |
| **Reviewed SHA** | `c6d942c` |
| **Title** | M6: runner and store |
| **Date** | 2026-09-30 |

---

## Summary

PE-Vue checked the status precedence, the retry rules, the effective
`min_trials`, redaction and rerun selection against ARCHITECTURE § Flow, and
all of them hold. The findings are about what happens when something breaks,
and about comparisons against a baseline:

- One worker that threw left `run()` rejected while the other workers kept
  calling providers, and `run.json` stayed at `running` forever.
- WARN medians covered cases only one side ran.
- A missing baseline config was compared instead of skipped.
- Subject and plugin changes never reached the notes.
- A shared schema file sat outside the case hash.

Seven runner-contract mutants survived the suite.

At the reviewed SHA, `npm run check` is clean, and 13 runner and store tests
pass.

## Findings Overview

| Severity | In Scope | Out of Scope |
| - | - | - |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 1 | 0 |
| 🟡 MEDIUM | 5 | 0 |
| 🟢 LOW | 6 | 0 |
| ℹ️ INFO | 3 | 0 |

## Findings and dispositions

| ID | Finding | Disposition |
| - | - | - |
| HIGH-001 | An exception outside a trial's attempt (`keepAttempt`, `writeTrial`, a listener) rejected `run()`, while the other workers kept running and `run.json` stayed `running` | Fixed in `ef49621` and `11eb53f`. A trial that throws becomes an error trial (`internal error: …`) and the run goes on. If even that record cannot be written, a fault signal stops every worker, `run.json` is marked `failed` (a new status), and `run()` rejects. The listener is isolated. Workdir cleanup moved into a `finally`. Tests cover each path |
| MEDIUM-001 | WARN medians included baseline cases the current run never ran | Fixed in `ef49621`: both medians cover only the paired cases (the ones not in `excluded`). Probe P7's false WARN is now a test |
| MEDIUM-002 | `--baseline` compared a config the baseline lacks | Fixed in `ef49621`. `baselineSide` carries the baseline's configs, a missing config is skipped, and `RunOutcome.notes` reports it for M7 to print |
| MEDIUM-003 | Subject and plugin hash differences never reached `Comparison.notes` | Fixed in `ef49621`: `<case>: subject changed (a → b)` for paired cases, and `plugin <root>: changed` or `loaded only by <side>`. The case is still compared. Tested |
| MEDIUM-004 | The case hash missed a json-schema file outside the case dir | Fixed in `ef49621`: each non-builtin schema file's bytes join the case hash. The doc says a `command` grader's external script is not covered |
| MEDIUM-005 | Seven runner-contract mutants survived; the grading path had no coverage | Fixed in `ef49621` with `test/runner/mechanics.test.ts` (14 tests). Of these, 11 fail on `c6d942c`. All seven mutants (M1 unsummed usage, M2 `.attempts` kept, M3 no cleanup, M5 and M6 abort ignored, M7 no grading retry, M8 infra errors graded) now fail the suite |
| LOW-001 | A grading retry could keep a stale findings.json from an earlier extraction | Fixed in `ef49621`: each grading attempt starts from the executor's artifact map, and only the successful attempt's map is kept. Tested |
| LOW-002 | Usage `add` counted an unpriced call as $0 | Fixed in `ef49621`: `sumUsage` semantics, where a cost appears only when every call that spent tokens was priced. Tested |
| LOW-003 | Grading retries emitted no event | Fixed in `ef49621`: `trial.retry` with a `grading:` reason. Documented in `aaa49f6` |
| LOW-004 | The Flow pseudocode said comparison.json is written on cancel | Fixed in `aaa49f6`: "on finish" only |
| LOW-005 | Store writes were not atomic, and one torn run.json broke `listRuns` | Fixed in `11eb53f`: write to a temporary name and rename, and `listRuns` skips a run.json that does not parse. Tested |
| LOW-006 | `setBaseline` did not enforce the NAME grammar | Fixed in `11eb53f`. Tested with `main:fake` |
| INFO-001 | `RunStore.create` did not claim the id atomically | Adopted in `11eb53f`: a non-recursive `mkdir`, where EEXIST gives "already exists" |
| INFO-002 | A later throw discards the earlier attempt's reason; `exit` is `infra_error` with no result | Documented in `aaa49f6` (status table) |
| INFO-003 | The trial-key `filter` never filtered | Adopted in `ef49621`: a plain validation loop |

At `aaa49f6`, `npm run check` is clean, and 443 tests pass with 4 (live) skipped.

## Review Round 2

| | |
| - | - |
| **Review Round** | 2 |
| **Reviewed SHA** | `bdbca9e` (round-1 fixes: `c6d942c..bdbca9e`) |
| **Reviewer** | PE-Vue |

PE-Vue marked all 15 round-1 findings RESOLVED:

- The fault path cannot orphan a worker, and every throw after the store exists reaches `finish('failed')`.
- It ran 25 mutants. Every one that removes a fix is killed.
- `mechanics.test.ts` passed 12 of 12 parallel stress runs.

**✅ APPROVED:** no finding at MEDIUM or above. The new LOWs and INFOs were fixed after approval, in `404134c` and `72ce24c`:

| ID | Finding | Disposition |
| - | - | - |
| LOW-001 | WARN pooled every scored trial into one median, so a case with more scored trials weighed more | Fixed. A side's metric is now the median over cases of each case's median. Probe P1b is now a test, and it fails on `bdbca9e` |
| LOW-002 | `crashed()` recorded 0 attempts and zero usage, which hid real spend | Fixed. A throw inside a trial carries its attempts, its usage and its grading usage (`TrialCrash`) into the error record. Tested with 5,900 tokens and $1.20 |
| LOW-003 | A replaced extraction's findings.json stayed on disk | Fixed. Each grading attempt removes the previous attempt's extracted file, and a file the final record does not list is removed too. Tested |
| LOW-004 | Mutants T1, T5, T6, T7, T9 and T10 survived | Tests added for: a zero-token attempt next to a priced one; a changed plugin and a plugin on one side only; a crash during a cancel; a leftover `.tmp` replaced by the rename; and the exact "already exists" ConfigError. All six mutants now fail the suite |
| LOW-005 | The Flow paragraph on the case hash disagreed with § Comparison | Replaced with a cross-reference |
| INFO-001 | A failed run emitted no terminal event | Adopted: `run.failed` (best effort), in the event union and § Events. Tested |
| INFO-002 | An unreadable schema at run time rejected with a raw errno | Adopted: a ConfigError naming the case and the schema, raised before any run dir exists. Tested |
| INFO-003 | Plugin notes are keyed by absolute root | Documented as a limitation in § Comparison |

At `72ce24c`, `npm run check` is clean, and 450 tests pass with 4 (live) skipped.

## Merge Eligibility (latest)

**Locked to SHA:** `bdbca9e`. The PR opens once M5 (#7) merges and this branch is rebased onto main. It carries the post-approval commits `404134c` and `72ce24c` (LOW and INFO fixes only), and Gate 2 reviews them.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
