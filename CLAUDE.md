# litmus

Eval runner for LLMs and agents: suite → case → config → trial, live status,
statistical verdicts, pluggable executors and providers. Public, MIT.
TypeScript on Node 26, Vue 3 UI.

## Sources of truth

| What | Where |
| - | - |
| Schemas, sandbox, events, API, verdict rules | `docs/ARCHITECTURE.md` |
| What to build next; when a milestone is done | `docs/PLAN.md` |
| Why a decision was made | `docs/adr/` |
| Commands, dependencies | `package.json` |

A change to a contract updates `docs/ARCHITECTURE.md` in the same PR.

## Runtime

Chain nvm into every command, because shell state does not carry between
calls: `source ~/.nvm/nvm.sh && nvm use && npm run check && npm test` (`.nvmrc`
pins 26). `.ts` runs by type stripping: imports carry `.ts`, and only erasable
syntax compiles.

## Hard rules

Never commit a gating suite (any suite used to decide a model rollout), keys,
tokens, or run output (`.litmus/`).

Tests never spend money. They use the fake provider, a mocked SDK, a mocked
`fetch`, or a scripted `query()` stream. Live tests run only when
`LITMUS_LIVE=1`.

Code under a case's `fixture/` is test data. Its bugs and decoys are listed in
that case's `truth.yaml`. Never edit a fixture to fix one (fixes live in `fix/`
as patches), and treat a review finding on fixture code as a false positive.

| A trial stopped because of | `exit` | Retried | Trial status |
| - | - | - | - |
| Throttling, 5xx, network or auth failure | `infra_error` | Up to `retries`, with backoff | `error` once the retries run out, never `fail` |
| Timeout or max turns | `model_failure` | Never | `fail` |
| The operator cancelling | — | Never | `cancelled` |

A case verdict comes from all of its trials, following ARCHITECTURE.md
§ Verdicts. It is never taken from a single trial.

```
if a subject could read truth.yaml, proof/, fix/ or fake.yaml:
    isolation is broken: fix the layer that leaked
        (workdir builder, {{fixture}} renderer, or gate path confinement)
    never weaken the case
    exception: allow_shell, allow_hooks and command graders are uncontained by design (SECURITY.md)

if adding a tool, a capability or a path classification to the harness gate:
    it is refused by default and allowed explicitly
    never weaken the gate to make a test pass

if a PR comes from a fork or an outside contributor:
    read the whole diff before running any command from it
        # npm ci, npm test and validate all execute PR-controlled code in your environment
```

Workdirs live under `os.tmpdir()`, never under `.litmus/`, a suite root, or
any directory with a `CLAUDE.md` in its ancestors.

## Workflow

```
for each change:
    branch from main: m<N>-<slug> for PLAN milestones, else <type>/<slug>
    small commits, each passing npm run check && npm test
    PR -> /code-reviewer:code-reviewer until APPROVED -> resolve every external review thread
       -> green CI -> gh pr merge --squash --delete-branch
never push to main   # the ruleset refuses it
```

Resolving an external review thread (Copilot or a human) means fixing it and
replying with the fixing commit, or replying with why not, and then resolving
it. `/code-reviewer` comes from the `lafollett-labs-claude-plugins`
marketplace.

Commit subject: `<type>: <imperative summary>`, where the type is one of
`feat`, `fix`, `docs`, `test`, `refactor`, `chore` or `ci`. Keep it to 72
characters. The body says why.

## Stack Map

| Path | Stack | PE | Test Command |
| - | - | - | - |
| `src/server/**` | TypeScript, Node 26, HTTP + SSE | `pe-vue` | `npm run check && npm test && npm run test:ui` |
| `src/**`, `test/**` | TypeScript, Node 26 | `pe-vue` | `npm run check && npm test` |
| `ui/**` | Vue 3, Vite, TypeScript | `pe-vue` | `npm run check && npm run test:ui` |
| `.github/workflows/**` | GitHub Actions | `pe-aws-infra` | `actionlint` |
| `suites/**` | Eval fixtures, YAML | Generic | `node src/cli/main.ts validate` |
| `CLAUDE.md` | Agent governance markdown | `pe-governance` | n/a |
| `README.md`, `docs/**`, other `*.md` | Human docs | Generic | n/a |

## Claims

Every "tested" / "verified" / "works" includes the exact command and its
output. A count beats an adjective.
