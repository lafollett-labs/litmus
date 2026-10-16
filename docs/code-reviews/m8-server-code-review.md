# Code Review: m8-server

**Verdict:** ✅ APPROVED (round 2, locked to `bd93180`, since rebased onto M7's approved tip)

| | |
| - | - |
| **Branch** | `m8-server` (Gate 1, local, before any PR; stacked on M7) |
| **Reviewer** | @Cali LaFollett (PE-Vue) |
| **Review Round** | 1 |
| **Reviewed SHA** | `dda38cc` (before the rebase onto M7's round-1 fixes; the same work is now at `9670171`) |
| **Title** | M8: server |
| **Date** | 2026-09-30 |

---

## Summary

PE-Vue attacked the server as a hostile page and as DNS rebinding. The Host and Origin checks held against:

- absolute-form targets and HTTP/1.0 with no Host
- a case change, a trailing dot, and `[::1]`
- duplicate headers, `null`, https, and a foreign port

No GET changes state, and no response carries a CORS header. Traversal is refused, and `../trial.json` as an artifact reads as missing. A live stream and a replay of the same run match event for event. A disconnected client leaves the subscriber set, and a 500 leaks nothing.

The findings:

- `close()` could hang on a half-read connection, so `litmus serve` exited 13.
- The server's one redaction test could not fail.
- A linked directory led out of containment.
- Oversize files read as missing.
- A stream that never ended would hang the suite rather than fail it.

At the reviewed SHA, `npm run check` is clean, and 475 tests pass with 4 (live) skipped.

## Findings Overview

| Severity | In Scope | Out of Scope |
| - | - | - |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 0 | 0 |
| 🟡 MEDIUM | 2 | 0 |
| 🟢 LOW | 8 | 0 |
| ℹ️ INFO | 4 | 0 |

## Findings and dispositions

| ID | Finding | Disposition |
| - | - | - |
| MEDIUM-001 | `close()` awaited `server.close` before dropping connections, so a half-read request hung it, and `litmus serve` exited 13 | Fixed in `64a0aef`. `close()` starts `server.close`, drops every connection, then awaits the runs and the close. A 413 now closes its connection. Tested with a client that sends half a promised body and stalls; the old order fails it by timeout |
| MEDIUM-002 | The redaction test on `/api/configs` could not fail | Fixed in `90860d7`. The fixture's `fake-b` model holds the redacted token, and the test asserts `m-[REDACTED]`. With redaction removed, the test fails |
| LOW-001 | A linked directory under `ui/` or `artifacts/` was followed out of containment | Fixed in `64a0aef`. Every file the server reads must resolve (links followed) inside its directory's real path, and is then read without following a final link. Tested with `artifacts/sub` linked outside. The docs sentence is corrected |
| LOW-002 | An artifact over 8 MiB read as missing, and an oversize transcript as empty | Fixed in `64a0aef`. An oversize artifact is `{ size, truncated: true }`, and an oversize transcript sets `transcript_truncated`. Tested with 9 MiB |
| LOW-003 | The `planRun` refactor dropped flag names from CLI errors | Fixed in the rebase (`f529f87`). The CLI checks its flag rules itself with flag wording, and `planRun` takes the caller's wording for the configs field (`--config a,b` or `configs`) |
| LOW-004 | `planRun` ignored `serve()`'s env | Fixed in `f529f87`: `planRun` takes `env`, and the server passes its own |
| LOW-005 | A stream that never ended hung the suite; the serve CLI test had no timeout or cleanup | Fixed in `90860d7`. Every test request has a 10 s timeout, and the serve test fails if serve exits early or never listens, and kills the child in `t.after`. This turned a real bug introduced mid-fix into a fast failure: a "client left" check that read `req.destroyed`, which is true after any body is read. It now reads the socket |
| LOW-006 | No test pinned the subscriber cleanup or artifact containment | Fixed in `90860d7`. A test drops a live client and watches `stats().subscribers` return to 0; a new `stats()` exposes live runs and subscribers. The containment test covers `../trial.json` and a linked directory. Both mutants are killed |
| LOW-007 | A 100 ms sleep decided which cancel path ran | Fixed in `90860d7`. The test waits for the first SSE chunk and asserts one subscriber before it cancels |
| LOW-008 | A finished stream closed plainly, so an EventSource reconnected forever | Fixed in `64a0aef`. A run that is over with nothing left to send answers 204, which stops EventSource, including for a run whose record lacks a last event. Tested |
| INFO-001 | Last-Event-ID parsing was loose | Adopted in `64a0aef`: only a plain number counts. Tested with `''`, `' '`, `0x2`, `1e1` and `-1` |
| INFO-002 | New runs could start while `close()` waited | Adopted in `64a0aef`: a POST during shutdown is a 503 |
| INFO-003 | 400 bodies include absolute paths | Kept. Only a same-origin page can read them, and the operator owns those paths |
| INFO-004 | The server imported from the CLI layer | Adopted in `64a0aef`: `address.ts` moves to `src/runner/` |

At `1181dc8`, `npm run check` is clean, and 488 tests pass with 4 (live) skipped.

## Review Round 2

| | |
| - | - |
| **Review Round** | 2 |
| **Reviewed SHA** | `bd93180` (round-1 fixes on M7 at `813dd2b`) |
| **Reviewer** | PE-Vue |

PE-Vue marked all 14 round-1 findings RESOLVED:

- 13 mutants were killed.
- A live stream and a replay of the same run matched event for event.
- `close()` returned in 17 ms with a live subscriber.
- No stack or path leaked in a 500.
- 19 CLI flag cases behaved identically before and after the `planRun` refactor.
- `server.test.ts` failed 0 of 12 times under load.

**✅ APPROVED:** no finding at MEDIUM or above. The branch was then rebased onto M7's approved tip. The findings were fixed after approval, in `5d346b5`, `22e9b8e` and `85fbb24`:

| ID | Finding | Disposition |
| - | - | - |
| LOW-001 | The "client left" check read a pipelined response's missing socket as a departed client, so the queued request's error was never answered | Fixed. The check reads the request's socket. Tested over a raw socket: a 404 queued behind a live stream arrives when the stream ends, and the old check, as a mutant, fails the test. Fixing this surfaced a worse bug: leaving a `for await` over the request early destroyed the socket, so an oversize body never got its 413. `body()` now reads with listeners and stops consuming past the limit. A test asserts the 413 and `connection: close` |
| LOW-002 | The 204 also ends the stream of a run live in another process, which the docs did not say | Kept, and the docs now say so: a client following a run started elsewhere reads its status from `/api/runs/:id` |
| LOW-003 | Four behaviours had no test, and the drop test could hang | Tested: the 413 closes its connection; a transcript over 64 MiB is empty with `transcript_truncated`; the server's env reaches `planRun` (a credential in another config's params is refused only through the server's env, and the no-env mutant fails the test); the drop test has a timeout and fails if the stream ends empty. The 503 is covered under INFO-001 |
| INFO-001 | The shutdown 503 cannot be reached | Kept as a commented defensive guard; the docs no longer promise it |
| INFO-002 | `close()` cuts live subscribers off before their run's last event, while the record on disk stays complete | Accepted, as the reviewer suggested |
| INFO-003 | A directory swapped between realpath and open is followed | Accepted: that needs a writer racing inside `results/` or `ui/dist`, which the single-operator model rules out |
| INFO-004 | index.html was read on every static request | Fixed: it is read only when the asked file is missing |
| INFO-005 | M7 moved during the review | The branch is rebased onto M7's approved tip. The CLI rules re-run through the rebased suite |

At `85fbb24`, `npm run check` exits 0 and 495 tests pass with 4 (live) skipped.

### Found after approval

| ID | Finding | Disposition |
| - | - | - |
| SELF-001 | The 413 test failed about one full run in five with `write EPIPE`. Its client was still writing the 1.1 MB body when the server answered 413 and closed, so the write raced the close; a reset can also drop the 413 itself | Fixed. The test now writes the headers and one byte past the limit over a raw socket, then stops, so nothing is unread when the server closes. It reads the 413 and `connection: close` before the server's FIN. 30 of 30 isolated runs pass, and a server that keeps the connection open fails it. The server is unchanged: a client that keeps writing a body over 1 MiB can still see a reset instead of the 413, which is the usual cost of closing on an oversized request |

## Gate 2 (PR #11)

Copilot is out of quota, so a fresh PE-Vue with no Gate 1 context stood in for it.

| Round | Reviewed SHA | Found | Outcome |
| - | - | - | - |
| 1 | `01a936a` | 2 MEDIUM, 2 LOW, 2 INFO | Fixed, as below |

| ID | Finding | Disposition |
| - | - | - |
| MEDIUM-001 | Error bodies, and the server's stderr lines, were not redacted. A YAML error quotes the line it failed on, so a config typo on a line holding a key reached the UI | Fixed. One `scrub` (the config's redact list when it loads, and the credential variables always) covers every error body, the 500 stack on stderr, and a failed run's stderr line. Tested with a key quoted by a YAML error; the mutant is killed |
| MEDIUM-002 | Artifacts had no total limit: a trial with many large artifacts built a string past V8's limit (a 500 at about 1 GB RSS) and could never be viewed | Fixed. One response inlines at most 32 MiB of artifact text; past that, each artifact comes back as its size with `truncated`. Documented. Tested with five 8 MiB artifacts: four inline, the fifth truncated. Both mutants are killed |
| LOW-001 | Live `Last-Event-ID` and shutdown had no tests: four mutants survived | Tested: a reconnect during a live run gets only what it missed, and `close()` cancels a live run and waits for its record, even when an executor takes 300 ms to honour the cancel. All three mutants are killed |
| LOW-002 | The docs said any missing run is a 404, but one named in a query or body is a 400 | Fixed in the docs: a run named in the path is a 404, and one named in a query or body is a 400, as the CLI's exit 2 |
| INFO-001 | The CSP and SPA fallback will meet Vite's `data:` inlining, stale hashed assets and unlisted MIME types | Carried to M9, which builds the UI |
| INFO-002 | Synchronous reads of every run share the event loop with live runs | Accepted at today's scale |

## Merge Eligibility (latest)

**Locked to SHA:** `bd93180`, which is now carried by the rebase onto M7's approved tip. The PR opens once M5, M6 and M7 merge. It carries the post-approval commits (LOW and INFO fixes only), and Gate 2 reviews them.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
