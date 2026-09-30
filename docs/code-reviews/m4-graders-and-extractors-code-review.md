# Code Review: m4-graders-and-extractors

**Verdict:** ✅ APPROVED (round 2, locked to `e5c5df3`)

| | |
| - | - |
| **Branch** | `m4-graders-and-extractors` (Gate 1, local, before any PR) |
| **Reviewer** | @Cali LaFollett (PE-Vue) |
| **Review Round** | 1 |
| **Reviewed SHA** | `a8b2c30` |
| **Title** | M4: graders and extractors |
| **Date** | 2026-09-29 |

---

## Summary

M4's graders were written before M3's Gate 2 hardening and then rebased onto it. Most findings are places where they did not yet follow main's contracts:

- **Deadlines:** a judge call had none, although the model executor has one.
- **Redaction:** graders had no redactor.
- **Subject-controlled files:** artifacts were read by following links, and extract could crash on a planted directory.
- **Silent passes:** tool results counted as subject text, a regex empty match counted as a match, and a review-match with no applicable bound passed.

PE-Vue probed every claim in a scratch copy. It fuzzed the matching against brute force over 4,000 cases and found 0 mismatches. At the reviewed SHA, `npm run check` is clean, and 313 tests pass with 4 (live) skipped.

## Findings Overview

| Severity | In Scope | Out of Scope |
| - | - | - |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 1 | 0 |
| 🟡 MEDIUM | 6 | 0 |
| 🟢 LOW | 7 | 0 |
| ℹ️ INFO | 2 | 0 |

## Findings and dispositions

| ID | Finding | Disposition |
| - | - | - |
| HIGH-001 | Judge, confirm and extract calls had no deadline, so a provider that never settles hung grading forever | Fixed in `2051d48`. `ask()` has a 300 s deadline and races the call with `raced()`, which is now shared with the model executor. A timeout is a retryable `InfraError`, a cancel is not a timeout, and a late answer is never accepted. The test uses mock timers and fails on the old code |
| MEDIUM-001 | A `fake` judge could never answer, because judge requests carry no trace; and even with one, fake.yaml scripts the subject | Fixed in `b14deb4`: a judge on the fake provider is refused at config load. ARCHITECTURE § Suite says why |
| MEDIUM-002 | Command output was cut to its tail before any redaction, and graders had no redactor | Fixed in `8926d80`. `GradeContext.redact`; `gradeAll` redacts every rationale; the command keeps a 1 MiB window and redacts it before cutting to 4,000 bytes; extracted findings are redacted. The test puts a key across the cut |
| MEDIUM-003 | A directory the subject planted at `extract.to` made extract throw a raw EISDIR | Fixed in `6d33443`: a write failure fails the extraction with a reason. Canary test |
| MEDIUM-004 | The regex `transcript` target included tool results, so fixture text counted as the subject's | Fixed in `bbd3b71`: `subjectText` is assistant messages and tool calls only. Canary for a pattern found only in a Read result |
| MEDIUM-005 | ARCHITECTURE said file-exists checks what "the subject created"; the code checks existence after the trial | Doc fixed in `f0c861a`: existence after the trial is the contract |
| MEDIUM-006 | Judge and extract material was unbounded, so a long session became a non-retryable ERROR instead of a FAIL | Fixed in `7393de5`: capped at 400,000 characters, keeping head and tail with an elision marker. Both prompt versions are bumped to 2 |
| LOW-001 | A regex that matches the empty string counted every position | Fixed in `bbd3b71`: only non-empty matches count. Canary |
| LOW-002 | A review-match with no applicable bound passed an empty review | Fixed in `cb4db37`. At runtime, a grade where no bound applied fails. At load, a review-match must set a bound that can apply to its truth; on a clean case, `min_recall` alone does not count |
| LOW-003 | `readArtifact` followed links, could throw between its check and its read, and had no size limit | Fixed in `bbd3b71`: it reads through `readRegular`, with a 64 MiB cap. The canary is valid findings behind a link, a FIFO or too many bytes |
| LOW-004 | A failed extraction left no trace | Fixed in `6d33443`: `RunExtract` returns `error`, including the redacted reply. The stale on-disk file is still left in place; the artifact map is what graders read |
| LOW-005 | A setsid grandchild held the command grade to its full timeout | Fixed in `30e4502`: after the shell exits, a 2 s grace, then it finishes on the exit code. The test fails on the old code (15 s) |
| LOW-006 | Judge and extractor usage was thrown away | Fixed in `2051d48`: `GraderResult.usage` and `RunExtract`'s `usage`, summed across confirm calls |
| LOW-007 | `recall_<severity>` was omitted, not null, when the truth lacks that severity | Fixed in `cb4db37`: all four are always present |
| INFO-001 | ARCHITECTURE's Grader interface did not match `GradeContext` | Fixed in `f0c861a` |
| INFO-002 | Matching runs on the event loop and is bugs × findings | Fixed in `cb4db37`: more than 1,000 findings fail the grade |

At `f0c861a`, `npm run check` is clean, and 328 tests pass with 4 (live) skipped.


## Review Round 2

| | |
| - | - |
| **Review Round** | 2 |
| **Reviewed SHA** | `e5c5df3` (round-1 fixes: `a8b2c30..e5c5df3`) |
| **Reviewer** | PE-Vue |

PE-Vue verified all 16 round-1 findings as RESOLVED, with probes. Two of them it checked in depth:

- The load-time bound rule is exact. The truth schema forces a seeded case to have bugs and a clean case to have none, so the only bounds that are always n/a are `min_recall` and `min_claims_correct` on a clean case. Those are the two the rule excludes.
- 5 MB of command output kept its last line, and 500 MB cost 831 ms.

**✅ APPROVED:** no finding at MEDIUM or above. All four LOWs and INFO-003 were fixed after approval, so Gate 2 reviews them:

| ID | Finding | Disposition |
| - | - | - |
| LOW-008 | The prompt pins did not cover `MATERIAL_CHARS`, so the cap could change without a version bump | Fixed in `4edcb25`: both pins hash the cap and a clip at the cut. Mutation check: 300,000 with no bump fails both pins |
| LOW-009 | After a cancel or timeout, the SIGKILLed shell's exit armed a 2 s grace timer that held the process | Fixed in `4a51ed1`: the timer is armed only while the grade is unsettled. The test asserts no Timeout is left, and fails on the old code |
| LOW-010 | An artifact over the cap, or one that is not a regular file, was reported as "was not produced" | Fixed in `4edcb25`: `unread()` names the cause, and every caller uses it |
| LOW-011 | A fixed 300 s judge deadline could time out a long, legitimate extraction on every attempt | Fixed in `4a51ed1`: `max(300, max_tokens / 20)` seconds, so an extraction gets 800 s |
| INFO-003 | The size cap was checked on the path, then read through a separate fd | Fixed in `4edcb25`: `readRegular(path, maxBytes)` checks it with `fstat` on the open file |
| INFO-004 | Judge and extract usage is returned unpriced | Deferred to M6: the runner prices grader and extract usage with the judge's model |

At `4edcb25`, `npm run check` is clean, and 330 tests pass with 4 (live) skipped.

## Merge Eligibility (latest)

**Locked to SHA:** `e5c5df3`. The PR opens with the post-approval commits `4a51ed1` and `4edcb25` (LOW and INFO fixes only), and Gate 2 reviews them.


## Gate 2: PR #6 (local substitute: Copilot's quota is exhausted)

A fresh PE-Vue review with no Gate 1 context stands in for Copilot.

| Round | Reviewed SHA | Found | Outcome |
| - | - | - | - |
| 1 | `f80319b` | 2 MEDIUM, 5 LOW, 2 INFO | All fixed in `4bd3f31`, each with a test that fails when its fix is removed. MEDIUM-001: an empty final message was extracted into zero findings, so a clean case passed on silence; a blank source is now never extracted. MEDIUM-002: `gradeAll` graded on past a cancel and returned a set that read as a failed trial; a cancel now rejects it. LOW-001: regex counts without collecting and stops past `max` (a 60 MiB artifact OOM'd the process). LOW-002: closing tags are defused in any case or spacing (prompt versions 3), and SECURITY.md states the judge-injection stance. LOW-003: a seeded review-match must set `min_recall` or `min_claims_correct` at load. LOW-004: an extraction cut off at the token cap says so. LOW-005: redaction tests that fail when gradeAll's or extract's redaction is removed. INFO-001: the matching cost is documented. INFO-002: the command tail is cut on a character boundary |
| 2 | `92ad1f9` | 5 LOW, 2 INFO | **Clean at MEDIUM and above.** Round 1 verified: 8 fixes RESOLVED, and LOW-004 was partial because OpenRouter reports `length`. All five LOWs and INFO-001 were fixed after the round in `2da6427`, each with a test that fails on the old code. LOW-001: OpenRouter's `length` is recognised as the token cap. LOW-002: a cancel inside a judge call rejects with the signal's own reason. LOW-003: the seeded rule is case-wide (recall bounded in one grader is enough), and `min_recall: 0` does not count. LOW-004: a capped regex count reads null. LOW-005: ARCHITECTURE's list renders. INFO-001: the UTF-8 skip is bounded at 3 bytes. INFO-002 confirmed the tag defuse and SECURITY.md's row |

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
