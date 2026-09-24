# Code Review: m0-foundation

**Verdict:** ✅ APPROVED (round 2, locked to `fdf7cc5`)

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

## Review Round 2

**Verdict:** ✅ APPROVED

| | |
| - | - |
| **Reviewer** | @Cali LaFollett (PE-Vue + PE-AWS-Infra) |
| **Reviewed SHA** | `fdf7cc5`, the range `61b118f..fdf7cc5` |
| **Date** | 2026-09-24 |

### Summary

Both reviewers approved. PE-Vue verified V-LOW-001..003 and V-INFO-003 with runtime probes:

- Each mangling type is refused.
- A `__proto__` key survives.
- `scripts/test.ts` exits 1 with no test files and passes arguments through.
- The rebuilt trial-key regex is byte-identical to the old one.

PE-AWS-Infra verified I-LOW-001..005 and I-INFO-001..003:

- The v7 actions are on node24.
- `.nvmrc` resolves to Node 26 under setup-node v7.
- The fork-PR approval setting is `all_external_contributors`.

Both ran the full checks: `npm ci` found 0 vulnerabilities, typecheck and actionlint are clean, and 12 of 12 tests pass.

### Awareness, carried into M1 rather than invalidating this round

| ID | Finding | Where it lands |
| - | - | - |
| I2-LOW-001 | A *queued* push run on `main` can still be cancelled by a later one, so the comment overstates it | M1: move `main` push runs into their own concurrency group (`github.sha`) and correct the comment |
| I2-INFO-001 | The ruleset does not require `check` yet | After merge: add `required_status_checks` for `check` with integration 15368 |
| I2-INFO-002 | `.code-reviewer.yml` routes nothing under `scripts/**` | M1: add `scripts/**` to the TypeScript route |

## Merge Eligibility (latest)

**Locked to SHA:** `fdf7cc5`. The PR opens at this SHA, rebased onto `main` once PR #1 merges.

## Gate 2: PR #2 (Copilot)

After the rebase the PR opened at `45313d0`. From then on, review happened on the PR and no local round was run. Copilot reviewed four times:

| Round | Reviewed SHA | Threads | Outcome |
| - | - | - | - |
| 1 | `45313d0` | 3 | Fixed: `InfraError.retryable` (`8241c29`), sparse arrays and symbol keys in `hashJson` (`7b1af72`), and trial numbers past 2^53 (`7cb29a2`). PLAN's CI wording corrected (`446422c`) |
| 2 | `446422c` | 1 | Fixed: symbol keys and named properties on arrays (`2389ee2`). Overview items: ids are built only from valid names (`b1994fd`), and the ConfigError comment is finished (`a4a3de6`) |
| 3 | `a4a3de6` | 2 | Fixed: non-enumerable properties (`1eac218`). Disputed with a Node probe: a JS `$` does not match before a trailing newline, and `027fed6` pins that in tests |
| 4 | `027fed6` | 0 | Findings: None |

Two overview items were answered on the PR and deliberately not changed. `-0` hashes like `0` because `-0 === 0`, so it is the same request, not a collision. CI covers feature branches through their PR rather than on every branch push.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
