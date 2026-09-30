# Code Review: m5-statistics-and-verdicts

**Verdict:** ✅ APPROVED (round 2, locked to `6f64868`)

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


## Review Round 2

| | |
| - | - |
| **Review Round** | 2 |
| **Reviewed SHA** | `6f64868` (round-1 fixes: `5d79740..6f64868`) |
| **Reviewer** | PE-Vue |

PE-Vue ran 30 mutants and 25 were killed, including all seven round-1 bootstrap mutants. It confirmed MEDIUM-001's rationale: identical cases leave only the per-case term, which averages down as sd/√n. It marked 11 round-1 findings RESOLVED. Two were still present: LOW-005, with two boundary mutants surviving, and LOW-006, where `minTrialsToPass` could still hang within about 1e-10 of 1, and forever at 1 − 2⁻⁵³ or with z = 1e10.

**✅ APPROVED:** no finding at MEDIUM or above. The re-raised LOWs, and the new ones, were fixed after approval:

| ID | Finding | Disposition |
| - | - | - |
| LOW-005 (re-raised) | The WARN test missed the lower band edge, because (100/1.5)/100 is one ulp off 1/1.5; and rate's `ci.hi < threshold` had no exact-boundary test | Fixed in `3f49bc1`. WARN is tested at 150 → 100, where the ratio is exactly 1/1.5, and rate at a threshold equal to `wilson(0, 16).hi`. Both mutants are now killed |
| LOW-006, new LOW-002 | minTrialsToPass could start above the answer in floating point, walk millions of steps, or loop forever | Fixed in `3f49bc1`. It brackets from the closed form and bisects on `wilson` itself, so there are at most about 60 wilson calls. It refuses a z that is not finite and positive, and any threshold needing more than 10,000,000 unbroken trials. It matches the old walk on 2,009 thresholds, and the tests cover 1 − 1e-14, 1 − 2⁻⁵³, z = 1e10 and an explicit z. The one surviving mutant (ignoring z in the bracket's start) is equivalent: the start only affects speed |
| LOW-001 (new) | "112 × 3" is the first NO CHANGE, but the verdict falls back at 114, 115, 117 and 121 | Fixed in `fd9c2b7`: "about 120 × 3 (between 112 and 121 cases the seed decides)". No 3-trial pin, since it would be fragile |
| INFO-001 (new) | Golden intervals compared bit for bit, so a last-bit refactor failed them | Adopted in `3f49bc1`: they compare within 1e-12, which every real mutant exceeds by 6e-5 or more |

At `fd9c2b7`, `npm run check` is clean, and 417 tests pass with 4 (live) skipped.

## Merge Eligibility (latest)

**Locked to SHA:** `6f64868`. The PR opens with the post-approval commits `3f49bc1` and `fd9c2b7` (LOW and INFO fixes only), and Gate 2 reviews them.


## Gate 2: PR #7 (local substitute: Copilot's quota is exhausted)

A fresh PE-Vue review with no Gate 1 context stood in for Copilot.

| Round | Reviewed SHA | Found | Outcome |
| - | - | - | - |
| 1 | `4f69e42` | 1 HIGH, 2 MEDIUM, 2 LOW | **A design defect, not a coding slip**. It is fixed in `da00b73`, with docs in `48fc202`. HIGH-001: at few cases the two-level bootstrap was too narrow. Counted exactly, a single 5v5 case claimed a change 11% of the time (5.47% each way), 30v1 claimed 8.25%, and 30v3 claimed 17.7%. MEDIUM-001: at many cases it counted trial noise twice. Coverage was 98–99.8%, and a real 0.9 → 0.75 drop across 30 × 5 was called only 34% of the time. **The fix replaces the bootstrap with MOVER over per-side Wilson intervals, exact (Clopper–Pearson) below 6 trials.** The cutover was chosen by sweeping it against exact single-case enumeration over 1–30 trials and rates 0.05–0.95. At 6, the worst cell is 2.12% per direction, against 3.27% at 5. MOVER holds every single-case cell at or under 2.5% (a test counts this exactly), and it catches more real drops: 30 × 5 0.9 → 0.75 at 41%, and 10 × 10 0.9 → 0.7 at 71% (it was 53%). It is deterministic, so `compare.resamples`, `compare.seed`, mulberry32 and the normal sampler are removed. **This changes one approved semantic**: the suite is its fixed cases, so three of ten collapsing from 30/30 to 0/30 is now a REGRESSION rather than INCONCLUSIVE. The NO CHANGE boundary is now 6 × 30, 31 × 10, 109 × 5 and 201 × 3, and it never falls back. MEDIUM-002: a canary comparison test was added (A rejects every canary, B waves them all through, the result is REGRESSION); it fails on a `passes` mutant. LOW-001: `tolerance` and `warnRatio` are validated, and a non-finite metric is skipped. LOW-002: when neither side carries hashes, the notes say so |

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
