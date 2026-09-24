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
| Review routing (paths → stack → reviewer → test commands) | `.code-reviewer.yml` |

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

| A trial stopped because of | `exit` | Retried | Trial status |
| - | - | - | - |
| Throttling (408, 409, 429), 5xx, network | `infra_error` | Up to `retries`, with backoff | `error` once the retries run out, never `fail` |
| Auth failure, other 4xx, missing key | `infra_error` | Never | `error`, never `fail` |
| Timeout or max turns | `model_failure` | Never | `fail` |
| The operator cancelling | `cancelled` | Never | `cancelled` |

A case verdict comes from all of its trials, following ARCHITECTURE.md
§ Verdicts. It is never taken from a single trial.

```
if a review finding lands on code under a case's fixture/:
    if it matches a truth.yaml bug or decoy:
        expected: never edit the fixture (fixes live in fix/ as patches)
    elif the code runs on the operator's machine (proof, validate, command grader)
         or reads outside its workdir:
        a real security finding, never a false positive
    else:
        an unlisted bug: add it to truth.yaml as a bug or a decoy, then re-run validate

if a subject could read anything in the case directory outside fixture/ and change.patch:
    isolation is broken: fix the layer that leaked
        (workdir builder, {{fixture}} renderer, or gate path confinement)
    never weaken the case
    exception: allow_shell, allow_hooks and command graders are uncontained by design (SECURITY.md)

if adding a tool, a capability or a path classification to the harness gate:
    it is refused by default and allowed explicitly
    never weaken the gate to make a test pass

if a PR comes from a fork or an outside contributor:
    the operator reads the whole diff before any command from it runs
        # npm ci, npm test, validate and /code-reviewer:code-reviewer all execute PR-controlled code
```

Workdirs live under `os.tmpdir()`. They are never under `.litmus/`, a suite
root, or any directory with a `CLAUDE.md` or `AGENTS.md` in its ancestors.

## Workflow

```
for each change:
    branch from main: m<N>-<slug> for PLAN milestones, else <type>/<slug>
    small commits, each passing npm run check && npm test
    PR -> /code-reviewer:code-reviewer until APPROVED
       -> resolve every external review thread
          if that added a commit: re-run /code-reviewer:code-reviewer until APPROVED at HEAD
       -> green CI -> gh pr merge --squash --delete-branch
never push to main   # the ruleset refuses it
```

| External thread from | Resolve by |
| - | - |
| A bot (Copilot) | Fix it and reply with the fixing commit, or reply with why not, then resolve it |
| A human | Fix it and reply with the fixing commit, then resolve it. If you disagree, reply with why and leave the thread open for the reviewer |

`/code-reviewer` comes from the `lafollett-labs-claude-plugins` marketplace.

Commit subjects, and PR titles, use `<type>: <imperative summary>`, where the
type is one of `feat`, `fix`, `docs`, `test`, `refactor`, `chore` or `ci`. A
commit subject can be up to 72 characters. A PR title can be up to 65, because
it becomes the squash commit's subject on `main` with ` (#N)` appended. The
body says why.

## Claims

Every "tested" / "verified" / "works" includes the exact command and its
output. A count beats an adjective.
