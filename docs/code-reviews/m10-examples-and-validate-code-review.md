# Code Review: m10-examples-and-validate

**Verdict:** 🔄 CHANGES REQUESTED (round 1; round 2 pending on `a1f2130`)

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

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
