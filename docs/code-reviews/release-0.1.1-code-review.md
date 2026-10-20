# Code Review: release-0.1.1

**Verdict:** ✅ APPROVED (round 1, at `addee96`). The two non-blocking LOWs are fixed in the commit after it.

| | |
| - | - |
| **Branch** | `release/0.1.1` (Gate 1, local, before any PR) |
| **Reviewer** | PE-Vue (also the Gate 2 reviewer of PR #17, whose LOWs this branch carries) |
| **Review Round** | 1 |
| **Reviewed SHA** | `addee96` |
| **Title** | Release 0.1.1: the PR #17 follow-ups and the version bump |
| **Date** | 2026-10-19 |

---

## Summary

This branch does four things:

- It denies the directory that holds the run store (PR #17 LOW-G2-001). The directory is not denied when the workdir, a plugin or the subject root sits inside it.
- It adds a real-binary row for CLAUDE.md imports, for a fixture file and for one the subject writes (LOW-301, INFO-G2-001).
- It narrows the gate's doc claims (LOW-G2-002).
- It bumps the version to 0.1.1.

| Severity | In Scope | Out of Scope |
| - | - | - |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 0 | 0 |
| 🟡 MEDIUM | 0 | 0 |
| 🟢 LOW | 2 | 0 |
| ℹ️ INFO | 1 | 1 |

| ID | Finding | Disposition |
| - | - | - |
| LOW-R-001 | The e2e comment said a subject-written CLAUDE.md's imports are not attempted. They are: Claude Code only skips re-injecting the body. The row also could not detect an SDK that stopped resolving imports | Fixed. The comment is corrected, and each file imports one in-workdir control (INSIDE-root, INSIDE-nested, INSIDE-written), which must reach the model. Control: pointing the written file's import at a missing file fails with "the written CLAUDE.md's imports were never resolved" |
| LOW-R-002 | The CHANGELOG overstated which stores the parent-dir deny covers | Fixed. It now names `.litmus/` and the stores kept there |
| INFO-R-001 | No false denial across five layouts (results outside the repo, parent HOME-like, parent `/`, a symlinked plugin, a symlinked store) | Noted |
| INFO-R-002 | Claude Code's own spill files (background output) are outside the workdir, so the gate denies Reads of them | Out of scope. Tracked with LOW-004 |

## Test evidence

| PE | Test budget | Evidence |
| - | - | - |
| PE-Vue | targeted | check exit 0; e2e 4/4; harness.test 41/41; probes S1–S5 and P10 |

After the fixes:

- `npm run check` exit 0.
- `npm test` tests 609, pass 604, fail 0, skipped 5.
- `node --test test/executors/harness-e2e.test.ts` tests 4, pass 4, fail 0, skipped 0.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
