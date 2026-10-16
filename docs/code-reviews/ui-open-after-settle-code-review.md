# Code Review: ui-open-after-settle

**Verdict:** ✅ APPROVED (round 1, locked to `386e83e`)

| | |
| - | - |
| **Branch** | `ui-open-after-settle` (Gate 1, local, before any PR) |
| **Reviewer** | PE-Vue |
| **Review Round** | 1 |
| **Reviewed SHA** | `386e83e` (the same tree as `8fd79ca`, rebased onto `7a6f305`) |
| **Title** | Issue #13: a trial opened after its run ended is settled at once |
| **Date** | 2026-10-15 |

---

## Summary

The fix: when `openTrial` opens an unfinished trial after the event stream has ended, it settles the trial at once, as `settled()` settles one already open:

| Run ended as | The trial pane |
| - | - |
| lost | says contact was lost |
| live elsewhere | looks the trial up once; a 404 gets the neutral note |
| failed or cancelled | looks the trial up and shows its error |

PE-Vue's probes covered four timings: a trial opened while `settled()` still awaits the stored run, a run switched mid-fetch, the same trial reopened, and a finished trial on a lost run. Each did the right thing. The three mutants the author reported are killed, and so are three more. Three mutants survived because no test reached their paths; the findings below close all three.

| Severity | In Scope | Out of Scope |
| - | - | - |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 0 | 0 |
| 🟡 MEDIUM | 0 | 0 |
| 🟢 LOW | 3 | 0 |
| ℹ️ INFO | 0 | 1 |

**✅ APPROVED:** no finding at MEDIUM or above. The findings were fixed after approval, in tests only:

| ID | Finding | Disposition |
| - | - | - |
| LOW-001 | No test opened a trial while `settled()` awaits the stored run; capturing the detail before the await, as a mutant, brought #13 back | Tested: three tests hold the stored-run read open (live elsewhere with a record, with a 404, and server gone). That mutant fails 4 tests |
| LOW-002 | Finished trials on an ended run were untested; dropping `!finished` from either branch survived | Tested: a finished trial on a lost run, and one on a run live elsewhere whose record is missing. Both mutants are killed |
| LOW-003 | The `o4` stub left `state.comparisons` undefined for later tests | Fixed: it uses `stored('failed')` |
| INFO-001 | An existing test depended on state an earlier test set, and failed in half of random orders | Fixed: it sets its own suites and configs. The store tests pass under 15 random seeds |

The tests also cover a run switched mid-fetch, a trial reopened on a lost run and on a run live elsewhere, and a queued trial of a cancelled run.

## Gate 2 (PR #15)

Copilot is out of quota, so a fresh PE-Vue with no prior context stood in for it.

The branch was rebased onto `35488a6`, giving `13421e5` (the Gate 1 tree) and `9859d87` (the test follow-ups). `ui/src` is unchanged from the reviewed `386e83e`.

| Round | Reviewed SHA | Found | Outcome |
| - | - | - | - |
| 1 | `9859d87` | 1 LOW, 3 INFO | ✅ APPROVED |

PE-Vue's evidence:

- Its own 15 mutants were all killed.
- The store tests pass under 20 random seeds, and each test passes when run alone.
- In a real browser (Playwright against `litmus serve`), it checked three endings:
  - **Lost:** the pane and the live region both say so, and focus stays on the tree row.
  - **Live elsewhere:** the note is shown, and the record is shown once the CLI finishes.
  - **Cancelled:** a trial that ran shows its record.

| ID | Finding | Disposition |
| - | - | - |
| LOW-001 | A queued trial of a cancelled run shows the server's 404 as a red error, though it simply never ran | Carried into M11 (a neutral "not run" note), so the code merged here is the code approved |
| INFO-001 | The header icon falls back to "queued" for a running trial with no record | Carried into M11 |
| INFO-002 | Opening a second trial with the same message announces nothing | Accepted: focus stays on the row, and the pane's heading names the new trial |
| INFO-003 | The Gate 1 lock SHA is one rebase behind | Recorded above |

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
