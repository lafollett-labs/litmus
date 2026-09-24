# Code Review: m3-sandbox-executors

**Verdict:** 🔁 CHANGES REQUESTED (round 1, locked to `bb08f64`)

| | |
| - | - |
| **Branch** | `m3-sandbox-executors` (Gate 1, local, before any PR) |
| **Reviewer** | @Cali LaFollett (PE-Vue) |
| **Review Round** | 1 |
| **Reviewed SHA** | `bb08f64` |
| **Title** | M3: sandbox and executors |
| **Date** | 2026-09-24 |

---

## Summary

This review covers the project's security boundary. PE-Vue read the full files, checked the Agent SDK declarations (`sdk.d.ts`, `sdk-tools.d.ts`), and probed Node API behaviour in a scratch directory. It made no live calls. `npm run check` is clean, and 179 tests pass with 4 (live) skipped.

The one HIGH is a platform mismatch. The gate compared paths case-sensitively on a case-insensitive filesystem, so on default APFS `.GIT/hooks/x` passed the `.git` refusal, and a case-variant path could reach a suite root inside a plugin. The MEDIUMs are places where the gate trusted something it should have judged:

- an exception inside the gate
- an abort that ended the stream quietly
- subagent `isolation`
- a denylist of hook signals
- config the session reloads
- brace patterns
- a workdir name that is not one-to-one

## Findings Overview

| Severity | In Scope | Out of Scope |
| - | - | - |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 1 | 0 |
| 🟡 MEDIUM | 7 | 0 |
| 🟢 LOW | 6 | 0 |
| ℹ️ INFO | 1 | 0 |

## Findings and dispositions

| ID | Finding | Disposition |
| - | - | - |
| HIGH-001 | The gate compared the typed case on a case-insensitive filesystem: the `.git` refusal and a suite-root deny inside a read root could be bypassed | Fixed in `77d1427`: `realpathSync.native` for the target and every root (harness in `bfcf121`), and protected names compared case-folded with NFC because they may not exist yet. There is a gate test for a case variant, skipped on case-sensitive volumes. Mutation check: dropping `.native` fails it |
| MEDIUM-001 | Gate exceptions (ENOTDIR, EACCES) were uncaught, so a hook failure could fail open | Fixed in `77d1427`: `decide()` catches and denies with the error as its reason, and a transcript write failure cannot turn a denial into a hook error (`bfcf121`) |
| MEDIUM-002 | A timeout or cancel that ended the stream without a throw was classified as a retryable infra error | Fixed in `bfcf121`: the clock is checked after the loop too, unless the session had already finished cleanly. Tests cover a quiet end and an error result after an abort |
| MEDIUM-003 | Agent and Task were always allowed, even with `isolation: worktree` (git mid-session) or `remote` (outside the gate) | Fixed in `77d1427`: they are allowed only with no `isolation` |
| MEDIUM-004 | Hook detection was a denylist of three signals | Fixed in `bfcf121`: `plugin.json` keys are an allowlist; `.lsp.json` joins the refused files; and skill, agent and command frontmatter is scanned for `hooks`, `mcpServers` and `lspServers`, in plugins and in the fixture's `.claude/`. All the LaFollett plugins' manifests pass the allowlist |
| MEDIUM-005 | The subject could write `.claude/**` in its own workdir under project settings, and the session could then reload it | Fixed in `bfcf121`: under `[project]`, writes to `.claude/` and `.mcp.json` are refused, including case variants of names that don't exist yet |
| MEDIUM-006 | A `..` or absolute alternative inside a brace or class was judged against the workdir | Fixed in `77d1427`: a pattern holding `..`, `~`, or a brace or class with `/` is refused |
| MEDIUM-007 | The workdir slug was not one-to-one, so a second build could delete a live sibling | Fixed in `c6cfd40`: the directory name carries a 12-character hash of the key |
| LOW-001 | Deny roots depended entirely on the caller | Fixed in `bfcf121`: the case directory, its suite and its root are always denied |
| LOW-002 | The workdir placement guard was narrower than the contract | Fixed in `c6cfd40`: `avoid` roots (the store and the suite roots, passed by the runner), and `.claude/CLAUDE.md` and `.claude/rules` are probed |
| LOW-003 | `GOFLAGS` was in the env allowlist but not in the contract | Documented in `3cc3605`: it is the operator's own setting |
| LOW-004 | An API-error turn with no status was always retried | Fixed in `bfcf121`: it is not retried when its text says auth or billing |
| LOW-005 | A harness timeout returned no artifacts | Fixed in `bfcf121`: a timeout collects them, as max_turns does |
| LOW-006 | A subject file named `final_message.txt` was overwritten silently | Fixed in `bfcf121`: the name is reserved, and a write to it is refused and recorded |
| INFO-001 | Focus areas that came out clean: env replacement, tool field names, MCP, TOCTOU and hard links (possible only under `allow_shell`) | No action |

Every fix commit passes check and test on its own (183 to 190). At the tip, 190 pass and 4 (live) are skipped. ARCHITECTURE is updated in `5963071`.

## Merge Eligibility

**Locked to SHA:** `bb08f64`. The fix commits after it are re-reviewed in round 2.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
