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

## Review Round 2

**Verdict:** 🔁 CHANGES REQUESTED at `5e5f3d9`. All findings are fixed in `51b4daa`, which round 3 reviews.

| | |
| - | - |
| **Reviewer** | PE-Vue |
| **Reviewed SHA** | `5e5f3d9` |

| ID | Finding | Disposition |
| - | - | - |
| MEDIUM-003 | A wide finding that covered the decoy and reached a bug became a false positive, so it passed `max_decoy_hits: 0` | Fixed. A finding is a false positive for width only when it covers no decoy. Test: go-token-expiry's geometry is a decoy hit and FAILs its bounds |
| LOW-003 | A duplicate of a wide bug beside a narrower bug became a false positive | Fixed. A finding is too wide only when it is too wide for every bug it is near. Test: it is a duplicate |
| LOW-004 | The closer rejected deep indents and trailing text | Fixed. `CLOSER = /^[ \t]*```/gm`. Tests cover all three shapes |
| INFO-002 | A blind grid still fits under `max_findings` in small fixtures | Noted as the documented limit. A confirm judge closes it |
| INFO-003 | Round-1 continuity | All resolved |

Receipts at `51b4daa`:

- `npm run check` exit 0.
- `npm test` tests 605, pass 600, fail 0, skipped 5.
- `validate` reports 11 cases: 0 invalid, 1 warning.
- 5 mutants were killed. One, decoy *window* in place of decoy *overlap*, first survived and was killed by a new test.

## Review Round 3

**Verdict:** 🔁 CHANGES REQUESTED at `ed168eb`. All findings are fixed in `a566cfb`, which round 4 reviews.

| | |
| - | - |
| **Reviewer** | PE-Vue |
| **Reviewed SHA** | `ed168eb` |

| ID | Finding | Disposition |
| - | - | - |
| MEDIUM-004 | The decoy exception compared line numbers only, so a decoy in another file kept a too-wide finding out of `max_false_positives` | Fixed. `covers()` requires the same file. Test: an `x.go [1,60]` finding with the decoy in `y.go` is a false positive |
| LOW-005 | `gap() === 0` counts a range that only touches the decoy | Fixed. The check is real overlap. Test: a range ending the line before the decoy is a false positive |
| LOW-006 | `^` with the `m` flag starts a line after U+2028 or U+2029, which JSON allows raw in a string | Fixed. `CLOSER = /(?<![^\n])[ \t]*```/g`. Tests: both separators, and CRLF |
| INFO-004 | Round-2 continuity | All resolved |

Receipts at `a566cfb`:

- `npm run check` exit 0.
- `npm test` tests 605, pass 600, fail 0, skipped 5.
- `validate` reports 11 cases: 0 invalid, 1 warning.
- 4 of 4 new mutants were killed.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
