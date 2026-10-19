# Code Review: feat-claude-subscription

**Verdict:** 🚫 BLOCKED (round 1, at `c086564`). HIGH-001 was dismissed as the owner's decision. The other findings are fixed in `7213d6e`, which round 2 reviews.

| | |
| - | - |
| **Branch** | `feat/claude-subscription` (Gate 1, local, before any PR) |
| **Reviewer** | PE-Vue |
| **Review Round** | 1 |
| **Reviewed SHA** | `c086564` |
| **Title** | A `claude-subscription` provider: harness cases on the operator's own Claude plan |
| **Date** | 2026-10-19 |

---

## Summary

The `claude-subscription` provider runs harness cases on the operator's own Claude plan. It works like this:

- It reads `CLAUDE_CODE_OAUTH_TOKEN`, minted by `claude setup-token`, from the environment and nowhere else.
- It never runs a login and never stores the token.
- It never reads the stored claude.ai login, because `HOME` and `CLAUDE_CONFIG_DIR` belong to the attempt.
- It leaves `ANTHROPIC_API_KEY` out of the trial env, since Claude Code would prefer that key to the token.
- A model case on it is refused at plan time. It cannot be a judge, takes no params, and its trials carry no cost.

PE-Vue confirmed the boundaries:

- The SDK's `Options.env` replaces the process env rather than merging with it.
- No provider switch elsewhere mishandles the new provider: the CLI, the `/api/configs` route, validate, the reporters, comparison and the UI were all checked.
- The planner refusal covers trial keys and reruns.

| Severity | In Scope | Out of Scope |
| - | - | - |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 1 | 0 |
| 🟡 MEDIUM | 1 | 0 |
| 🟢 LOW | 4 | 0 |
| ℹ️ INFO | 1 | 0 |

| ID | Finding | Disposition |
| - | - | - |
| HIGH-001 | The Agent SDK overview says third-party products may not offer claude.ai login or rate limits unless approved | **Dismissed: the owner's decision.** Cali ruled on this before the work began: litmus is a local CLI, not a SaaS product, and an engineer running it on their own token for their own work is personal use. Anthropic's authentication docs describe `setup-token` for "CI pipelines, scripts". The reviewer's option (b) was taken in part: the README and ARCHITECTURE now say the use is the operator's own, under their plan's terms, and that plan limits are for individual use |
| MEDIUM-001 | SECURITY.md still said the harness uses API keys only, and left the token out of the redaction row and the `allow_shell` exposure paragraph | Fixed. The credentials row names the token, the redaction row lists it, and the `allow_shell` paragraph says a subject can read it: use a token you can revoke |
| LOW-001 | The reason "the token cannot make a Messages API call" is wrong: the limit is that the token is for Claude Code sessions | Fixed in the planner error, the provider backstop, the schema comment, ARCHITECTURE and the test name |
| LOW-002 | The no-token test failed for an operator who had exported the token | Fixed. The test clears the variable itself and also calls `credentials()` with an injected env. It passes with `CLAUDE_CODE_OAUTH_TOKEN` set: 38 of 38 |
| LOW-003 | Managed settings can put an API key ahead of the token, and `run.json` would still say subscription | Fixed. When the init message's `apiKeySource` is not `none` on this provider, the trial is a non-retried infra error. Three mutants are killed |
| LOW-004 | `credentials()` was exported with an `env` parameter that nothing used | Used: the tests call it with an injected env (see LOW-002) |
| INFO-001 | `concurrency` defaults to 4 against plan rate limits | Documented: README and ARCHITECTURE say to keep it low. No code change |

## Test evidence

| PE | Test budget | Evidence |
| - | - | - |
| PE-Vue | targeted | `npm run typecheck` exit 0 at `c086564`; targeted tests 78/78 with the token unset; a probe reproduced LOW-002 |

After the fixes, at `7213d6e`:

- `npm run check` exit 0.
- `npm test` tests 603, pass 598, fail 0, skipped 5.
- The harness tests with `CLAUDE_CODE_OAUTH_TOKEN` set: pass 38, fail 0.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
