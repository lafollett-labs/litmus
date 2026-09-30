# Code Review: m5-statistics-and-verdicts

**Verdict:** 🔁 CHANGES REQUESTED (round 1, locked to `5d79740`)

| | |
| - | - |
| **Branch** | `m5-statistics-and-verdicts` (Gate 1, local, before any PR) |
| **Reviewer** | @Cali LaFollett (PE-Vue) |
| **Review Round** | 1 |
| **Reviewed SHA** | `5d79740` |
| **Title** | M5: statistics and verdicts |
| **Date** | 2026-09-30 |

---

## Summary

PE-Vue checked every done-when example by hand, and each one holds:

- Wilson 3/5 matches R's `prop.test(correct = FALSE)`.
- 5/5 at 0.8 is INCONCLUSIVE, and 16/16 is PASS.
- 1/1 against 0/1 is INCONCLUSIVE.
- Thirty 5/5 cases against 1/1 are not a REGRESSION, and the mirror is not an IMPROVEMENT.

The findings are about the contract and the tests, not the math:

- The spec's NO CHANGE evidence bar disagreed with the code by about ten times.
- The bootstrap was barely tested. Removing case resampling, the clamp or the Jeffreys smoothing survived every test, and so did a Box–Muller that was no longer normal.

At the reviewed SHA, `npm run check` is clean, and 401 tests pass with 4 (live) skipped.

## Findings Overview

| Severity | In Scope | Out of Scope |
| - | - | - |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 0 | 0 |
| 🟡 MEDIUM | 2 | 0 |
| 🟢 LOW | 8 | 0 |
| ℹ️ INFO | 3 | 0 |

## Findings and dispositions

| ID | Finding | Disposition |
| - | - | - |
| MEDIUM-001 | ARCHITECTURE said identical all-pass sides reach NO CHANGE at about 20 × 30 or 200 × 10. The code gets there at 2 × 30 and 14 × 10 | **The code is the contract.** Both sides run the same cases, so when every case agrees the case level adds no spread and only trial noise is left. That is the right model for a paired comparison. Spec corrected in `68927b4` with the measured boundaries at seed 1: 2 × 30, 14 × 10, 50 × 5 and 112 × 3. A test pins 1/2 × 30 and 13/14 × 10 (`7ff3e8a`). The operator may revisit this: a stricter bar needs a between-case variance floor, which is a design change |
| MEDIUM-002 | The bootstrap was barely tested: removing case resampling, the clamp, the Jeffreys smoothing, the outward rounding, or Box–Muller's 2π all survived | Fixed in `7ff3e8a`. There are golden intervals for a mixed fixture, for a heterogeneous suite (INCONCLUSIVE only because of case resampling), and for a clamped collapse. The normal test adds skew, kurtosis and P(\|Z\| < 1.96). All five mutants now fail |
| LOW-001 | The comment "delta always sits inside its own interval" was false once the clamp is active | Fixed in `7ff3e8a`: the comment and the spec say the interval sits just inside delta at the extremes. A test pins the 30 × 5/5 against 0/5 collapse |
| LOW-002 | The interval depended on the order of A's verdicts | Fixed in `7ff3e8a`: pairs are sorted by case id before resampling. The test shuffles both sides |
| LOW-003 | A hash on only one side did not exclude the case (fail open) | Fixed in `7ff3e8a`: it is excluded with "the case hash is missing on <label>" and does not flip |
| LOW-004 | The spec did not say which excluded cases still flip | Fixed in `68927b4` |
| LOW-005 | No boundary comparison was tested | Fixed in `eb9a015` and `7ff3e8a`. The tests cover: the rate lower bound exactly on the threshold; INCONCLUSIVE at exactly min_trials ('interval'); WARN at exactly 1.5× and 1/1.5; the suite verdict at ±δ (`suiteVerdict` exported); and Wilson 3/5 to 1e-12. Every listed mutant now fails |
| LOW-006 | minTrialsToPass looped once per trial count, and hung near 1 | Fixed in `eb9a015`: the walk starts just below the closed form, n ≈ z²t/(1−t), and then steps. It agrees with the old loop at 0.5 through 0.999999, and 0.999999999999 returns instantly |
| LOW-007 | PLAN said "a Jeffreys posterior", which was not shipped | Fixed in `68927b4`: "Jeffreys-smoothed variance" |
| LOW-008 | The `CompareSide.metrics` comment said "per-case medians" | Fixed in `7ff3e8a` |
| INFO-001 | WARN also skips a metric when B's median is missing | Spec updated in `68927b4` |
| INFO-002 | `settle()` trusted the caller to pass the effective min_trials | Fixed in `eb9a015`: it is documented, and capped by the trials scheduled inside `settle()`. The test settles one requested trial with min_trials 5 as PASS |
| INFO-003 | When both sides were unscored, the reason named only A; `TrialOutcome` had a redundant union | Fixed in `7ff3e8a` and `eb9a015` |

At `68927b4`, `npm run check` is clean, and 416 tests pass with 4 (live) skipped.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
