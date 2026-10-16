# Code Review: m10-examples-and-validate

**Verdict:** ✅ APPROVED (round 3, locked to `7ada74d`)

| | |
| - | - |
| **Branch** | `m10-examples-and-validate` (Gate 1, local, before any PR; stacked on M9) |
| **Reviewer** | @Cali LaFollett (PE-Vue) |
| **Review Round** | 1 |
| **Reviewed SHA** | `5dc5606` |
| **Title** | M10: example suites and `litmus validate` |
| **Date** | 2026-09-30 |

---

## Summary

PE-Vue checked the example suites against their ground truth:

- The line ranges match the post-change files.
- Each proof fails on the change.
- Each fix cures only its own bug.
- The decoy is correct code.
- Each fake script gives the verdict its description promises.

It then probed `validate` as the runner of suite authors' commands.

The findings:

- A bad `proof/` tree ended the whole run with an exception.
- Ctrl-C or SIGTERM orphaned a running proof's process group and left its copy behind.
- The subject-root check failed model cases, which `run` accepts.
- The Go scope proof failed on the feature assertion before it ever reached the escalation it exists to prove.
- The repository's config priced Sonnet 5 at Sonnet 4.6's rate.

## Findings Overview

| Severity | In Scope | Out of Scope |
| - | - | - |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 0 | 0 |
| 🟡 MEDIUM | 5 | 0 |
| 🟢 LOW | 1 | 0 |
| ℹ️ INFO | 1 | 0 |

## Findings and dispositions

| ID | Finding | Disposition |
| - | - | - |
| MEDIUM-001 | A symlink in `proof/`, or a `proof/` path through a fixture file, threw out of `validate`: exit 2 or a raw stack trace, and no other case reported | Fixed in `a1f2130`. The `proof/` tree is checked on the first copy, even with `proofs: false`. The checks: the root must not be a link; no path may run through a fixture file; no path may shadow a fixture file; and the overlay must succeed. Any failure is an error for that case alone, and its proofs are skipped. The proof run catches an overlay failure too. Tested for a link inside `proof/`, a `proof/` root that is a link, and `proof/a.txt/x`, with and without proofs; all three mutants are killed |
| MEDIUM-002 | Ctrl-C or SIGTERM orphaned a running proof's process group and left its copy | Fixed in `a1f2130`. `validate` joins the CLI's signal gate. The signal reaches the command grader, which kills the proof's group. `validate` stops before the next case or proof, removes its copies, and exits 130 or 143 with nothing reported. Tested in-process (abort) and through the CLI (SIGTERM, exit 143). A marker the proof would write after 2 s never appears. The mutants of the gate, the grader signal, and the per-case stop are killed |
| MEDIUM-003 | The subject-root check failed a model case whose system-prompt file sits above the suites | Fixed in `a1f2130`: it applies to harness cases only. Tested; the mutant is killed |
| MEDIUM-004 | The scope proof failed on the feature assertion first, so the escalation assertions never ran | Fixed in `a1f2130`. The escalation assertions come first, and every assertion uses `t.Error`. A third escalation check (`repo` must not satisfy `repository`) now catches a fix without the `:` guard. Verified by hand: the proof fails before the fix with both escalations reported, passes after it, and fails on the weaker fix |
| MEDIUM-005 | `claude-sonnet-5` was priced at $3/$15 per million tokens, Sonnet 4.6's rate | Fixed in `a1f2130`: $2/$10, as the Claude API reference gives. A comment says to check the live price before recording a run's cost |
| LOW-001 | A plugin holding a suite root was reported twice | Fixed in `a1f2130`. The harness pre-run check reports it; `validate`'s own loop covers only the subject root. The test asserts exactly one error |
| INFO-001 | The `fix/` and `proof/` containment checks were lexical | Adopted in `a1f2130`. A fix must resolve inside the case with links followed, and a `proof/` root that is a link is refused. Both are tested |

At `a1f2130`:

- `npm run check` exits 0.
- `npm test` passes 524 of 528, with 4 (live) skipped.
- `node src/cli/main.ts validate` reports 11 cases, 0 invalid and 1 (intended) warning, and exits 0.
- actionlint exits 0.

## Review Round 2

| | |
| - | - |
| **Review Round** | 2 |
| **Reviewed SHA** | `cd3e53e` |
| **Reviewer** | PE-Vue |

PE-Vue marked 5 of the 7 round-1 findings RESOLVED:

- MEDIUM-002: both cancel mutants are killed.
- MEDIUM-003.
- MEDIUM-004: checked by hand before the fix, after the fix, and on the weaker fix.
- MEDIUM-005.
- LOW-001.

It marked MEDIUM-001 and INFO-001 PARTIAL; their gaps are the new MEDIUM-001 and LOW-001 below.

| ID | Finding | Disposition |
| - | - | - |
| MEDIUM-001 | A `proof` that is a regular file still threw ENOTDIR out of `validate` | Fixed in `97cabf4`. The `proof/` root is lstat'ed: a link or a non-directory is an error for its case alone. Tested; the mutant is killed |
| MEDIUM-002 | Round 1 laid `proof/` over the first copy before the harness pre-run check. A harness case whose proof adds `.mcp.json` or `.claude/settings.json` failed, blamed on the fixture | Fixed in `97cabf4`. The pre-run check scans the post-change tree first, and only then is `proof/` laid over it. Tested: such a proof is valid, and the same file in the fixture is still refused. The old order, as a mutant, fails the test |
| LOW-001 | A dangling `proof` link was skipped without a word | Fixed in `97cabf4`. Presence is checked with `lstat`, so a dangling link reaches the link refusal. Tested; the mutant is killed |
| LOW-002 | ARCHITECTURE said `run` makes every check `validate` makes | Fixed in `97cabf4`: the `proof/` and `fix` checks are named as `validate`'s own |
| INFO-001 | A top-level `proof/.git` read as a shadowed file | Adopted in `97cabf4`. The walk skips `.git`, and the overlay refuses it by name. Tested; the mutant is killed |
| INFO-002 | A duplicate comment line in a test | Removed in `97cabf4` |

At `97cabf4`:

- `npm run check` exits 0.
- `npm test` passes 525 of 529, with 4 (live) skipped.
- `validate` over the examples reports 11 cases, 0 invalid, 1 warning, and exits 0.

## Review Round 3

| | |
| - | - |
| **Review Round** | 3 |
| **Reviewed SHA** | `7ada74d` |
| **Reviewer** | PE-Vue |

PE-Vue marked MEDIUM-001, MEDIUM-002, LOW-001, INFO-001 and INFO-002 RESOLVED and verified every disposition claim. It re-ran all four mutants in an archived copy, and each was killed. LOW-002 was PARTIAL.

At the reviewed SHA:

- `npm run check` exits 0.
- `npm test` passes 525 of 529, with 4 (live) skipped.
- `validate` exits 0.

**✅ APPROVED:** no finding at MEDIUM or above. The one new LOW was fixed after approval:

| ID | Finding | Disposition |
| - | - | - |
| LOW-001 | ARCHITECTURE still said `run` makes every check except the `proof/` and `fix` ones. The subject-root check and both warnings are `validate`'s alone, and the list lacked the non-directory and `.git` cases | Fixed. The sentence names every check that is `validate`'s alone, and the `proof/` bullet covers a non-directory and a `.git` entry. Documentation only |

## Gate 2 (PR #14)

Copilot is out of quota, so a fresh PE-Vue with no Gate 1 context stood in for it.

| Round | Reviewed SHA | Found | Outcome |
| - | - | - | - |
| 1 | `98064a9` | 2 MEDIUM, 2 LOW, 2 INFO | Fixed, as below |

PE-Vue checked the ground truth independently:
- Each truth range matches the post-change file.
- In a proof × fix matrix, each Go proof fails before its own fix, passes after it, and still fails under the other bug's fix.
- A 300k-string fuzz finds the "clean" slug change really clean.
- SIGINT during a proof exits 130 and kills the proof's group.

| ID | Finding | Disposition |
| - | - | - |
| MEDIUM-001 | `validate` never checked a bug's or decoy's `file` and `lines` against the post-change tree, so a typo'd ground truth passed `validate` and then failed every run | Fixed. On the first copy, each bug's and decoy's file must be a regular file inside the copy, and its lines must end within the file. Tested: a missing file, a directory, a path escaping the copy, lines past the end for a bug and for a decoy, and a file the change adds. Four mutants (no check, no line bound, no containment, no decoys) are killed |
| MEDIUM-002 | A fix patch could edit the proof instead of the bug and still pass | Fixed. The proof files are snapshotted as laid over the copy, and after the fix a changed body, mode or kind is an error. Tested: a fix that rewrites the proof, one that changes only its mode, and one that fixes the bug and edits the proof too. Both mutants (no guard, no mode check) are killed |
| LOW-001 | An unreadable `proof/` subdirectory threw out of `validate` (exit 3) | Fixed: the walk's error is an error for that case alone. Tested with a mode-000 directory; the unguarded walk, as a mutant, fails |
| LOW-002 | ARCHITECTURE: `run` makes its checks "when it loads a suite"; `proof/` is compared to "the fixture"; the exit codes for an unloadable suite and for cancellation were missing | Fixed: "at load or before each trial"; "the post-change tree"; `validate` exits 1 when a suite will not load, and 130 or 143 on cancel. The new checks are listed |
| INFO-001 | CI's Go came from the fixture's `go 1.22` (EOL 1.22.12), and proofs dropped `GOTOOLCHAIN` | Adopted: CI pins Go `1.26`, and `GOTOOLCHAIN` is in the env allowlist, so setup-go's `local` reaches the proofs. Tested in the allowlist test |
| INFO-002 | `setup-go` is pinned by tag, as every action here is | No change: it matches the workflow's convention |

## Merge Eligibility (latest)

**Locked to SHA:** `7ada74d`. The PR opens once M5 through M9 merge. It carries one post-approval commit, a documentation-only LOW fix, and Gate 2 reviews it.

PLAN M10 stays unticked until CI runs `validate` on the PR and a live run with a key is recorded.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
