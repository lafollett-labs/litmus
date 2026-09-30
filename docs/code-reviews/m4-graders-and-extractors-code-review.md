# Code Review: m4-graders-and-extractors

**Verdict:** 🚫 BLOCKED (round 1, locked to `a8b2c30`)

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

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
