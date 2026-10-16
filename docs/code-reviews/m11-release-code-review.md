# Code Review: m11-release

**Verdict:** ✅ APPROVED (round 2, locked to `8aa848b`)

| | |
| - | - |
| **Branch** | `m11-release` (Gate 1, local, before any PR; stacked on M10) |
| **Reviewer** | @Cali LaFollett (PE-Vue) |
| **Review Round** | 2 (Gate 1), then Gate 2 on PR #16 below |
| **Reviewed SHA** | `98ee084` (round 1; see SHAs after rebasing) |
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

## SHAs after rebasing

The SHAs above are pre-rebase. The branch was rebased onto each merge of M5 through M10 and #15, and those commits are not on the PR. They correspond to these PR #16 commits, which stay on GitHub with the PR after the squash merge:

| Recorded | On PR #16 | Commit |
| - | - | - |
| `98ee084` | `ad1d479` | docs(architecture): re-read against the code for 0.1.0 (round 1's head) |
| `d237ace` | `c685177` | fix(run): check only the pairs a run would run; one region rule; bedrock judges too |
| `b180d6d` | `8c79222` | fix(validate): a fix through a link named .git or .DS_Store resolves outside the case |
| `8aa848b` | `0be5214` | docs: m11 code review, round 1 (round 2's head) |
| `bf4188e` | `ea60a11` | fix(run): a trial key on a config the run does not use says so before any other check |

## Gate 2 (PR #16)

Copilot is out of quota, so a fresh PE-Vue with no prior context stood in for it. It ran the README quickstart as written in a fresh clone, and checked 45 ARCHITECTURE statements against the code: 44 matched, and the 45th is INFO-002. It also checked the release mechanics: the version is read from `package.json`, the license is MIT, and nothing private is tracked.

| Round | Reviewed SHA | Found | Outcome |
| - | - | - | - |
| 1 | `44fe147` | 1 MEDIUM, 5 LOW, 4 INFO | Fixed, as below |

| ID | Finding | Disposition |
| - | - | - |
| MEDIUM-001 | The quickstart's real-model line, run without a key, gave 6 ERRORs and exit 3 with no reason on the terminal; the reason reached only `trial.json` and the UI | Fixed, keeping exit 3, so CI still reads it as infrastructure trouble. Each `infra` or `blocks` line, and each CTRF or JUnit failure message, now says why its pair's trials errored: the first distinct reason, the rest counted. Through the CLI with no key, the line reads `infra   smoke/passes@sonnet-5 ERROR — ANTHROPIC_API_KEY is not set`. The README says so too. Tested for one reason, several, and none; both mutants (the pretty line and the document message) are killed |
| LOW-001 | A proof that locked the bug's own file still threw EACCES out of `validate` | Fixed: both snapshots of the bug's file are guarded and fail their bug alone. Tested (`locksbug`); the unguarded snapshot, as a mutant, fails |
| LOW-002 | Region precedence and an empty `AWS_DEFAULT_REGION` were not pinned for `planRun` | Fixed. `regionless` tests falsiness, and tests pin the order (the config's own, then `AWS_REGION`, then `AWS_DEFAULT_REGION`) and an empty `AWS_DEFAULT_REGION`. The swap and the dropped coalesce, both of which survived before, are now killed. The defensive `proofAfter` guard (M17) is kept as unreachable defence |
| LOW-003 | No `litmus --version`, and the bug template did not ask for it | Fixed: `-v`, `--version` and `version` print `litmus <version>` and exit 0. The usage, ARCHITECTURE § CLI and the bug template all name it. Tested; the mutant is killed |
| LOW-004 | ARCHITECTURE's opening said contracts change freely only until 0.1.0 | Fixed to match the CHANGELOG: before 1.0.0, a minor version may change any contract |
| LOW-005 | The review record's SHAs were pre-rebase, and the round field was stale | Fixed: the table above maps them, and the round field is corrected |
| INFO-001 | `--config constructor` hit Object's constructor in `runnable()` | Fixed with `Object.hasOwn`, as run.ts does. Tested; the mutant is killed |
| INFO-002 | The env-allowlist summary said the AWS files pass only when set | Fixed: with `AWS_PROFILE`, they default to the operator's `~/.aws` files |
| INFO-003 | PLAN M11 is ticked before the tag exists | Accepted: the tag goes on the merge commit right after this PR merges, and the release is checked before this is called done |
| INFO-004 | Verified correct | None needed |

## Merge Eligibility (latest)

**Locked to SHA:** `8aa848b`. The PR opens once M5 through M10 merge. It carries the post-approval commit `bf4188e` (LOW and INFO fixes only), and Gate 2 reviews it.

These wait for everything to merge:

- the version bump to `0.1.0`
- the `v0.1.0` tag
- the GitHub release
- the PLAN tick

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
