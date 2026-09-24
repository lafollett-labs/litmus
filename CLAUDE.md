# litmus

Eval runner for LLMs and agents: suite → case → config → trial, live status,
statistical verdicts, pluggable executors and providers. Public, MIT.
TypeScript on Node 26, Vue 3 UI.

## Sources of truth

| What | Where |
| - | - |
| Schemas, events, API, verdict rules | `docs/ARCHITECTURE.md` |
| What to build next; when a milestone is done | `docs/PLAN.md` |
| Why a decision was made | `docs/adr/` |
| Commands, dependencies | `package.json` |

A change to a contract updates `docs/ARCHITECTURE.md` in the same PR.

## Runtime

Run `nvm use 26` first: `.ts` runs by type stripping, so imports carry `.ts`
and only erasable syntax compiles. Run `npm run check && npm test` before
claiming a change works, plus `npm run test:ui` when `ui/` or `src/server/`
changed.

## Hard rules

```
never commit here:
    a gating suite — any suite used to decide a model rollout
    keys, tokens, or run output (.litmus/)

tests never spend money:
    tests use the fake provider
    live tests run only when LITMUS_LIVE=1, skipped otherwise

if a subject under test could read truth.yaml, fix/, or fake.yaml:
    isolation is broken — fix the workdir builder, never the case

match why a trial stopped:
    throttle | 5xx | network | auth    -> infra_error   -> retried -> ERROR, never FAIL
    timeout | max turns | bad output   -> model_failure -> FAIL, never retried

harness gate is default-deny:
    new tool or capability -> refused unless explicitly allowed
    never weaken the gate to make a test pass
```

## Workflow

```
for each change:
    branch from main: m<N>-<slug> for PLAN milestones, else <type>/<slug>
    small commits, each passing npm run check && npm test
    PR -> /code-reviewer:code-reviewer -> green CI -> gh pr merge --rebase --delete-branch
never push to main directly
```

Commit subject: `<type>: <imperative summary>` — type is one of feat, fix,
docs, test, refactor, chore, ci — at most 72 chars; the body says why.

## Stack Map

| Path | Stack | PE | Test Command |
| - | - | - | - |
| `src/**`, `test/**` | TypeScript, Node 26 | `pe-vue` | `npm run check && npm test` |
| `ui/**` | Vue 3, Vite, TypeScript | `pe-vue` | `npm run check && npm run test:ui` |
| `.github/workflows/**` | GitHub Actions | `pe-aws-infra` | `actionlint` |
| `suites/**` | Eval fixtures, YAML | Generic | `node src/cli/main.ts validate suites/examples` |
| `CLAUDE.md` | Agent governance markdown | `pe-governance` | n/a |
| `README.md`, `docs/**`, other `*.md` | Human docs | Generic | n/a |

## Claims

Every "tested" / "verified" / "works" includes the exact command and its
output. A count beats an adjective.
