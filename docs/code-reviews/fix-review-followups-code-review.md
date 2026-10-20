# Code Review: fix-review-followups

**Verdict:** ✅ APPROVED. PE-Vue approved in round 2, at `1595a08`, and PE-Governance approved AGENTS.md in round 2, at `2b9cb0d`. The one finding PE-Vue still had open, LOW-001, is fixed in the commit after its round 2.

| | |
| - | - |
| **Branch** | `fix/review-followups` (Gate 1, local, before any PR) |
| **Reviewers** | PE-Vue (src, tests, docs), PE-Governance (AGENTS.md) |
| **Review Rounds** | 2 |
| **Date** | 2026-10-20 |

---

## Summary

This branch fixes the non-blocking findings that the Gate 2 reviews of #19, #20 and #21 carried forward:

- **Store refusals.** A component inside the directory holding the store is refused with a message that names that directory (#19 LOW-G2-301).
- **Validate agrees with run.** A store not made yet is judged at its deepest existing ancestor's realpath (#19 INFO-303).
- **Single-skill tip.** A single-skill plugin can leave `skills` out (#19 INFO-302).
- **Drift test.** The SDK-bump drift check is now a test against the pinned binary (#19 INFO-304).
- **Planted pass key.** A judge verdict that a planted `"pass"` key could override is no verdict (#20 LOW-002).
- **Unreported credential.** An init that names no credential source fails closed (#21 LOW-003).
- **Docs.** Extra usage and the `run` refusal sentence (#21 LOW-001 and LOW-002).

| Round | Reviewer | Verdict | Findings and dispositions |
| - | - | - | - |
| 1 | PE-Governance | 🔁 CHANGES REQUESTED | MEDIUM-001: the AGENTS.md rule gave no way to read the binary's list, no evidence, and no branch for a mismatch. Fixed by a test: `plugin-loader.test.ts` reads the loader's lists after its `"marketplace.json"),` anchor, holds `COMPONENT_DIRS` and `PROCESS_FILES` to them (INFO-001), and fails on an empty extraction. The rule now runs it |
| 2 | PE-Governance | ✅ APPROVED | No findings. The exact AGENTS.md command ran: tests 6, pass 6, fail 0, skipped 0 |
| 1 | PE-Vue | ✅ APPROVED | LOW-001: the quote rule blocked only a same-line plant. LOW-002: code spans holding ```` ``` ```` did not render. INFO-005: the hint for an unreported source pointed at managed settings. All fixed: a verdict naming `"pass"` twice is no verdict, the spans use longer delimiters, and the reason names an SDK change |
| 2 | PE-Vue | ✅ APPROVED | LOW-001 was partly fixed: `"\u0070ass"` and an inline ```` ```json ```` in the plant got past the count. Fixed: keys are counted decoded, from where `extractJson` starts. Four mutants were killed. INFO-006 (prose after the fence quoting `"pass":` grades FAIL) is accepted, because it fails closed and counting the tail is what catches the rationale-first plant |

## Test evidence

| PE | Test budget | Evidence |
| - | - | - |
| PE-Vue | targeted | typecheck exit 0; render 7/7, harness 47/47, plugin-loader 1/1; probes on store layouts and on 10 verdict shapes |
| PE-Governance | none | ran the AGENTS.md SDK-bump command: tests 6, pass 6, fail 0, skipped 0 |

After the last fix:

- `npm run check` exit 0.
- `npm test` tests 628, pass 623, fail 0, skipped 5.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
