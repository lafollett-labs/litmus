# Code Review: fix-gate-skill-mentions

**Verdict:** 🚫 BLOCKED (round 1, at `31474ef`). The fixes for every finding are in `de8e1d6` and `9d2c8e5`, which round 2 reviews.

| | |
| - | - |
| **Branch** | `fix/gate-skill-mentions` (Gate 1, local, before any PR) |
| **Reviewers** | PE-Vue (src, tests, docs), PE-Governance (AGENTS.md) |
| **Review Round** | 1 |
| **Reviewed SHA** | `31474ef` |
| **Title** | Security: a harness subject could read past the gate through `@` mentions |
| **Date** | 2026-10-19 |

---

## Summary

The whole-system sweep of v0.1.0 found that Claude Code expands an `@path` mention in a skill's arguments by reading the path itself, without asking the PreToolUse hook. A $0 probe confirmed it: the real binary against a fake Messages API listed the case directory and read `~/.aws/credentials`. Round 1 of the fix did four things:

- refused a Skill call carrying `@`;
- gave the session only the tools the gate can allow;
- denied the run store;
- voided a trial whose tool call came back without the hook's decision.

A real-binary e2e test covers all four.

PE-Vue probed the fix with the same harness and found that `@` reaches Claude Code through more than the args.

| Severity | In Scope | Out of Scope |
| - | - | - |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 1 | 1 |
| 🟡 MEDIUM | 1 | 0 |
| 🟢 LOW | 4 (3 PE-Vue, 1 PE-Governance) | 1 |
| ℹ️ INFO | 3 | 2 |

| ID | Finding | Disposition |
| - | - | - |
| HIGH-001 | A plugin skill body `Review @$ARGUMENTS` turns `@`-free args into a read the hook never sees | Fixed. The plugin scan marks arg-fed mentions, and the gate then judges Skill args as Read paths, whole and word by word. e2e: a truth path is denied, `a.go` is allowed, and the canary never reaches the model |
| HIGH-002 | A plugin body that `@`-mentions an absolute path, `..` or `${CLAUDE_PLUGIN_ROOT}/..` is read before any tool call (already in v0.1.0) | Fixed in scope. The case is refused before the session when a body mention names a path outside the plugin, a home path, a `..`, or a variable other than the args |
| (author) | Found while fixing HIGH-001: a plain prompt's rendered `{{fixture}}` holding `@<path>` made Claude Code read that path. The prompt is not echoed in the stream, so the runtime check cannot see it | Fixed. Rendered files get U+2060 after each word-initial `@`. Probes confirmed that `@`+U+2060, U+200B, fullwidth `＠` and `\@` are not expanded, while a plain `@` control leaks. An `@` mention in the case's own prompt text that Read would refuse refuses the trial |
| (backstop) | Defense in depth for any expansion missed | An expanded mention in user text that Read would refuse ends the trial as `model_failure`. It is a FAIL, not an ERROR, so a subject cannot use it to dodge a FAIL |
| MEDIUM-001 | With the store inside a plugin, a subject's artifact with bad frontmatter refuses every later run of that plugin | Fixed. The plugin scans skip the store, and a manifest may not point a component into it |
| LOW-001 | The fail-closed set recorded calls the hook saw, not calls it allowed | Fixed. Only allowed ids count. Test: a denial that ran anyway voids the trial |
| LOW-002 | KillShell and BashOutput became TaskStop and TaskOutput in 0.3.281 | Fixed. Both are added to SHELL_TOOLS, and the e2e check of the offered tools now runs with the shell and network on as well as off |
| LOW-003 | A store denial said "may not reach a suite root" | Fixed. GatePolicy has `storeRoots` with its own reason |
| LOW-004 | Bundled skills (code-review, security-review, …) are offered to the subject | Deferred, out of scope. The SDK `skills` option needs exact plugin skill names, and a wrong name would hide the subject's own skill. It is a follow-up with its own e2e. With `@` refused, the bundled skills no longer reach outside the gate |
| Gov LOW-001 | "passing" is satisfied by a run with both e2e tests skipped | Fixed. AGENTS.md names `fail 0` and `skipped 0`, with the nvm chain |
| INFO-001 | Fail-closed soundness: no false void found; reads inside Claude Code are invisible to it | Noted. That gap is why the mention layers were added |
| INFO-002 | The `@` rule refuses legitimate args such as `HEAD@{1}` | Documented in the ARCHITECTURE gate table |
| INFO-003 | e2e flakiness risk is low; turns are keyed by a counter | Accepted. The SDK pin limits it to deliberate upgrades |

## Test evidence

| PE | Test budget | Evidence |
| - | - | - |
| PE-Vue | targeted | typecheck exit 0 at `31474ef`; e2e passed 8 times serially and 4 times in parallel; probes s1–s8 and b1–b7 |
| PE-Governance | none | ran the e2e test once (tests 2, pass 2, fail 0, skipped 0) |

After the fixes, at `9d2c8e5`:

- `npm run check` exit 0.
- `npm test` tests 615, pass 610, fail 0, skipped 5, with 4 of 4 real-binary e2e tests passing.
- `validate` reports 11 cases: 0 invalid, 1 warning.
- 16 of 16 new mutants are killed.

## Review Round 2

**Verdict:** 🚫 BLOCKED at `dfc0353`. All findings are fixed in `026f78d`, which round 3 reviews.

| | |
| - | - |
| **Reviewer** | PE-Vue |
| **Reviewed SHA** | `dfc0353` |

| ID | Finding | Disposition |
| - | - | - |
| HIGH-101 | An `@` after `。`, `、`, `？` or `！` is expanded, and every layer missed it, in rendered files and plugin bodies alike | Fixed by a redesign. Matching Claude Code's mention grammar can't be won, so the trial env sets `CLAUDE_CODE_DISABLE_ATTACHMENTS=1`, which stops Claude Code reading any mention it expands. Probes on the real binary found no leak with it set, against a leak without it, for: a directory listing, a rendered fixture, the prompt text, a plugin body (absolute path and arg-fed), quoted args and the CJK forms. The skill bodies still reach the model |
| HIGH-102 | The backstop false-FAILed a subagent prompt naming `@/components` | Fixed: the backstop is removed. Nothing is read, so there is nothing to catch |
| MEDIUM-101 | Arg judging parsed quotes and `${CLAUDE_PLUGIN_ROOT}/$ARGUMENTS` differently from Claude Code | Fixed: arg judging is removed. Skill is allowed; its args are read as text |
| MEDIUM-102 | The plugin scan refused Vue aliases, `@~/…` and `@$VAR` that name no real path | Fixed: the plugin mention scan is removed |
| LOW-101 | Fixture `.claude` skills were not scanned | Fixed by the same switch. A fixture's settings may set only `$schema`, so its `env` cannot turn the switch back on, and `.claude` writes stay refused under project settings |
| INFO-101 | Round-1 continuity | Noted. The store, allowed-ids and offered-tools fixes stand |

e2e at `026f78d`: three real-binary tests. One covers every way out (Skill `@` args, Read, Glob, a subagent's Read) and adds a listing canary. One checks the offered tools. One shows no mention is read from a plugin body, arg-fed and quoted args, the CJK form, the prompt text, or a rendered fixture.

Receipts at `026f78d`:

- `npm run check` exit 0.
- `npm test` tests 607, pass 602, fail 0, skipped 5.
- `node --test test/executors/harness-e2e.test.ts` tests 3, pass 3, fail 0, skipped 0.
- `validate` reports 11 cases: 0 invalid, 1 warning.
- Mutant (the switch renamed): 3 tests fail, both mention e2e tests and the env unit test.
- Mutant (Skill dropped from the allowed set): 3 tests fail.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
