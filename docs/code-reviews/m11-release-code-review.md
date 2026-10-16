# Code Review: m11-release

**Verdict:** ✅ APPROVED (round 2, locked to `8aa848b`)

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

## Review Round 2

| | |
| - | - |
| **Review Round** | 2 |
| **Reviewed SHA** | `8aa848b` |
| **Reviewer** | PE-Vue |

PE-Vue marked MEDIUM-001, LOW-002, LOW-003, INFO-001 and INFO-002 RESOLVED, with evidence.

LOW-001 is PARTIAL. The code is right, but its rerun half had no test, so the round-1 disposition overclaimed.

PE-Vue ran 11 mutants:

- 8 were killed.
- 3 survived: the rerun filter, and two in the harness's region lookup. The findings below close all three.

At the reviewed SHA, `npm run check` exits 0, `npm test` passes 532 of 536 with 4 (live) skipped, and `validate` exits 0.

**✅ APPROVED:** no finding at MEDIUM or above. The findings were fixed after approval, in `bf4188e`:

| ID | Finding | Disposition |
| - | - | - |
| LOW-002 | The rerun `only` filter in `runnable()` was untested | Tested. A stored run on fake, with a regionless bedrock config added to its manifest, reruns `--only fail` and is planned. The filter's mutant is killed |
| LOW-003 | A trial key naming a config the run does not use was refused for that config's region or provider | Fixed. `planRun` gives `expand()`'s own message ("names config …, which this run does not use") before any other check. Tested for both probes; the mutant is killed |
| INFO-001 | The harness call site of the shared region rule had no test | Tested. When `AWS_REGION` is empty and `AWS_DEFAULT_REGION` is set, the harness forwards the latter as `AWS_REGION`. The old `??` lookup, as a mutant, fails the test |

At `bf4188e`, `npm run check` exits 0 and `npm test` passes 534 of 538, with 4 (live) skipped.

## Carried from PR #14 (M10) Gate 2

M10 merged as approved in Gate 2 round 4. That round's one LOW is fixed here, so M11's Gate 2 reviews it:

| ID | Finding | Disposition |
| - | - | - |
| PR14-R4-LOW-001 | A proof that made its own file or proof-only directory unreadable on its first run threw EACCES out of `validate` (exit 3), and no other case was reported | Fixed: an error while snapshotting what the proof owns is an error for that bug alone. Tested for a locked file and a locked directory, with a sibling case still reported. The unguarded snapshot, as a mutant, fails |

M11 also merges M10's Gate 2 rules into the ARCHITECTURE re-read: ground truth, the proof-edit check, `GOTOOLCHAIN`, and three warnings. A case `validate` cannot read (EACCES while hashing) is an error for that case alone, matching M10's per-case rule.

## Carried from PR #15 (issue #13) Gate 2

#15 merged as approved. Its LOW and one INFO are fixed here, so M11's Gate 2 reviews them:

| ID | Finding | Disposition |
| - | - | - |
| PR15-LOW-001 | A queued trial of a cancelled run showed the server's 404 as a red error, though it never ran | Fixed. An unfinished trial of a cancelled run gets a neutral note, "not run: the run was cancelled before this trial started", both when it is opened after the cancel and when it was already open as the stream ended. A record that exists is still shown. Tested on both paths and with a record present. Dropping the note in either path, as a mutant, fails |
| PR15-INFO-001 | The pane's header icon fell back to "queued" for a running trial with no record | Fixed: it falls back to the trial's state in its own run. An e2e assertion opens a running trial and expects "running"; the old fallback, as a mutant, fails it |

## Merge Eligibility (latest)

**Locked to SHA:** `8aa848b`. The PR opens once M5 through M10 merge. It carries the post-approval commit `bf4188e` (LOW and INFO fixes only), and Gate 2 reviews it.

These wait for everything to merge:

- the version bump to `0.1.0`
- the `v0.1.0` tag
- the GitHub release
- the PLAN tick

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
