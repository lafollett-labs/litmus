# Code Review: m8-server

**Verdict:** 🔄 CHANGES REQUESTED (round 1)

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

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
