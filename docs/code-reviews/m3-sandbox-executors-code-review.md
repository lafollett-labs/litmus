# Code Review: m3-sandbox-executors

**Verdict:** 🔁 CHANGES REQUESTED (round 4, locked to `924eda1`; raised cap reached)

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

## Review Round 2

**Verdict:** 🔁 CHANGES REQUESTED

| | |
| - | - |
| **Review Round** | 2 |
| **Reviewed SHA** | `4a1b3b3` (round-1 fixes: `bb08f64..4a1b3b3`) |
| **Reviewer** | PE-Vue |

PE-Vue drove the gate with bypass inputs and verified 12 of the 14 round-1 findings as RESOLVED. Among them:

- **Case variants:** `.GIT/hooks`, `.CLAUDE/`, `.MCP.JSON` and upper-cased suite paths are denied on APFS, and the mutation check holds.
- **Fail-closed:** NUL, ENOTDIR and ENAMETOOLONG inputs are denied.
- **Subagents:** every `isolation` value is refused.
- **Patterns:** brace and extglob climbs are denied, and 10 common globs are still allowed.

Two round-1 fixes were incomplete, and the demonstrated bypasses raised them to HIGH.

| ID | Finding | Disposition |
| - | - | - |
| HIGH-001 (was MEDIUM-004) | The process scan could be bypassed: `monitors/monitors.json`, components the manifest points at outside the default dirs, quoted or flow-mapping `hooks`, `.MD`, a symlinked skill dir, or a BOM | Fixed in `89d5ba6`: every markdown file in the plugin (any case of `.md`) has its frontmatter parsed as YAML, and one that doesn't parse is refused. A symlink anywhere in a plugin is refused. `monitors/monitors.json` and `statusLine` are process signals. A test covers each probe shape. All 17 cached plugins classify correctly, and every LaFollett plugin but `context-handoff` (which ships hooks) passes |
| HIGH-002 (was MEDIUM-005) | Under `[project]`, a nested `src/.claude/skills/x/SKILL.md` could be written and loaded mid-run | Fixed in `0fbc729` and `89d5ba6`: `protectSegments` refuses a write with a `.claude` segment at any depth (folded), and the fixture scan covers `.claude/` at any depth |
| MEDIUM-001 | A plugin inside the suite loaded, but could not read its own files, silently | Fixed in `89d5ba6`: refused before the session, naming both paths. A subject root inside a deny root is dropped from the read roots (for the harness it is only a version) |
| LOW-001 | The workdir `avoid` guard compared paths as written | Fixed in `e0daa43`: real, case-folded paths. Tests cover a symlinked TMPDIR, and another spelling on case-insensitive volumes |
| LOW-002 | `fold()` lower-cased but did not case-fold (`ſ`) | Fixed in `0fbc729`: `toUpperCase().toLowerCase()` after NFC, with a test for `final_meſſage.txt` |
| INFO-001 | The pattern refusal over-refuses a few rare legitimate shapes | No change: it fails closed, and the subject can rephrase |

The probe left a side effect behind: a detached git worktree registered in the litmus repo. It was removed.

Every fix commit passes check and test on its own. At the tip, 193 pass and 4 (live) are skipped. ARCHITECTURE is updated in `79509e8`.

## Merge Eligibility (latest)

**Locked to SHA:** `4a1b3b3`. The round-2 fixes are re-reviewed in round 3, the last round before the cap.

## Review Round 3

**Verdict:** 🔁 CHANGES REQUESTED (round cap reached)

| | |
| - | - |
| **Review Round** | 3 of 3 |
| **Reviewed SHA** | `0abd8b3` (round-2 fixes: `4a1b3b3..0abd8b3`) |
| **Reviewer** | PE-Vue |

PE-Vue verified 4 of the 5 round-2 findings as RESOLVED:

- HIGH-002: all 26 nested and case-variant writes are denied, and six near-miss names are allowed.
- MEDIUM-001: a plugin in the case or in `_shared` is refused up front.
- LOW-001: the avoid guard holds through a symlink and a case variant.
- LOW-002: `final_meſſage.txt` is denied.

It also read Claude Code's frontmatter loader in the CLI binary bundled with Agent SDK 0.3.281, and found that round 2's HIGH-001 fix parsed differently from that loader.

| ID | Finding | Disposition |
| - | - | - |
| HIGH-001 | Five frontmatter shapes load hooks in Claude Code's loader but passed litmus's strict parse: a four-dash close, a same-line close, a commented close, an indented close, and a `<<` merge key. The loader's fence is `/^---\s*\n([\s\S]*?)---\s*\n?/`, and Bun.YAML resolves merge keys | Fixed in `e1e7f90`: both fences are tried, with `{ merge: true }`. The reviewer's exact shapes and a CRLF variant are tests, in plugins and in the fixture. Mutation check: the strict fence alone fails the test. All 17 cached plugins classify as before |
| MEDIUM-001 | The plugin walk skipped `.git`, and the manifest can point a component there | Fixed in `e1e7f90`: plugins walk their `.git`, and only the fixture walk (whose `.git` is litmus's own) skips it. Tested with the reviewer's probe |
| LOW-001 | A frontmatter parse failure dropped the YAML error, and it suggested `allow_hooks` | Fixed in `e1e7f90`: each refusal carries its own fix. A typo names the parse error and says to quote the value |
| LOW-002 | Two copies of `fold()` | Fixed in `e1e7f90`: `fold` and `inside` live in `src/core/paths.ts` |
| INFO-001 | Round-2 continuity | No action |
| INFO-002 | An agent definition can set `isolation: worktree` where the gate cannot see it | Fixed in `e1e7f90`: `isolation` in any definition's frontmatter is refused |

At the tip, 196 tests pass and 4 (live) are skipped.

## Merge Eligibility (latest)

**Locked to SHA:** `0abd8b3`. The round-3 fixes (`e1e7f90`, docs in `7c64fdc`) have not been reviewed locally, and the 3-round cap is reached. Per the skill, this halts to the operator: proceed with one more round, abort, or escalate.

The operator chose one more round (cap raised to 4).

## Review Round 4

**Verdict:** 🔁 CHANGES REQUESTED (raised cap reached)

| | |
| - | - |
| **Review Round** | 4 of 4 (cap raised by the operator) |
| **Reviewed SHA** | `924eda1` (round-3 fixes: `0abd8b3..924eda1`) |
| **Reviewer** | PE-Vue |

PE-Vue verified all five round-3 findings as RESOLVED:

- Bun's loader reads hooks from all 7 shapes in `shapes.json`, and litmus now refuses all 7. `FENCES[0]` is byte-identical to the CLI's own regex.
- Where the two fences capture different bodies, the strict one can only add refusals.
- No cached or marketplace plugin is refused for `isolation`.

Round-3's HIGH-001 fix resolved merge keys the way the YAML spec does, which is not how Claude Code's parser (Bun) does it.

| ID | Finding | Disposition |
| - | - | - |
| HIGH-001 | Bun.YAML merges a quoted or escaped `"<<"` and coerces a collection key (`[hooks]`, `[[hooks]]`, `? - hooks`) to its text, so 11 shapes load `hooks`, `mcpServers` or `isolation` while passing a spec parse. Checked end to end against the CLI's lifted loader on Bun 1.4.2 and 1.3.12 | Fixed in `e741189` by closing the class rather than chasing Bun: every top-level frontmatter key must be a plain string scalar, and any `<<` is refused, plain or quoted. All 11 shapes are tests, as a skill, as an agent and in the fixture. Mutation check: dropping the key refusal fails the test. All 17 cached plugins classify as before |
| LOW-001 | `allow_hooks: true` also turned off the isolation refusal | Fixed in `e741189`: the scan always runs, and `allow_hooks` waives process signals only. Isolation, links, non-plain keys, merge keys and parse failures are refused either way |
| LOW-002 | A fixture `.GIT/` got past the case-sensitive `.git` refusal on APFS, and its config ran during litmus's `git add` (proven with a clean filter) | Fixed in `6789282`: the check is folded, as is the post-patch `.git/` link filter. Tested with `.git`, `.GIT` and `.Git` |
| INFO-001 | A marketplace agent with an unquoted `: ` in its description is refused as invalid YAML, although Claude Code loads it | No action: it fails closed and says to quote the value |

At the tip, 199 tests pass and 4 (live) are skipped. ARCHITECTURE is updated in `c23b9d7`.

## Merge Eligibility (latest)

**Locked to SHA:** `924eda1`. The round-4 fixes (`e741189`, `6789282`, docs `c23b9d7`) have not been reviewed locally, and the raised cap is reached. This halts to the operator again.


## Gate 2: PR #5 (Copilot)

The PR opened at `41dec51` with the round-4 fixes unreviewed, as the operator chose. From then on, review happened on the PR and no local round was run.

| Round | Reviewed SHA | Threads | Outcome |
| - | - | - | - |
| 1 | `41dec51` | 8 (6 HIGH, 2 MEDIUM) | All fixed, each with a test that fails on the old code. Extglob and bare regex groups end a pattern's prefix and are refused when they hold `/`; only glob fields are patterns (`1631c5a`). Keys are redacted by value in the transcript, the live steps, every artifact (byte-exact) and the result reason (`3546db7`). The workdir is built from its real path, so a symlinked `litmus/` is judged and scanned where it lands, and a symlinked fixture root is refused (`5143094`). An answer that arrives after the timeout or cancel is classified by the clock in both executors (`ccc0353`) |
| 2 | `ccc0353` | 5 (overview: 5 HIGH), plus a CI failure | All fixed. CI: after `git commit`, the runner's git detached auto-maintenance, which kept running in the workdir and raced the symlink scan. `maintenance.auto=false` and `gc.auto=0` stop it, and the post-patch scan now covers `.git` too; git 2.54 already refuses a patch into `.git/` or `.GIT/`, but the scan no longer relies on that (`359fd59`). `inside()` treats `/` as containing every path (`e29c474`). A store or suite root beneath the prospective workdir is refused, not removed with it (`2230061`). A `..` segment is refused in every path field, because the OS applies it after a symlink (`8868858`). A plugin root that is itself a symlink is refused (`cc87722`). Docs are in `b99e90f` |
| 3 | `e9d8326` | 2 | CI green, so the git-maintenance fix held. Fixed in `eff10f1`: a `..` segment is refused between either slash (litmus is POSIX-only, where `\` is a name character, so this costs nothing). Disputed with evidence: a path below a regular file (`src/a.ts/x`) is already denied, because `lstat` there is ENOTDIR at any depth, never ENOENT, and the gate fails closed on it. An explicit check would be unreachable. The test now covers two depths and asserts the ENOTDIR denial |
| 4 | `02f6865` | 1 HIGH | Fixed in `1411dc2`: a plugin that contains a suite root is refused before the SDK starts. Its manifest could point skills or agents into the suite, and the loader reads those files before the gate sees a call. The older runtime test of a suite inside a plugin now uses a directory subject, which is still a read root. CI green |
| 5 | `f062316` | 2 | Fixed in `7032bd9`: `allow_hooks` waives only the classified process keys in `plugin.json`, and an unknown key is always refused. Its sibling call sites handle frontmatter, which was never an allowlist and waives only process keys. Disputed with evidence in `fc41fed`: Node's recursive `mkdirSync` does not follow a dangling `litmus/` link. It fails with ENOENT and creates nothing, and a test now proves the store is untouched. A re-check after mkdir would be unreachable |
| 6 | `c66d437` | 1 | Fixed in `d240cc6`: `commands`, `agents` and `skills` in `plugin.json` must be a path or a list of paths, each resolving inside the plugin. `../suite/cases/c`, `/etc` and `x/../../y` are refused, as is an object form, whether or not `allow_hooks` is set. None of the 46 installed manifests uses these keys, so nothing real is refused |
| 7 | `d6ba0fb` | 3 | All fixed. A structured tool result is redacted before `JSON.stringify` escapes it (`2a87088`). Artifact names are redacted, and a name that redaction makes collide takes a `~n` suffix (`2a87088`). Snapshot and collection read files with `O_NOFOLLOW` and `O_NONBLOCK` and check the open file's type (`9bbbc6d`), and an artifact is copied only if its bytes still hash to what the snapshot saw (`2a87088`). A FIFO swapped in used to hang the snapshot. Swapping a parent directory stays open, but only under `allow_shell`, which is already uncontained |
| 8 | `3934a7a` | 3 | All fixed; two were real hangs, and on the old code their tests are cancelled by the runner's timeout. `plugin.json` is read with `readRegular`, so a FIFO or link is refused and never read. A FIFO or socket anywhere in a plugin tree is refused (`8c645fe`). The model executor races `complete()` against the clock, so a provider that ignores its signal and never settles still times out as a retryable infra error (`44e0e4a`) |
| 9 | `ede279a` | local (PE-Vue) | Copilot's quota ran out, so a local PE-Vue round stood in for it. **✅ APPROVED**, with 2 LOW and 1 INFO. It confirmed (a) no read of a plugin or fixture file blocks or follows before the walk refuses it, (b) the model race leaks no rejection and classifies cancel and timeout correctly (probed under `--unhandled-rejections=strict`), and (c) no installed plugin holds a special file. All fixed after approval in `080f25d`, each with a test that fails on the old code. LOW-001: a socket is refused only where a component would be read, so git's fsmonitor socket in a plugin's `.git` passes. LOW-002: `.claude-plugin` must be a directory, which closes a symlinked holder and turns a raw ENOTDIR into a refusal. INFO-001: a shadowed name is renamed |

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
