# Code Review: fix-grading-false-passes

**Verdict:** 🚫 BLOCKED (round 1, at `05b72b0`). The fixes are in `d9b1a64` and `0ea2f2e`, which round 2 reviews.

| | |
| - | - |
| **Branch** | `fix/grading-false-passes` (Gate 1, local, before any PR) |
| **Reviewer** | PE-Vue |
| **Review Round** | 1 |
| **Reviewed SHA** | `05b72b0` |
| **Title** | review-match false passes, and fenced JSON that quotes code |
| **Date** | 2026-10-19 |

---

## Summary

The whole-system sweep of v0.1.0 reproduced these on the fake provider:

- **Whole-file finding.** A finding with range `1–9999` matched every bug in its file at recall 1.0, and the decoy next to them was never counted.
- **`min_claims_correct` alone.** A seeded case bounded only by it passed an empty review.
- **Clean-case bounds.** `max_nits` and `max_duplicates` were accepted, though neither can fail on a clean case.
- **Fenced JSON.** A ```` ``` ```` inside a JSON string cut the fence short, so correct answers were graded FAIL.
- **Example prompts.** They called the post-change tree "before the change".

Round 1 fixed each of them. PE-Vue agreed with declining the sweep's MEDIUM-005, which asked for extractor and judge failures to be ERROR: an ERROR is unscored, so a subject could use one to dodge a FAIL.

| Severity | In Scope | Out of Scope |
| - | - | - |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 2 | 0 |
| 🟡 MEDIUM | 2 | 0 |
| 🟢 LOW | 2 | 0 |
| ℹ️ INFO | 1 | 0 |

| ID | Finding | Disposition |
| - | - | - |
| HIGH-001 | Falling back to an earlier fence turned a judge's broken "no" into the `pass: true` example copied from its prompt | Fixed. Only the last ```` ```json ```` opener is read, with no fallback to an earlier one. Test: an echoed example followed by a broken verdict gives `pass: false` |
| HIGH-002 | The closer scan was quadratic: 64k characters of repeated openers took 96 s | Fixed. The fence closes at a ```` ``` ```` that starts a line (CommonMark), since JSON cannot hold a raw newline in a string. A closer right after the JSON's last `}` also counts. Linear time: a test parses 8k openers, and a 60k-character string of backticks, in under 500 ms |
| MEDIUM-001 | A grid of narrow info findings, one window apart, finds every bug blind: nits are neither matches nor false positives | A known limit of window matching, now documented in ARCHITECTURE § review-match. `validate` warns when a seeded review-match sets no `max_findings`, and the example seeded cases set one |
| MEDIUM-002 | The width rule turned an honest range citation into a decoy hit | Fixed. A finding over a bug but too wide to point at it is a false positive, never a decoy hit. The example prompts now ask for the narrowest range |
| LOW-001 | The decoy-proximity warning compared raw truth paths | Fixed with `normPath`. Test: a decoy spelt `./a.txt` |
| LOW-002 | A test comment said the opposite of its assertion | Fixed |
| INFO-001 | Agreed with keeping extractor and judge failures as FAIL | No change |

## Test evidence

| PE | Test budget | Evidence |
| - | - | - |
| PE-Vue | targeted | typecheck exit 0; 36/36 render and review-match tests; 56/56 examples, load and validate tests; timing and verdict probes |

After the fixes, at `0ea2f2e`:

- `npm run check` exit 0.
- `npm test` tests 603, pass 598, fail 0, skipped 5.
- `validate` reports 11 cases: 0 invalid, 1 warning.
- 6 new mutants were killed. The two that first survived, the line-closer path and the normPath compare, were killed by the tests added in `0ea2f2e`.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
