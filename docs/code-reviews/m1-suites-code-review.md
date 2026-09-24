# Code Review: m1-suites

**Verdict:** 🔁 CHANGES REQUESTED (round 1, locked to `056b52d`)

| | |
| - | - |
| **Branch** | `m1-suites` (Gate 1, local, before any PR) |
| **Reviewer** | @Cali LaFollett (PE-Vue + PE-AWS-Infra + PE-Governance) |
| **Review Round** | 1 |
| **Reviewed SHA** | `056b52d` (on M0's tip; rebased onto `main` after PR #2 merged, with the M1 diff unchanged) |
| **Title** | M1: suites and config |
| **Date** | 2026-09-24 |

---

## Summary

PE-Vue reproduced every finding with a probe or a CLI run. It confirmed that `npm ci` has 0 vulnerabilities, that `check` is clean, and that 54 of 54 tests pass. The MEDIUMs fall into three groups:

- The loader let filesystem surprises escape as stack traces (exit 1, which `run` uses for a blocking verdict).
- Several mistakes produced an empty run that exits 0 rather than an error.
- The code had drifted from the contract: the `--config-file` flag, the review-match bounds, the result types, and the effective `min_trials` rule.

PE-AWS-Infra checked the concurrency change against GitHub's docs and ran it with `act` under both events. PE-Governance found one routing glob that was broader than intended.

## Findings Overview

| Severity | In Scope | Out of Scope |
| - | - | - |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 0 | 0 |
| 🟡 MEDIUM | 9 | 0 |
| 🟢 LOW | 11 | 0 |
| ℹ️ INFO | 4 | 0 |

## Findings and dispositions

| ID | Finding | Disposition |
| - | - | - |
| V-MED-001 | fs errors on authored paths (a directory as prompt_file, EACCES, a dangling link) crash with exit 1 | Fixed in `4399fa5`: every stat, read and readdir goes through one wrapper that raises ConfigError. There is a test for each case the finding lists |
| V-MED-002 | A directory subject (a plugin) crashes the loader | Fixed in `4399fa5`: a directory is hashed by its tree (relative path plus sha256, sorted, `.git` skipped, symlinks refused). A model case with a directory subject is a ConfigError |
| V-MED-003 | A root with no suites selects nothing and exits 0 | Fixed in `4399fa5` (per-root error; a directory with `suite.yml` or `cases/` but no `suite.yaml` is an error) and in `ec5d0ca` (`select` refuses an empty case list) |
| V-MED-004 | A case directory without `case.yaml` is silently dropped | Fixed in `4399fa5`: every directory under `cases/` must be a case, except names starting with `_` or `.` |
| V-MED-005 | The CLI used `--config`, but the contract says `--config-file` | Fixed in `d30a3d5`: a shared `COMMON` option table, and the loader's hint updated |
| V-MED-006 | review-match `pass` rejected three documented bounds | Fixed in `d74557f`: M4's grader schema was ported as-is (all seven bounds, and `min_claims_correct` needs `confirm`) |
| V-MED-007 | `types.ts` drifted from ARCHITECTURE | Fixed in `d3ca4e9`: `inconclusive_reason`, nullable metrics, `excluded` with reasons, `notes`, and `extractor_hash` / `judge_hashes` / `tool_calls` / `findings` on TrialRecord. These match the shapes on the M4–M6 branches |
| V-MED-008 | `settings.min_trials` baked in the default | Fixed in `4399fa5`: `Settings.min_trials` is only what was written, and `effectiveMinTrials(settings, requested)` applies the rule |
| V-MED-009 | A trial key naming an undefined config was accepted | Fixed in `ec5d0ca`: `select` takes the defined config names and throws, listing them |
| V-LOW-001 | A repeated trial key is scheduled twice | Fixed in `ec5d0ca` |
| V-LOW-002 | `list --help` exits 2, and the no-command usage went to stdout | Fixed in `d30a3d5` |
| V-LOW-003 | Invalid regex patterns or flags and inverted bounds load cleanly | Fixed in `d74557f` (from M4) |
| V-LOW-004 | JudgeDef was looser than ConfigDef | Fixed in `d74557f`: `JudgeDef = ConfigDef` |
| V-LOW-005 | A prompt_file or subject could point at a case's answers | Fixed in `4399fa5`: refused for `truth.yaml`, `fake.yaml`, `fix/` and `proof/` of any case |
| V-LOW-006 | A recursive YAML alias overflows the stack | Fixed in `4399fa5`: `parseFile` refuses cycles in every file, before any other walk |
| V-LOW-007 | Undocumented defaults, strict findings, and redact values in the walk | Fixed in `7b4628d` (a defaults table and the walk wording) and `d74557f`: findings allow extra keys, since they are model output |
| V-LOW-008 | `AWS_BEARER_TOKEN_BEDROCK` missing from the credential variables | Fixed in `4399fa5` and `7b4628d` |
| V-LOW-009 | Test gaps: the case-name mismatch, NAME on suite and case names, `?` globs, a missing subject | Fixed: tests added in `4399fa5` and `ec5d0ca` |
| V-LOW-010 | Plugin and json-schema paths are not checked at load | Fixed in `4399fa5`: `LoadedCase.plugins` holds absolute, existing directories, and a non-built-in schema must be a file |
| V-INFO-001 | The key regex refuses thinking budgets, but the doc invites "thinking" | Fixed in `7b4628d`: the doc says the name check is broad on purpose, and that budgets go through `effort` and `max_tokens` |
| V-INFO-002 | The subject hash was taken over decoded text | Fixed in `4399fa5`: hashed over bytes, with a test using two invalid-UTF-8 files |
| V-INFO-003 | Security pass (path traversal is by design; YAML safe) | No action beyond LOW-005 and LOW-006 |
| G-LOW-001 | `scripts/**` would route future shell tooling to pe-vue | Fixed in `6aab867`: `scripts/**/*.ts` |
| I-INFO-001 | The concurrency change is correct under both events | No action |

Every fix commit passes `npm run check` and `npm test` on its own. At the tip, 74 of 74 tests pass.

## Merge Eligibility

**Locked to SHA:** `056b52d`. The fix commits after it are re-reviewed in round 2.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
