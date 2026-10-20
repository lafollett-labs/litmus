# Code Review: fix-store-parent-scope

**Verdict:** ✅ APPROVED (round 1, at `41cb540`). Its two LOWs are fixed in the commit after it.

| | |
| - | - |
| **Branch** | `fix/store-parent-scope` (Gate 1, local, before any PR) |
| **Reviewer** | PE-Vue (the Gate 2 reviewer of PR #18, whose LOWs this branch carries) |
| **Review Round** | 1 |
| **Reviewed SHA** | `41cb540` |
| **Title** | Refuse a plugin whose component directories overlap the run store |
| **Date** | 2026-10-19 |

---

## Summary

PR #18 (0.1.1) denied the store's directory and skipped it in the plugin scan. With `results` inside a component directory, Claude Code still loaded files that the scan had skipped. This branch:

- refuses any overlap, in either direction, between a component path and what the gate denies of the store;
- builds the keep roots once;
- documents the keep-root exception.

| Severity | In Scope | Out of Scope |
| - | - | - |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 0 | 0 |
| 🟡 MEDIUM | 0 | 0 |
| 🟢 LOW | 2 | 0 |
| ℹ️ INFO | 1 | 1 |

| ID | Finding | Disposition |
| - | - | - |
| LOW-G1-201 | Case-variant component dirs (`Agents/runs`, manifest `./X/skills`) still loaded unscanned on a case-insensitive volume. A real-binary probe listed the unscanned agent | Fixed. `storeClash` compares paths with `fold()`. Tests: the `Agents/runs` and `./X/skills` rows |
| LOW-G1-202 | `COMPONENT_DIRS` lacked `output-styles/`, `themes/` and `workflows/`, which the pinned binary loads by default | Fixed. The list now matches the binary's, less `hooks/` and `monitors/` (checked by name), with a note to re-check it on each SDK bump. Tests: one row each |
| INFO-G1-203 | Manifest `"skills": "./"` refuses the default `.litmus/runs` | Accepted as a fail-closed refusal. Documented in ARCHITECTURE |
| INFO-G1-204 | A plugin's `workflows/*.js` is not classified by the process scan | Out of scope; it predates this branch. Tracked with LOW-004 |

## Test evidence

| PE | Test budget | Evidence |
| - | - | - |
| PE-Vue | targeted | check exit 0; harness.test 44/44 with a probe; e2e 4/4; unit probes PROBE3 and a real-binary probe PROBE4 |

After the fixes:

- `npm run check` exit 0.
- `npm test` tests 611, pass 606, fail 0, skipped 5.
- `validate` reports 11 cases: 0 invalid, 1 warning.
- Mutants killed: 10 in round 1, plus 5 for the fixes (fold dropped on either side; `output-styles`, `themes` or `workflows` dropped).

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
