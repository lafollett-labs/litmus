# Code Review: m2-providers

**Verdict:** 🔁 CHANGES REQUESTED (round 1, locked to `1965d54`)

| | |
| - | - |
| **Branch** | `m2-providers` (Gate 1, local, before any PR) |
| **Reviewer** | @Cali LaFollett (PE-Vue) |
| **Review Round** | 1 |
| **Reviewed SHA** | `1965d54` |
| **Title** | M2: providers |
| **Date** | 2026-09-24 |

---

## Summary

PE-Vue probed the real SDK clients over a mocked fetch, with no provider calls and no AWS credential chain resolved. It read the SDK sources for every behaviour the code relies on, and checked OpenRouter's documented error shapes against its docs. Its checks: `npm run check` is clean; 109 tests pass and 3 (live) are skipped; `npm audit` finds 0 vulnerabilities.

The four HIGHs share one cause. The tests injected `Send` or a stub `fetch`, so they never met the error shapes the real SDK produces:

- MessageStream's re-wrapped failures were read as missing credentials.
- The SDK's credential fallbacks went unnoticed.
- OpenRouter's 200-with-error bodies were graded as answers.
- A failed body read escaped as a raw TypeError.

## Findings Overview

| Severity | In Scope | Out of Scope |
| - | - | - |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 4 | 0 |
| 🟡 MEDIUM | 2 | 0 |
| 🟢 LOW | 6 | 0 |
| ℹ️ INFO | 1 | 0 |

## Findings and dispositions

| ID | Finding | Disposition |
| - | - | - |
| HIGH-001 | A dropped connection, a stream that ends early, or malformed SSE was classified as "no usable credentials", not retryable | Fixed in `702b28f`: any other SDK error is "stream failed" (retryable). Credentials are recognised only by a `CredentialsProviderError` in the cause chain. `test/providers/stream.test.ts` runs `streamingSend` over the real Anthropic and Mantle clients. Mutation check: putting the old branch back fails 2 of its 8 tests |
| HIGH-002 | `new Anthropic()` fell back to `ANTHROPIC_AUTH_TOKEN` or a login profile whose `base_url` redirects traffic | Fixed in `5a5dcf7`: the client gets an explicit `apiKey` and `authToken: null`, and without `ANTHROPIC_API_KEY` the provider fails every call as not retryable, sending nothing. A test covers no key, an auth token only, and a profile only |
| HIGH-003 | An OpenRouter 200 with no answer was graded as the model's FAIL | Fixed in `2472d6f`: a choice-level error, `finish_reason: error`, no choices, and `{}` are all InfraErrors classified by code. A top-level 401 or 402 is not retried |
| HIGH-004 | A body-read failure or a non-object body escaped as a raw TypeError | Fixed in `2472d6f`: `res.text()` is inside the connection try, and the body must be an object |
| MEDIUM-001 | A region-less Bedrock config threw a raw AnthropicError from the constructor | Fixed in `5a5dcf7`: the region resolves from the config, then `AWS_REGION`, then `AWS_DEFAULT_REGION`. With none, it is a ConfigError at `createProvider` |
| MEDIUM-002 | `streamingSend` was never run against the SDK, and fake was not fully covered | Fixed: the real-client stream tests (`702b28f`); a delay that runs out leaves no listener, and a missing, unparseable or ambiguous fake.yaml is a ConfigError (`cce68b1`) |
| LOW-001 | Anthropic `fallbacks` and `openrouter/auto` were accepted | Fixed in `fa096af`: both are refused at load. Routing between hosts of the same model stays on, and ARCHITECTURE says so |
| LOW-002 | The pricing fallback's "upper bound" claim is false for cache writes | Fixed in `4152269`: the doc now calls it approximate, with the direction of each error |
| LOW-003 | `stream` passed through, and effort overwrote `params.reasoning` | Fixed in `2472d6f` |
| LOW-004 | BYOK cost reported only OpenRouter's fee, and `usage.include` is deprecated | Fixed in `2472d6f`: `upstream_inference_cost` is added when `is_byok`, and the dead field is dropped |
| LOW-005 | A fake entry could set both `text` and `text_file` | Fixed in `cce68b1` |
| LOW-006 | A mid-stream `billing_error` retried, and the request id was dropped | Fixed in `702b28f` |
| INFO-001 | `priced()` looked up prototype keys | Fixed in `5a5dcf7`: `Object.hasOwn` |

Every fix commit passes check and test on its own (119 to 127). At the tip, 127 pass and 3 (live) are skipped.

## Merge Eligibility

**Locked to SHA:** `1965d54`. The fix commits after it are re-reviewed in round 2.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
