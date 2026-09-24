# Code Review: m0-foundation

**Verdict:** ✅ APPROVED (round 1). Round 2 re-reviews the LOW fixes.

| | |
| - | - |
| **Branch** | `m0-foundation` (Gate 1, local, before any PR) |
| **Reviewer** | @Cali LaFollett (PE-Vue + PE-AWS-Infra) |
| **Review Round** | 1 |
| **Reviewed SHA** | `61b118f` |
| **Title** | M0: TypeScript 7 toolchain, core ids/hash/errors, CI |
| **Date** | 2026-09-24 |

---

## Summary

Both reviewers approved with no CRITICAL, HIGH or MEDIUM findings. PE-Vue checked:

- `npm ci` finished with 0 vulnerabilities.
- The type check covers all 6 source files and fails on a deliberately wrong type.
- The test glob recurses into nested directories.
- The lockfile resolves from the npm registry with integrity hashes.
- The tsconfig matches Riff's.

PE-AWS-Infra ran actionlint and checked the workflow is safe for fork PRs (`pull_request`, `contents: read`, no secrets). Both reviewers found the same zero-tests hole, which is merged below. The LOW findings were cheap enough to fix before the PR.

## Findings Overview

| Severity | In Scope | Out of Scope |
| - | - | - |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 0 | 0 |
| 🟡 MEDIUM | 0 | 0 |
| 🟢 LOW | 7 | 0 |
| ℹ️ INFO | 5 | 1 |

## Findings and dispositions

| ID | Finding | Disposition |
| - | - | - |
| V-LOW-001 | `hashJson` collapsed a Date, Map, NaN or class instance, and dropped a `__proto__` key | Fixed in `0a44306`: these values are refused with a TypeError, `__proto__` is kept as a key, and there are tests for each |
| V-LOW-002, I-LOW-005 | `npm test` passes when zero test files match | Fixed in `c0f98e5`: `scripts/test.ts` counts the files first. Verified: with `test/` moved away it prints "no test files match" and exits 1 |
| V-LOW-003 | The trial-key grammar is a copy of NAME, and the run-id grammar exists only in a test | Fixed in `c9ded44`: the grammar is built from `NAME.source`, and `RUN_ID` is exported for the tests to import |
| I-LOW-001 | `checkout@v4` and `setup-node@v4` run on Node 20, which the runners dropped on 2026-09-23 | Fixed in `1d3b8ba`: moved to v7.0.1 and v7.0.0 |
| I-LOW-002 | `cancel-in-progress` also cancelled CI on `main` | Fixed in `1d3b8ba`: cancelling now happens only for `pull_request` |
| I-LOW-003 | The job had no timeout | Fixed in `1d3b8ba`: `timeout-minutes: 10` |
| I-LOW-004 | CI repeated the Node version from `.nvmrc` | Fixed in `1d3b8ba`: CI now reads `node-version-file: .nvmrc` |
| V-INFO-001 | A `.ts` bin can't type-strip inside `node_modules` | M1 adds the shebang, and M11 documents `npm link` |
| V-INFO-002 | Two runs started in the same second sort randomly and can collide | M6: the store creates run directories without `recursive` and retries on EEXIST |
| V-INFO-003 | The comment in `errors.ts` said every infra error is retried | Fixed in `c9ded44` |
| I-INFO-001 | The ruleset depends on the `check` job's id | Fixed in `1d3b8ba`: a comment above `check:` says so |
| I-INFO-002 | `persist-credentials` defaults to true | Fixed in `1d3b8ba`: set to false |
| I-INFO-003 (out of scope) | Fork-PR approval was `first_time_contributors` | Changed to `all_external_contributors` in repo settings |

## Merge Eligibility

**Locked to SHA:** `61b118f`. The fix commits after it are re-reviewed in round 2.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
