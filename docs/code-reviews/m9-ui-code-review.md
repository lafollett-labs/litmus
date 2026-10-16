# Code Review: m9-ui

**Verdict:** ✅ APPROVED (round 4, past the cap with the operator's go-ahead, locked to `1365909`)

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

## Review Round 2

| | |
| - | - |
| **Review Round** | 2 |
| **Reviewed SHA** | `9608ef0` |
| **Reviewer** | PE-Vue |

PE-Vue marked all 17 round-1 findings RESOLVED. Its evidence:

- The CDP accessibility tree shows level, checked, expanded and selected on each treeitem, and exactly one row is a tab stop.
- vue-tsc failed on two template errors it injected.
- All 64 token pairs hold 4.5:1.
- No temp directory was left after 3 Playwright runs.
- The security greps are clean.

It found 2 MEDIUM, 4 LOW and 2 INFO in the fixes.

| ID | Finding | Disposition |
| - | - | - |
| MEDIUM-001 | A treeitem's name read "counts for smoke": the badge's `aria-label`, prohibited on a span, replaced the counts | Fixed in `42ac781`. The counts are visually hidden text in the row's name (`1 pass, 1 fail, …`), and the glyphs are `aria-hidden`. Playwright asserts the accessible name. Hiding the text fails the test |
| MEDIUM-002 | A config row checked under a checked case or suite, on a config the toolbar has not chosen, silently did not run | Fixed in `42ac781`. The walk goes on under a checked case or suite, and such a row is refused with the reason. On a chosen config, the case row already covers it. Model tests; the mutant is killed |
| LOW-001 | A trial opened while running said "Running…" forever once the run was lost or elsewhere | Fixed in `42ac781`. When the run is elsewhere, its record is looked up once. When the server is lost, the pane says so. Store tests for both; both mutants are killed |
| LOW-002 | `aria-disabled` on a trial row that still opens, and `aria-checked` without `aria-multiselectable` | Fixed in `42ac781`. `aria-disabled` is gone and the tree is `aria-multiselectable`. The open trial is `aria-current`, since `aria-selected` would mean checked in a multi-select tree. The keyboard test asserts it |
| LOW-003 | `role="tabpanel"` on `<main>` removed the main landmark | Fixed in `42ac781`: `<main>` wraps the tab panel. Playwright asserts one main that holds the Runner panel |
| LOW-004 | Focus fell to the page when a toolbar button disabled itself | Fixed in `42ac781`. When the run starts or ends and focus sits on the page or on a disabled button, it moves to the run line (`tabindex="-1"`, a status). Playwright asserts it after Cancel; the mutant is killed |
| INFO-001 | Review trials graded before this change have no Findings tab | Accepted. The tab refuses to parse prose; the PR body says so |
| INFO-002 | `role="toolbar"` without its arrow keys | Fixed in `42ac781`: it is a `group` |

At `42ac781`:

- `npm run check` exits 0.
- `npm test` passes 509 of 513, with 4 (live) skipped.
- `npm run test:ui` passes 12 of 12.

## Review Round 3

| | |
| - | - |
| **Review Round** | 3 (the cap) |
| **Reviewed SHA** | `8e85302` |
| **Reviewer** | PE-Vue |

PE-Vue verified the round-2 dispositions. It used a Playwright aria snapshot, model probes, and store probes, and ran every probe in `git archive` copies. Its results:

- RESOLVED: MEDIUM-001, MEDIUM-002, LOW-002, LOW-003, INFO-001 and INFO-002.
- PARTIAL: LOW-001 and LOW-004. Each reappears in the table below.

`npm run check` exits 0. `npm test` passes 509 of 513, and `npm run test:ui` passes 12 of 12.

| ID | Finding | Disposition |
| - | - | - |
| MEDIUM-001 | The focus rescue's `body` branch also fired on page load. The run line took focus, and the first Tab skipped the toolbar | Fixed in `88845a7`. Focus already on the page moves only while the user's own action is in flight (`busy`, now or just before). A disabled focused button still hands focus to the run line. A Playwright test reloads with a stored run: the run line is not focused, and the first Tab reaches Run all. The old condition, as a mutant, fails the test |
| LOW-001 | A trial row checked under a checked case, past the toolbar's trial count, silently did not run | Fixed in `88845a7`. `selection()` takes the trial count and refuses such a row with the reason. Model tests cover counts 1 and 2; the mutant is killed |
| LOW-002 | A trial still running in another process showed the server's 404 as an error | Fixed in `88845a7`. When the lookup finds no record, the pane shows a neutral note that the trial is still running elsewhere. Store test with no trial route; the mutant is killed |
| INFO-001 | A trial finishing just before the stream ends can be fetched twice | Accepted: both are idempotent GETs, and the run-and-key guard holds |
| INFO-002 | A row that cannot be checked gave no reason to a screen reader | Adopted in `88845a7`: visually hidden text says it is past the case's own trial count |

At `88845a7`:

- `npm run check` exits 0.
- `npm test` passes 510 of 514, with 4 (live) skipped.
- `npm run test:ui` passes 13 of 13.

### Found after round 3 (unreviewed; in scope for round 4)

| ID | Finding | Disposition |
| - | - | - |
| SELF-001 | `npm ci && npm run check` in a fresh clone exited 127: `check:vue` needs `tools/vue-tsc`, which only a second, separate install provided. Found while running M11's done-criterion | Fixed in `e3d2d9a`. A root `postinstall` runs `npm ci --prefix tools/vue-tsc`, and CI and CONTRIBUTING drop the extra step. In a fresh clone of `m9-ui`, `npm ci` exits 0, `npm run check` exits 0, `npm test` passes 510 with 4 (live) skipped, and `npm run test:ui` passes 13 of 13 |

## Review Round 4

| | |
| - | - |
| **Review Round** | 4 (past the 3-round cap; the operator handed the call to the engineer on 2026-10-15) |
| **Reviewed SHA** | `1365909` |
| **Reviewer** | PE-Vue |

PE-Vue marked all round-3 findings and SELF-001 RESOLVED:

- With the round-2 focus condition put back, the page-load Playwright test fails. In a probe, focus stays in the filter when a run ends on its own, and Enter on Run all lands on the run line.
- Removing the trial-count check fails a model test, and dropping `absent` fails the store test.
- The unselectable row's accessible name carries its reason.
- A fresh clone runs `npm ci` (exit 0), `npm run check` (exit 0), `npm test` (510 of 514, 4 live skipped) and `npm run test:ui` (13 of 13).

**✅ APPROVED:** no finding at MEDIUM or above.

| ID | Finding | Disposition |
| - | - | - |
| LOW-001 | The "still running in another process" note also showed for a run that failed here, and it replaced any server error, such as a 500, while the run was elsewhere | Fixed after approval. The note is offered only while the stored run is still `running`, and only a 404 becomes the note; any other error is shown as it is. `api.call` puts the HTTP status on the error. Two store tests cover it, a failed run and a 500 while elsewhere, and each half of the fix, reverted as a mutant, fails one of them |
| LOW-002 | The root `postinstall` left `package-lock.json` stale, so `npm install` adds `"hasInstallScript": true` | Fixed after the rebase onto main, which changed the lockfile (#8): the lockfile is regenerated with the flag |
| LOW-003 | `npm audit` reports a high advisory in `source-map-js` 1.2.1, which vite and vue bring in at build time | Fixed after the rebase onto main: `npm audit fix` at the root and in `tools/vue-tsc` (lockfiles only) |
| INFO-001 | A high advisory on the base, in `@modelcontextprotocol/sdk` 1.30.1 | Already fixed on main: #8 bumped it to 1.32.1 |

### Found while preparing the PR

| ID | Finding | Disposition |
| - | - | - |
| SELF-002 | `npm run ui:dev` could not start a run. The dev proxy rewrote Host but passed the browser's Origin through, and the server takes a POST only from its own origin, so every POST was a 403. Probed: "Origin must be this server" | Fixed in `vite.config.ts`. A request whose Origin is the dev server's own page has it rewritten to the server's, and any other Origin passes through and is refused. Probed both ways: the dev page starts a run, and a foreign Origin is still a 403 |
| M8 Gate 2 INFO-001 | The server's CSP blocks `data:` URLs, which Vite uses to inline small assets | The built UI has none today. Adopted anyway: `assetsInlineLimit: 0` |

## Gate 2 (PR #12)

Copilot is out of quota, so a fresh PE-Vue with no Gate 1 context stood in for it.

| Round | Reviewed SHA | Found | Outcome |
| - | - | - | - |
| 1 | `40eb128` | 1 HIGH, 3 MEDIUM, 4 LOW, 2 INFO | Fixed, as below |
| 2 | `f9d9314` | 1 MEDIUM, 2 LOW, 2 INFO | All 10 round-1 findings RESOLVED. The LOW-003 fix opened a MEDIUM, fixed below |

| ID | Finding | Disposition |
| - | - | - |
| HIGH-001 | A stream refused outright (a 204, or any error status) left the run "running" forever, and a reload did not clear it. A real EventSource is CLOSED before that error fires, and `follow()` returned early on CLOSED | Fixed. `follow()` tracks its own end and never reads `readyState`. A store test whose fake is CLOSED before its error, as a 204 is, settles the run; the old guard, as a mutant, fails it |
| MEDIUM-001 | Through the dev proxy, Vite's default CORS let any localhost page read `/api` (run history, transcripts) | Fixed: `server.cors` and `preview.cors` are false, as the server sends no CORS. Tested; the mutant is killed |
| MEDIUM-002 | Trial status was shown by colour alone (WCAG 1.4.1): pass and fail are 1.03:1 apart in luminance | Fixed. The shape carries the status: pass a circle, fail a square, flaky a diamond, error a triangle. ARCHITECTURE § UI says so, and the screenshots show it |
| MEDIUM-003 | Status and error messages were not reliably announced (WCAG 4.1.3): live regions were inserted with their text | Fixed. The app and the trial pane each keep an always-present `role="status"` region whose text changes; a compare problem is `role="alert"`. An e2e test asserts the app's region is there and empty before a refusal and holds it after. Rendering it with its text, as a mutant, fails the test |
| LOW-001 | Nothing pinned the security properties: the proxy's Origin rewrite, or `v-html` on subject text | Tested. The review fixture's title holds `<img src=x onerror=…>`, and the e2e test asserts it shows as text, makes no `img`, and runs nothing; a `v-html` mutant fails it. A unit test drives the proxy's handler: the dev page's own Origin is rewritten, and any other passes through |
| LOW-002 | Status icons doubled accessible names ("pass pass") | Fixed: `decorative` icons are `aria-hidden` where text beside them says the status |
| LOW-003 | Uncapped review details could push `trial.json` past the server's 8 MiB read | Fixed. Files and titles are clipped at 500 characters, and `unmatched` lists the first 500 with `omitted` counting the rest. The Findings tab takes its counts from the metrics and says how many it does not list. Tested; both mutants are killed |
| LOW-004 | The ruleset did not require the `ui` job | Done: the repository's `main` ruleset requires `check` and `ui` |
| INFO-001 | Under `vite --host`, a LAN peer's request passed the Origin rewrite | Adopted: only a loopback host's own page is rewritten. Tested |
| INFO-002 | The `ui` job's npm cache key omitted `tools/vue-tsc`'s lockfile | Adopted |

Round 2:

| ID | Finding | Disposition |
| - | - | - |
| MEDIUM-001 | The new clip ran before redaction, so a secret straddling the 500-character cut left its prefix in `details` (probed: 29 of 49 characters) | Fixed: a file or title is redacted first, then clipped, in the details and the rationale alike. Tested with a secret across the cut and a 3,500-character title; both mutants (clip before redaction, an unclipped rationale) are killed |
| LOW-001 | In forced colours (High Contrast) the four filled shapes vanished, since their fill is a background | Fixed: `forced-color-adjust: none` keeps their fill. An e2e test under forced colours asserts the fills differ from the canvas; without the rule, it fails |
| LOW-002 | ARCHITECTURE said the bound keeps `trial.json` readable, but the rationale still quoted full titles | Fixed in the code, as MEDIUM-001 describes, and the docs say so |
| INFO-001 | The same refusal twice is not announced again | Accepted: the banner does not change for a sighted user either |
| INFO-002 | A lost server updates three status regions at once | Accepted: each says something true about its own part of the page |

## Merge Eligibility (latest)

**Locked to SHA:** `1365909`. The PR opens once M8 merges and this branch is rebased onto main. It carries the post-approval LOW fixes, and Gate 2 reviews them.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
