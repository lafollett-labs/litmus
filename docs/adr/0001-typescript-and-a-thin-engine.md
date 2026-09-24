# 0001: TypeScript on Node 26, with a thin engine of our own

Status: accepted, 2026-09-24

## Context

The [landscape survey](../research/2026-09-eval-landscape.md) left one decision
open. Litmus could either run on Inspect AI, with Inspect SWE driving Claude
Code, or use a thin engine of its own over the vendor SDKs. The survey
recommended a one- or two-day spike to decide.

Litmus is **a runner people interact with**: select, run, watch, cancel, rerun
one trial, compare. Inspect's unit of work is a batch evaluation that writes a
log, which a viewer then reads. Built on Inspect, litmus would still need its
own server, event stream, scheduler control and UI. What Inspect would add is
its provider layer, its sandboxes, and its statistics: epochs, pass^k and
bootstrap errors.

## Decision

Litmus is written in TypeScript and runs on Node 26 by type stripping. That is
the toolchain Riff already uses: tsgo, `node --test`, Vue 3 with Vite, zod and
Playwright. Litmus has its own engine and calls the vendor SDKs directly:

| Need | Uses |
| - | - |
| Anthropic API | `@anthropic-ai/sdk` |
| Claude on Bedrock | `@anthropic-ai/bedrock-sdk` |
| OpenRouter | Its OpenAI-compatible HTTP API, over `fetch` |
| Claude Code as a harness | `@anthropic-ai/claude-agent-sdk` |

## Why

- **The interactive runner is the product.** Wrapping a batch engine means
  building the whole live layer anyway, and then working against the engine's
  lifecycle whenever a user runs one case or cancels a run.
- **The Claude Agent SDK is TypeScript-first.** Riff already runs it behind a
  default-deny tool gate, which litmus's harness gate follows.
- **The statistics are small.** The Wilson interval, the pass@k and pass^k
  estimators and a seeded paired bootstrap come to a few hundred lines of code
  with tests that check them against hand-computed values.
- **Review coverage.** LaFollett Labs' review agents cover TypeScript and Vue.
  None covers Python.

## Costs we accept

- **We own the provider adapters.** The survey warns that each new model
  generation breaks adapters that tools write themselves. To limit that:
  - Each adapter is one file.
  - Errors are classified at the boundary.
  - Parameters specific to one provider pass through untouched.
  - A live smoke test per provider runs when `LITMUS_LIVE=1`.
- **There are no ready-made sandboxes.** Harness trials run in a disposable
  workdir behind a default-deny gate. Shell access stays off unless a case
  asks for it. A container-backed executor comes after 0.1.
- **Inspect's log tooling won't read litmus runs.** An exporter can be added if
  someone needs it.

## Revisit when

- Adapter churn costs more than a day per model release.
- Or a suite needs a sandbox the gate can't provide.
