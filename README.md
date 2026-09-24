# litmus

[![License: MIT](https://img.shields.io/badge/License-MIT-informational.svg)](./LICENSE)

A test runner for LLM and agent evals. Point it at a suite and pick a model.
Every case turns green, red or amber as it runs, the way a unit-test runner
reports a test suite. The difference is that each case runs several times, so
"flaky" is a first-class answer.

Litmus exists to answer one question: **when a new model ships, what did it
break?** Skills, rules, agent definitions and prompts are written against a
model. When the model changes, the same instructions can change meaning. A
code-review skill that was sharp on one model can spiral into rounds of
nitpicks and wrong findings on the next. A unit test catches that kind of
change in code. For the instructions that govern an agent, today's tools check
one model at a time. Litmus puts two models side by side and tells you which
cases flipped.

> **Status: pre-release.** Litmus is being built in the open, milestone by
> milestone — [docs/PLAN.md](docs/PLAN.md) says what exists and what is next.
> Anything below that the plan has not reached yet is described as intent.

## What it does

- **Runs everything, a selection or a single case.** A suite is a tree: suite →
  case → configuration → trial. You can run the whole tree, one suite, a
  selection, one case or one trial, or only what failed or was flaky last time.
- **Shows progress live.** Each trial moves from queued to running to settled,
  with its time, tokens and cost counting up. Agentic trials take minutes, so
  you can see which step one is on.
- **Gives verdicts that admit uncertainty.** A case runs N trials, and its
  policy decides how they add up:
  - Under `all`, the default, a case is PASS when every trial passes, FAIL
    when none do, and FLAKY when some do.
  - Under `rate`, for capability suites, a mixed result can still be PASS,
    once the pass rate clears its threshold with 95% confidence. Until then
    the case is INCONCLUSIVE.
  - Under either policy, a case is ERROR when the infrastructure failed rather
    than the model.
- **Compares models.** Run the same suite across models, providers and effort
  levels. Litmus reports which cases flipped and whether the difference is
  real or noise, not just whether the average moved.
- **Lets you inspect any trial.** Open one and you get its full transcript,
  each grader's result and reasoning, expected against found, and its cost.

## What it runs against

Litmus doesn't depend on any one vendor. An **executor** turns a case into a
transcript, and a **provider** supplies the model.

| Executor | Runs | Use it for |
| - | - | - |
| `model` | One model call through a provider API | Prompts, system instructions, review of inlined code |
| `harness` | A real agent CLI, headless. Claude Code comes first | Plugins, skills, subagents, `CLAUDE.md` or `AGENTS.md`, hooks: anything that only behaves correctly inside the harness that loads it |

| Provider | Covers |
| - | - |
| `anthropic` | The Anthropic API |
| `bedrock` | Claude on AWS Bedrock |
| `openrouter` | Every model OpenRouter serves |
| `fake` | Scripted responses, for tests and demos. It costs nothing |

Each run records and pins its provider. The same model served by two
providers shows up as two columns in a comparison, not one.

## The first real suite: seeded-bug code review

The suite is a set of small codebases, each with a known list of bugs. It also
includes clean changes with nothing to find, and decoys: code that looks wrong
but isn't. A reviewer can be a model, an agent or a review skill running inside
a harness. It is scored on:

| Signal | Question it answers |
| - | - |
| Recall | How many seeded bugs did it find, by severity? |
| Precision | How much of what it reported was real? |
| Noise | How many nitpicks did it make, and did it flag the decoys? Both can be capped |
| Claim correctness | When it found a bug, was its explanation of the bug right? Checked by a pinned judge |
| Speed and cost | How long did it take, and how many tokens and dollars did it use? |

Every seeded bug ships with a proof test. The test fails while the bug is
present and passes once its fix is applied, and `litmus validate` checks both.
Proof tests are kept outside the fixture, so the reviewer never sees them. A
bug nobody can demonstrate doesn't belong in the ground truth.

## Public runner, private suites

Litmus is MIT-licensed and public. **A suite you use to decide on a model
rollout should not be.** Once seeded bugs are published, the next model may be
trained on them, and a benchmark that a model has memorized measures its memory,
not its reviewing.

Litmus loads suites from any directory you list in `litmus.config.yaml`, so
the suites you gate on can live wherever you keep private code. The suites in
this repository are examples, canaries and demonstrations. None of them should
gate a release.

## How it relates to other tools

`claude plugin eval` checks a Claude Code plugin against one model, and litmus
doesn't replace it. Litmus answers the questions it leaves open:

- how one model compares with another
- how one provider compares with another
- whether a difference is real or noise
- what is happening while the run is in progress

Frameworks such as Inspect AI and promptfoo run evals well. None of them
combines paired model comparison, flaky and inconclusive verdicts, and a runner
you can start, cancel and rerun from.
[docs/research/](docs/research/) holds the survey behind that claim.

## Docs

| Doc | What's in it |
| - | - |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Concepts, data contracts, and how a run flows |
| [docs/PLAN.md](docs/PLAN.md) | Milestones, each with the checks that mean it is done |
| [docs/adr/](docs/adr/) | Decisions and the reasoning behind them |
| [docs/research/](docs/research/) | The survey of existing tools, benchmarks and scoring methods |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to propose and land a change |
| [SECURITY.md](SECURITY.md) | The threat model, and how to report a vulnerability |

## License

MIT. See [LICENSE](LICENSE).
