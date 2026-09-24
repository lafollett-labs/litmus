# Code Review: docs-foundation

**Verdict:** 🚫 BLOCKED

| | |
| - | - |
| **Branch** | `docs/foundation` |
| **PR** | [#1](https://github.com/lafollett-labs/litmus/pull/1) |
| **Author** | @clafollett |
| **Reviewer** | @Cali LaFollett (PE-Governance + independent generic reviewer) |
| **Review Round** | 1 |
| **Reviewed SHA** | `1f0da3a03e49a131f6386daab0244e515f10c085` |
| **Title** | Foundation docs: README, architecture contract, plan to 0.1.0, governance |
| **Files Changed** | 12 |
| **Lines Changed** | +1421 / -0 |
| **Date** | 2026-09-24 |

---

## Summary

This PR is docs only, and the docs are the contract that milestones M0–M11 will implement without supervision. The reviewers found six HIGH design defects, and each would have been built exactly as written:

- the rate policy can never reach PASS at the documented defaults
- a case-only bootstrap gives a falsely tight interval for a small number of cases
- nits are unbounded, and a reviewer's own severity label can hide a false positive
- proof tests would have to live inside the fixture, so the subject can see them
- Claude Code's settings, hooks and MCP servers bypass the tool gate
- subject-written code runs with the provider keys in its environment

The MEDIUM findings are real contract gaps. The pe-governance findings are about accuracy and form in `CLAUDE.md`.

---

## Findings Overview

| Severity | In Scope | Out of Scope |
| - | - | - |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 6 | 0 |
| 🟡 MEDIUM | 18 | 0 |
| 🟢 LOW | 11 | 0 |
| ℹ️ INFO | 3 | 1 |

---

## In Scope Findings

Findings are listed by the ID of the reviewer that raised them: `G-*` is the generic reviewer (human docs) and `P-*` is PE-Governance (`CLAUDE.md`). Where the two reviewers raised the same issue, it is merged into one finding and both IDs are listed.

### 🟠 HIGH

| ID | Location | Finding | Fix |
| - | - | - | - |
| G-HIGH-001 | `docs/ARCHITECTURE.md` § Verdicts | **Rate policy.** The Wilson lower bound for an all-pass run needs n ≥ 16 to clear 0.8, so a perfect 5/5 is INCONCLUSIVE and 4/5 is FLAKY. The policy also has no empty-scored or `min_trials` guard | Add the guards. A straddling interval is INCONCLUSIVE, and `rate` has no FLAKY. Document `minTrialsToPass`, and `validate` warns when a case's trials are below it |
| G-HIGH-002 | § Comparison | **Bootstrap.** Resampling cases only gives a zero-width interval for one case and an overconfident one for three | Use a two-level bootstrap: resample cases, then draw per-case rates from a Jeffreys Beta posterior |
| G-HIGH-003 | § Grader, `review-match` | **Nits.** Nits are unbounded, the reviewer's own `low` label turns a false positive into a nit, and clean cases exempt low findings | Add `max_nits` and `max_findings` bounds and a `precision_all` metric. On a clean case every finding counts. Record nits in the metrics and the UI |
| G-HIGH-004 | § Suite and case files | **Proof tests.** Proof tests have to sit in `fixture/`, so the subject sees them | Add a `proof/` overlay that is applied only to a copy used for validation. `validate` fails if proof paths exist under `fixture/` |
| G-HIGH-005, P-LOW-003 | § Executor `harness` | **Harness isolation.** Omitting `settingSources` loads the user's settings. Plugin hooks and MCP servers run outside the gate. `project` loads `CLAUDE.md` from every parent directory | Always pass `settingSources` explicitly (default `[]`, and only `project` allowed). Disable auto-memory and use a `CLAUDE_CONFIG_DIR` per trial with `strictMcpConfig`. Hooks and MCP servers are refused unless `allow_hooks`. Build workdirs under the OS temp dir |
| G-HIGH-006 | § Grader `command`, `SECURITY.md` | **Child processes.** The command grader and any git call in the workdir run subject-written code with the provider keys in the environment | Give every child process a scrubbed env allowlist. Detect written files by a filesystem snapshot, not git. Document `command` as uncontained. `validate` works on a disposable copy |

### 🟡 MEDIUM

| ID | Finding | Fix |
| - | - | - |
| G-MED-001 | `min_trials` is used but never defined | Define it in the suite defaults and per case, with a default of ceil(trials / 2) |
| G-MED-002 | Exit codes have no mapping for INCONCLUSIVE, WARN, `validate` or `compare`, and `--allow-flaky` is missing from the synopsis | Map every outcome. WARN never changes the exit code |
| G-MED-003 | `expect: fail` inversion misses FLAKY and the comparison, and a model_failure counts as the expected failure | Count a success only when graders ran and rejected the output. Any pass on a canary makes it FAIL. Comparisons use success rate |
| G-MED-004 | pass@k and pass^k with k equal to the trial count reduce to 0/1 flags | Use k = min(3, scored), and null when nothing scored |
| G-MED-005 | An infra error during grading (judge, extractor, confirm) becomes FAIL | Graders throw `InfraError`. Only the grading is retried, and the trial becomes error once retries run out |
| G-MED-006 | Cancel and timeout share one signal, there is no cancelled status, and retry workdirs are unspecified | Add a `cancelled` trial status, excluded from scoring. Use a fresh workdir on every attempt, and sum usage across attempts |
| G-MED-007 | `extract` and `confirm` are missing from the contract | Specify both, including hashes and comparison refusal |
| G-MED-008 | `change.patch` semantics are unspecified | HEAD is `litmus/change` with the base on `main`. Truth lines refer to the post-patch tree. Add a `{{diff}}` placeholder |
| G-MED-009 | Names go into paths and URLs | Names use the NAME grammar and must equal their directory name (already true in M1). URLs percent-encode trial keys |
| G-MED-010 | Workdir location, symlinks and plugin-root reads are unspecified | Build workdirs in the OS temp dir, reject symlinks, confine paths by realpath, and give plugin roots read-only access |
| G-MED-011 | How to name the two sides of a comparison, and its edge cases, are ambiguous | Define a grammar for each side, exclude unscored cases, and skip WARN when a median is 0 |
| G-MED-012 | Private vulnerability reporting is disabled | Enabled 2026-09-24 (`{"enabled":true}`), and an email fallback added to the issue chooser |
| G-MED-013 | "Existing login" for the harness conflicts with the Agent SDK terms | The harness uses an API key or Bedrock credentials only |
| G-MED-014 | "Keys never written" has no mechanism behind it | Redact key values in the store and in every reporter, store only the parsed response body in `raw`, and add a planted-key test |
| P-MED-001 | The `CLAUDE.md` trial-stop mapping uses verdict names, and "bad output" is broader than the contract | Rewrite it as a table of trial statuses, and add a sentence on case verdicts |
| P-MED-002 | Nothing marks fixture bugs as intentional, so the review gate will "fix" them | Add a rule: fixtures are test data |
| P-MED-003 | pe-vue runs `npm run typecheck`, and no such script exists | Add a `typecheck` alias in M0 |
| P-MED-004 | Review commands run code from fork PRs using the operator's environment | Add a rule: read the whole diff before running anything from a fork PR |

### 🟢 LOW and ℹ️ INFO

| ID | Finding | Fix |
| - | - | - |
| G-LOW-001 | The location schemas contradict each other | Use `line`/`end_line`, treat lines as an inclusive range, apply `window` to decoys, and make precision null when there is nothing to divide |
| G-LOW-002 | "Rerun failed" is undefined | Select by verdict set per (case, config). Add Rerun errored |
| G-LOW-003 | Some knobs and records are unspecified (δ, seed, PRNG, `fake.yaml`, record shapes, params) | Specify each one, or point to the milestone that defines it |
| G-LOW-004 | Gaps in the executor contract | Remove the fake executor, reject unsupported harness×provider pairs, have graders judge unparseable output, and define how JSON is extracted |
| G-LOW-005 | The server's Host and Origin checks are loose | Use an exact allowlist, reject a missing Origin on mutating requests, and send no CORS headers |
| G-LOW-006 | The README overclaims | Narrow both claims |
| G-LOW-007 | M11 refers to a quickstart that doesn't exist | M11 writes it |
| P-LOW-001 | Costume prose in `CLAUDE.md` Hard rules | Rewrite as plain sentences |
| P-LOW-002 | The isolation rule names only the workdir builder | Name the leaking layer, and add the `allow_shell` exception |
| P-LOW-004 | The `validate` command passes a path where the grammar expects a selector | Add a root `litmus.config.yaml`; `validate` takes selectors |
| P-LOW-005 | `nvm use 26` run as a separate step is lost between shells | Chain it in the same command: `nvm use && …` |
| P-INFO-001 | Workflow gates before M0; the merge step doesn't say "until APPROVED" | Word the workflow as "until APPROVED" |
| P-INFO-002 | Contributors lack the code-reviewer plugin | Name the marketplace |
| P-INFO-003 | The `src/server/**` row skips `test:ui` | Add the row |

---

## Out of Scope

| Severity | Issue | Location |
| - | - | - |
| ℹ️ INFO | The hub's Routing table has no litmus row (P-INFO-004) | `lafollett-labs-workspace/CLAUDE.md` § Routing |

---

## Action Items

### Must Fix (blocks merge)

- [ ] G-HIGH-001 through G-HIGH-006

### Required

- [ ] Every MEDIUM above

### Optional

- [ ] LOW and INFO, where cheap

---

## Merge Eligibility

**Locked to SHA:** `1f0da3a03e49a131f6386daab0244e515f10c085`
**Status:** 🚫 Blocked. Round 2 is required after remediation.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
