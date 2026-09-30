# Code Review: m9-ui

**Verdict:** 🔄 CHANGES REQUESTED (round 1; round 2 pending on `edb3a3b`)

| | |
| - | - |
| **Branch** | `m9-ui` (Gate 1, local, before any PR; stacked on M8) |
| **Reviewer** | @Cali LaFollett (PE-Vue) |
| **Review Round** | 1 |
| **Reviewed SHA** | `5809d4a` (before the rebase onto M8's approved tip; the same work is now at `0bc4e2e`) |
| **Title** | M9: runner UI |
| **Date** | 2026-09-30 |

---

## Summary

PE-Vue drove the built UI against a live `litmus serve`. It probed with the keyboard, a stopped server, runs with a larger trial count, and hostile finding titles.

The security pass was clean:

- no `v-html`
- no CSP errors under `default-src 'self'`
- every key is encoded
- `npm audit` reports 0 findings

The findings:

- The tree could not be used from the keyboard.
- Run selected could build requests the server refuses, or run configs nobody checked.
- The Findings tab parsed review-match's prose, so it miscounted past 20. A newline in a title, which is the subject's own text, could forge a matched bug.
- The detail pane went stale.
- A lost server left the run "running" forever.
- No `.vue` file was typechecked.
- Contrast failed AA in places.
- The tabs were incomplete.

At the reviewed SHA, `npm run check` exits 0, 494 tests pass with 4 (live) skipped, and 8 Playwright tests pass.

## Findings Overview

| Severity | In Scope | Out of Scope |
| - | - | - |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 2 | 0 |
| 🟡 MEDIUM | 7 | 0 |
| 🟢 LOW | 5 | 0 |
| ℹ️ INFO | 3 | 0 |

## Findings and dispositions

| ID | Finding | Disposition |
| - | - | - |
| HIGH-001 | The tree could not be used from the keyboard: rows were not focusable, and there was no hierarchy, no expanded state under a filter, and no checked state | Fixed in `975c612`. The tree follows the WAI-ARIA tree pattern: <ul><li>a roving tabindex</li><li>Up and Down, Right and Left (open or go to the child; close or go to the parent), Home and End</li><li>Space checks a row and Enter opens it</li><li>`aria-level`, `aria-setsize`, `aria-posinset`, `aria-checked` on the row, and `aria-selected` on the open trial</li></ul>`aria-expanded` uses the same "open" the render uses. The mouse checkbox leaves the Tab order. The empty row has `role="none"`. A Playwright test drives the tree by keyboard alone, through to opening a trial; with Space removed, the test fails |
| HIGH-002 | `selection()` could build requests the server refuses, or ones that run cases and configs nobody checked | Fixed in `975c612` and `edb3a3b`: <ul><li>A config row names its trial keys, 1 to the case's own count.</li><li>A trial past that count cannot be checked.</li><li>Keys run on their own config.</li><li>When case or suite rows are checked too, every key's config must also be chosen in the toolbar. Otherwise the run is refused with the reason, rather than spreading a config.</li><li>A trial count given with keys says it applied only to case and suite rows.</li></ul>Model tests cover (a) spreading, (b) no config chosen and (c) the uncheckable trial. A Playwright test runs a config row after a 3-trial run and gets the case's own 2 trials. The mutants of the spread refusal, the `selectable` guard and the run-derived selector are each killed |
| MEDIUM-001 | The Findings tab parsed review-match's rationale. It showed at most 20 unmatched, and a title with a newline could forge a matched bug | Fixed in `975c612`. review-match returns structured, redacted `details` (matched, missed, and unmatched with `as` and `near`), and the tab renders only those. The test grades 30 false positives through the real grader: every outcome shows, each count equals its metric, and duplicates are rendered. A grader test shows that a title with a forged newline stays data and is redacted |
| MEDIUM-002 | A tab the next trial lacked left a blank panel | Fixed in `975c612`: the tab shown falls back to the transcript. Playwright covers it; the mutant is killed |
| MEDIUM-003 | The detail pane survived a run switch, and a trial opened while running showed a 404 forever | Fixed in `975c612`. `watchRun` closes the pane. A running trial shows "Running…" and is fetched when its `trial.finished` event arrives, guarded on run and key. Store tests cover both; the mutants are killed |
| MEDIUM-004 | With the server gone mid-run, the UI stayed "running" with no message, and the rejection went unhandled | Fixed in `975c612`. `settled()` catches the failure, marks the run `lost`, and says so in the banner, which brings the run buttons back. A store test covers it with a stubbed server that has gone |
| MEDIUM-005 | No `.vue` file was typechecked | Fixed in `74cb7d1`. vue-tsc needs TypeScript's JS API, which TypeScript 7 does not ship, so it runs from `tools/vue-tsc` on TypeScript 5.9 and is part of `npm run check`. CI installs it, and CONTRIBUTING says so. A template error fails it (probed) |
| MEDIUM-006 | Colour contrast failed AA | Fixed in `975c612` and `edb3a3b`. The light tokens are darker; every status, muted and accent colour holds 4.5:1 on bg, panel, hover and selected in both themes (computed for all 56 pairs). Dark Run all uses a dark `--on-accent`. Zero counts use the muted colour, not opacity |
| MEDIUM-007 | Both tablists were incomplete | Fixed in `975c612`. Both follow the tabs pattern: `tabpanel` with `aria-labelledby`, `aria-controls`, a roving tabindex, and Left, Right, Home and End with automatic activation (`ui/src/tabs.ts`). Playwright covers the trial tabs |
| LOW-001 | The rerun test waited 15 s on a `running` that could not be seen, and the tests depended on their order | Fixed in `975c612`. The test waits for the run id to change (0.6 s). The file is declared serial, so a failure skips the rest instead of failing them. The tabs test starts its own run |
| LOW-002 | Playwright SIGKILLed the web server, so temp dirs piled up | Fixed in `975c612`: `gracefulShutdown` sends SIGTERM |
| LOW-003 | An invalid trial count was silently ignored | Fixed in `975c612`: anything but a whole number above zero, or blank, starts nothing and says why. Store test; the mutant is killed |
| LOW-004 | Reduced motion only slowed the spinner | Fixed in `975c612`: `animation: none` |
| LOW-005 | Duplicates were parsed but not rendered, and compare cards were keyed by index | Fixed in `975c612`: a Duplicates section, and cards keyed by their sides |
| INFO-001 | A run live in another process showed as `failed` | Adopted in `975c612`: it shows as running elsewhere (the CLI), as far as it had got. Store test |
| INFO-002 | The tree is rebuilt per event, and transcripts are deep-reactive | Half adopted: trial data is `markRaw`. The per-event rebuild is kept until suite sizes make it matter |
| INFO-003 | The security pass was clean | None needed |

At `edb3a3b`:

- `npm run check` (tsc, `tsc -p ui` and vue-tsc) exits 0.
- `npm test` passes 508 of 512, with 4 (live) skipped and 0 failed.
- `npm run test:ui` passes 11 of 11.
- actionlint exits 0.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
