# Code Review: m11-release

**Verdict:** 🔄 CHANGES REQUESTED (round 1; round 2 pending on `b180d6d`)

| | |
| - | - |
| **Branch** | `m11-release` (Gate 1, local, before any PR; stacked on M10) |
| **Reviewer** | @Cali LaFollett (PE-Vue) |
| **Review Round** | 1 |
| **Reviewed SHA** | `98ee084` |
| **Title** | M11: release prep for 0.1.0 (quickstart, CHANGELOG, ARCHITECTURE re-read, and the code fixes it found) |
| **Date** | 2026-09-30 |

---

## Summary

The branch holds a README quickstart and a CHANGELOG. It also holds the ARCHITECTURE.md re-read against the code. That re-read found 50 disagreements. Four of them were code bugs, fixed in their own commits:

- a trial's error reason was lost when no attempt wrote anything
- a config every trial would fail on (a bedrock config with no region, or a harness case on a provider it cannot use) was not refused before the run
- validate missed a symlink in a case
- the usage text and three comments were stale

PE-Vue verified the following, and found them correct:

- The quickstart, run as written.
- The server's 400 for the new refusal.
- Each fix's test, which fails without its fix.
- About 30 ARCHITECTURE statements, checked against the code by file and line.

It found three problems:

- The new refusal was tested only on the refusing side. A mutant that turned off every bedrock config passed all 527 tests.
- The refusal also over-reached on trial-key runs.
- Removing validate's fix realpath check left a gap through `.git` and `.DS_Store`, which the case hash skips.

## Findings Overview

| Severity | In Scope | Out of Scope |
| - | - | - |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 0 | 0 |
| 🟡 MEDIUM | 1 | 0 |
| 🟢 LOW | 3 | 0 |
| ℹ️ INFO | 2 | 0 |

## Findings and dispositions

| ID | Finding | Disposition |
| - | - | - |
| MEDIUM-001 | Only the refusing side of `planRun`'s new check was tested: a mutant refusing every bedrock config, or harness-on-bedrock, passed all 527 tests | Fixed in `d237ace`. New direct `planRun` tests cover the allowed side: a region from the config, from `AWS_REGION`, and from `AWS_DEFAULT_REGION` (including an empty `AWS_REGION`), and a harness case on anthropic and on bedrock. Both of the review's mutants, and three more, now fail |
| LOW-001 | `runnable()` checked every config against every selected case, so a valid trial-key run was refused | Fixed in `d237ace`. The check covers only the (case, config) pairs that `expand()` makes: a trial key pins its own config, and a rerun runs only its pairs. Tested; the mutant is killed |
| LOW-002 | The case hash skips `.git` and `.DS_Store`, so a fix through a link by either name passed validate | Fixed in `b180d6d`. The realpath check on a fix is back, tested with both names; the mutant is killed. ARCHITECTURE qualifies the no-symlink rule |
| LOW-003 | The quickstart said ERROR blocks; ERROR is infrastructure trouble (exit 3) | Fixed in `b180d6d` |
| INFO-001 | Three region lookups differed, and bedrock judges were not checked | Adopted in `d237ace`. `bedrockRegion()` is now the one rule for the model executor, the harness and `planRun`, and an empty value counts as unset. A bedrock judge that a selected case calls is refused before the run when it has no region. Both are tested |
| INFO-002 | Verification receipts | None needed |

At `b180d6d`:

- `npm run check` exits 0.
- `npm test` passes 532 of 536, with 4 (live) skipped.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
