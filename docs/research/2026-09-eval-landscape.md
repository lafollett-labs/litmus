# Eval landscape, September 2026

> Research snapshot compiled on 2026-09-23 by research agents; citations were
> not independently re-verified. One recommendation is superseded: litmus has its
> own runner UI rather than a VS Code Test Explorer adapter, and its engine is
> decided in [ADR 0001](../adr/0001-typescript-and-a-thin-engine.md).

No existing tool answers LaFollett Labs' question from start to finish, but most of the parts already exist. The right move is a thin eval-runner repo that owns only what nobody sells: a private seeded-bug corpus, a calibrated scorer, a statistical verdict policy, and an eval-aware Test Explorer. Anthropic's `claude plugin eval` (Claude Code v2.1.269, September 11, 2026) comes closest, and its docs name "a new model ships" as a use case. But it runs one model per invocation. Its delta compares plugin against no plugin, not model against model. It reports no confidence intervals, allows no custom-code graders, and strips the project `CLAUDE.md` that a routing `/review` skill depends on. Among general frameworks, only promptfoo, Inspect AI (with Inspect SWE) and Harbor can drive real Claude Code. Only Inspect computes pass^k and bootstrap errors natively. The research found no tool that puts eval cases in VS Code's Test Explorer with scores or flaky status. Public review benchmarks (Martian, Qodo PR-Review-Bench, SWR-Bench, MCR-Bench) supply schemas, judge pipelines and calibration data. But they are public, so contamination is likely. None has ground truth for Vue, and they rarely measure whether multi-round review converges. The incident itself has a documented mechanism, laid out in the section on scoring below. So the eval has to score recall, precision, whether each claim is correct, noise, convergence and cost as separate signals. It should compare models on paired per-case trials with the judge and effort level pinned, and report which bugs each model caught or missed instead of one average. Start using `claude plugin eval` this week for cheap behavioral checks on every skill. Then build the review bench on borrowed execution, statistics, schemas and report formats.

## `claude plugin eval` covers every skill cheaply but cannot compare two models

Anthropic shipped the closest first-party answer on **September 11, 2026**: `claude plugin eval`, in Claude Code v2.1.269 ([MarkTechPost](https://www.marktechpost.com/2026/09/11/anthropic-adds-plugin-evals-to-claude-code-6-grader-types-a-no-plugin-baseline-and-a-ci-gate-for-skills/)). Each case runs in a fresh, isolated headless session with only the plugin loaded, **three runs with the plugin and three without** by default. Six grader types score each run. Four are free: `regex`, `tool_used`, `tool_order` and `file_exists`. Two use a judge model: `llm`, which passes on two of three votes, and `baseline`, which compares the run against a reference transcript. A run's score is the fraction of graders it passed, and a case passes when it meets `--threshold` (1.0 by default). Results land in an additive-only `aggregate-result.json` and a self-contained `report.html`, with exit codes a CI job can gate on. The docs name the motivating scenario outright ("catch regressions when you change the plugin or a new model ships"). They tell CI users to pin both the agent and judge models "so a model rollout isn't mistaken for a plugin regression" ([plugin eval docs](https://code.claude.com/docs/en/plugin-evals)). The docs' example case cost **$0.41 for six runs**.

The fit breaks down exactly where the incident lives. `--model` sets one model per invocation, and the built-in delta measures plugin versus no plugin. Comparing Opus 4.8, 5 and 5.5 therefore means three runs and a hand-written diff. The harness "gives no interval, no margin and no A/B of two versions of the same plugin" ([skill-tuner #52](https://github.com/StartupBros-com/skill-tuner/issues/52)). Because "there are no custom-code graders," findings cannot be matched against a seeded-bug list inside it.

Isolation removes more than you might expect. **User settings, hooks, `CLAUDE.md` files, MCP servers, other plugins, memory and skills are all absent**, and a review skill that routes by a Stack Map reads exactly that context. The defaults of `max_turns: 10` and `timeout_seconds: 300` cut off a multi-round review unless raised (the caps are 200 and 3600). An `llm` judge pointed at the trace sees only the first 12 and last 12 messages, so it misses churn in the middle of the loop, though a `regex` grader over the trace does not. A usage limit hit mid-suite scores every later run near 0 without marking the result `partial`, "so the result can look like a regression" ([plugin eval docs](https://code.claude.com/docs/en/plugin-evals)). No effort flag is documented, even though Opus 5.5 moved the default effort from `high` to `medium` ([Prompting Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)). The command is still behind an early-access server flag, and its first release shipped a case-format bug that contradicted the docs ([orcastrate #7](https://github.com/jpe0824/orcastrate/issues/7)).

None of this disqualifies it for the broad, cheap layer. The free graders can already detect a spiral:

- `tool_used` on `Agent` with a `max:` cap bounds how many subagents get dispatched.
- `regex` with `count:N` bounds the number of findings.
- `not_contains` catches known false findings.

The rest of first-party and community tooling fills gaps without closing them. `/skill-doctor` reports each skill's context cost and how often it is invoked. That is a hygiene check and says nothing about behavior ([Skills docs](https://code.claude.com/docs/en/skills)). The skill-creator skill runs its own with-skill and baseline loop on a separate `evals/evals.json` format ([plugin eval docs](https://code.claude.com/docs/en/plugin-evals)). The community moved within days to add the missing statistics:

- **adewale/skill-eval-harness** pairs each case, model and repetition across with-skill, without-skill, old-skill and ablation arms. It has runners for Claude, Codex and Gemini, and reports per-model lift, sign-flip permutation significance, pass@k, pass^k, and flaky or saturated cases ([skill-eval-harness](https://github.com/adewale/skill-eval-harness)).
- **skill-tuner** proposes reading `aggregate-result.json` and adding bootstrap confidence intervals, sign tests and a candidate-versus-baseline compare ([skill-tuner #52](https://github.com/StartupBros-com/skill-tuner/issues/52)).
- **skills-evals** gives each case-and-model pair a verdict of regressed, improved, insufficient or stable ([skills-evals #121](https://github.com/Adam-S-Daniel/skills-evals/issues/121)).

All three are young, and their production use is unknown. Other vendors follow the same pattern: a headless run produces a JSONL trace, deterministic checks and a rubric judge grade it, and a CI gate decides. OpenAI publishes a recipe for testing Codex skills through `codex exec --json` ([OpenAI](https://developers.openai.com/blog/eval-skills)). gemini-cli splits its behavioral suite into `ALWAYS_PASSES` cases that must pass on every PR and `USUALLY_PASSES` cases that run nightly, explicitly to assess "feature reliability by model" ([gemini-cli evals](https://github.com/google-gemini/gemini-cli/blob/main/evals/README.md)).

Among general-purpose frameworks, **only three run Claude Code itself as the system under test**:

- promptfoo's `anthropic:claude-agent-sdk` provider. Its `setting_sources` key turns on `CLAUDE.md` discovery, it loads plugins and filters skills, and it exposes `metadata.skillCalls` for assertions ([promptfoo provider](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/)).
- Inspect AI with Inspect SWE. Inspect SWE runs `claude_code()` inside a Docker sandbox and routes its model calls back through Inspect, so any model can drive an unchanged harness ([Inspect SWE](https://meridianlabs-ai.github.io/inspect_swe/)).
- Harbor, the Terminal-Bench harness, via `--agent claude-code` ([Harbor](https://github.com/harbor-framework/harbor)).

Braintrust, LangSmith, Langfuse, Phoenix, Weave, Opik, DeepEval and Pydantic Evals all expect you to write the task function yourself: set up a fixture, call the agent, return a transcript. That is most of the harness work.

Ownership and reliability also matter. **OpenAI acquired promptfoo in March 2026** ([TechCrunch](https://techcrunch.com/2026/03/09/openai-acquires-promptfoo-to-secure-its-ai-agents/)). It is steering users of its hosted Evals product to promptfoo before shutting that product down on November 30, 2026 ([OpenAI deprecations](https://developers.openai.com/api/docs/deprecations)). Scorer bugs that report a false pass shipped across tools this month. DeepEval inflates a truncated verdict list to a perfect 1.0 ([deepeval #3358](https://github.com/confident-ai/deepeval/issues/3358)). promptfoo scores a dead endpoint clean on 130 of 138 graders ([promptfoo #11041](https://github.com/promptfoo/promptfoo/issues/11041)). Whatever tool is chosen needs canary cases that are supposed to fail.

| Requirement | `claude plugin eval` | promptfoo Claude Agent SDK provider | Inspect AI + Inspect SWE |
| - | - | - | - |
| Loads project `CLAUDE.md` in place | No, removed by design | Yes, via `setting_sources` | Not verified |
| Loads the plugin and its skills | Yes | Yes (`plugins`, `skills`) | Not verified |
| Custom-code scorers | No | Yes (`javascript` assertions) | Yes (Python scorers) |
| Repeated trials | `runs` (default 3) | `--repeat` | `epochs` |
| pass^k and intervals | No | No | `pass_k_{k}`, bootstrap and clustered stderr ([Inspect metrics](https://inspect.aisi.org.uk/metrics.html)) |
| Model-vs-model view | One model per run, diff by hand | Provider × test matrix, Compare view | Join `evals_df` / `samples_df` by sample |
| Live progress | CLI output | CLI progress bars; the viewer needs a refresh (per a third-party tutorial, not official docs) | Live viewer, sample by sample |
| Owner and license | Anthropic, early access | OpenAI, MIT | UK AISI / Meridian Labs, MIT |

## No test explorer understands a score, a flaky case, or a trial

The research found no eval tool that registers its cases in VS Code's Test Explorer with anything richer than pass or fail. Evals appear there only by accident, when they are written as ordinary pytest or Vitest tests (DeepEval, vitest-evals, LangSmith's pytest plugin). When that happens, the score, rationale and trace drop out of the tree. The richer interfaces live in the browser:

- **Inspect View** offers "a live view into the status of your evaluation task" with metrics that update as samples finish. Each sample drills down into three tabs (Messages, Scoring, Metadata). Samples can be sorted by epoch to compare how consistent trials were, and a static `view bundle` exports the whole thing ([Inspect View](https://inspect.aisi.org.uk/log-viewer.html)). Its VS Code extension adds a Tasks tree and run/debug buttons, but as a custom view rather than a Test Explorer integration ([Inspect VS Code](https://inspect.aisi.org.uk/vscode.html)).
- **promptfoo's viewer** is strongest at matrix comparison (prompt × provider × case). It has filters for failures and "Different" rows, a score histogram, and a Compare diff between two evals ([promptfoo viewer](https://www.promptfoo.dev/docs/usage/web-ui/)).
- **vitest-evals** emits JUnit XML plus JSON, serves a local React viewer and posts GitHub Check Runs ([vitest-evals](https://github.com/getsentry/vitest-evals)). Its author built it because "just about everything is coupled to some third party service, frankly for no reason at all" ([cra.mr](https://cra.mr/vitest-evals/)).
- **Evalstand** makes each case-and-repeat pair one test item, "so `-k`, `-x`, `--lf` all work" ([Evalstand](https://github.com/MiltonKlun/Evalstand)). This is the most reusable pattern of the four.

VS Code's Testing API supplies nearly everything a VS.NET-style runner needs:

- a tree of test items whose children can load lazily
- live state changes (enqueued, started, passed, failed) with durations
- a `busy` spinner and output streamed per test
- markdown messages and expected-versus-actual diffs
- tags, continuous runs, and context-menu actions on messages ([vscode.d.ts](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts))

Two details matter most for evals. A message can be attached to a passed test "to denote a diagnostic message," so a judge's rationale survives a pass ([VS Code API](https://code.visualstudio.com/api/references/vscode-api)). And test runs created from the same request are grouped together, which the API describes as useful when "a single suite of tests is run on multiple platforms". That maps directly to one named run per model.

The hard limit is the set of result states. **It is a closed six-value enum (Queued, Running, Passed, Failed, Skipped, Errored) with no state for a score, a partial result, a flaky case or an inconclusive one.** The only proposed testing APIs add nothing there ([testObserver proposal](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.testObserver.d.ts)). Scores and flakiness therefore have to live in labels, descriptions, tags and child items. A model × case matrix or a transcript viewer needs a companion webview.

| Eval concept | Where it goes in the Testing API |
| - | - |
| Suite > case > trial | Test items with children, loaded lazily |
| Model under test | One named test run per model, all from the same request |
| Score, trial tally, cost, time | `description`, e.g. "0.82 · 4/5 · $0.03 · 94s" |
| Flaky | A `flaky` tag |
| Judge rationale | Markdown message, attached even on pass |
| Expected vs found bugs | `TestMessage.diff` |
| Infrastructure failure vs model failure | `errored()` vs `failed()` |
| Transcript, model × case matrix | Companion webview |

Report formats split the same way. **JUnit XML** has no score field, and it records flakiness only through Maven Surefire's non-standard `flakyFailure` elements, which CI tools support unevenly ([Surefire](https://maven.apache.org/surefire/maven-surefire-plugin/examples/rerun-failing-tests.html)). **CTRF** is the best fit for a CI artifact. It has native `flaky`, `retries` and `retryAttempts` fields, but `additionalProperties: false` means scores must go into its `extra` object ([CTRF schema](https://github.com/ctrf-io/ctrf/blob/main/schema/ctrf.schema.json)). OpenTelemetry's `gen_ai.evaluation.result` event is the only standard with native score, label and explanation fields ([OTel GenAI events](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-events.md)). It is still in Development status with no official release, which makes it a reasonable way to stream live results into a runner but not yet a contract to depend on.

For the webview, Playwright's UI mode is the reference design. Its timeline of color-coded actions with a snapshot at each step becomes a timeline of tool calls with the context window at each step, and its Errors and Attachments tabs become the judge rationale and the files the agent produced ([Playwright UI mode](https://playwright.dev/docs/test-ui-mode)). Vitest's pairing of a live UI in watch mode with the same UI exported as one HTML file covers both local runs and CI ([Vitest UI](https://vitest.dev/guide/ui)).

Two practitioner lessons shape the rest of the design. Agentic cases are slow: AWS's DevOps Agent team found that when setup takes 20 minutes and the run another 10 to 20, developers stop testing. They built a "fork" that restarts an agent from a failing run's history at a chosen checkpoint, and they ran baselines on "the same scenario seven times" ([AWS DevOps](https://aws.amazon.com/blogs/devops/from-ai-agent-prototype-to-product-lessons-from-building-aws-devops-agent)). And a failure caused by infrastructure must never look like a model regression. That is exactly the rate-limit trap described in the previous section, so rate-limit and sandbox failures map to `errored`, never `failed`.

## Public benchmarks calibrate the scorer; only a private seeded corpus can gate a release

The open, runnable review benchmarks are good raw material:

- **Martian's Code Review Bench** (MIT). Its offline set has 50 PRs across Python, Go, TypeScript, Ruby and Java, with **173 human-verified golden comments**, each tagged with severity and category. It includes a three-model judge and a step that removes duplicate comments before scoring ([Martian](https://github.com/withmartian/code-review-benchmark)).
- **Qodo's PR-Review-Bench** (MIT). **100 PRs with 580 injected issues** across TypeScript, Python, JavaScript, C, C#, Rust and Swift. Its record schema (`file_path`, `start_line`, `end_line`, `problematic_code_snippet`, `rule_name`) can serve directly as a ground-truth format ([Qodo on Hugging Face](https://huggingface.co/datasets/Qodo/PR-Review-Bench)).
- **SWR-Bench**. Adds **500 clean PRs**, on which "any comment an ACR tool generates... is, by definition, considered a false positive" ([SWR-Bench](https://arxiv.org/html/2509.01494v2)).
- **MCR-Bench**. 2,269 multi-round review tasks in Java, C#, TypeScript, Python and JavaScript. Each defect is tracked through a lifecycle: New, Open, Resolved, Reopened ([MCR-Bench](https://arxiv.org/html/2608.27442)).
- **c-CRAB**. Scores a review by execution: a coding agent acts on the review, and hidden tests have to pass afterward ([c-CRAB](https://arxiv.org/html/2603.23448v2)).

Their headline numbers do not agree with each other. Greptile scored itself at 82% on its own benchmark. Augment re-ran the same repositories and put Greptile at 45% F-score, and it put Claude Code at **23% precision and 51% recall**, a high-recall, low-precision profile ([Augment](https://www.augmentcode.com/blog/we-benchmarked-7-ai-code-review-tools-on-real-world-prs-here-are-the-results)). DeepSource's conclusion is that on 50-PR sets "a few edge cases can swing scores by 10+ points" ([DeepSource](https://deepsource.com/blog/ai-code-review-benchmarks)).

None of these can serve as the release gate, for three reasons.

**Contamination.** Greptile's, Augment's and Martian's offline sets draw on the same five repositories. In February 2026, OpenAI stopped reporting SWE-bench Verified after frontier models reproduced gold patches verbatim ([OpenAI](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)). Martian itself warns that "public benchmarks end up in training data" ([Martian blog](https://withmartian.com/post/code-review-bench-v0)).

**Label noise.** The classic defect corpora are old and noisy. BigVul and CVEfixes labels are 25–60% accurate. A model scoring 68.26% F1 on BigVul fell to **3.09%** on the cleaned PrimeVul ([PrimeVul](https://arxiv.org/pdf/2403.18624)).

**Coverage.** No real-bug corpus exists for Vue single-file components or for C# beyond synthetic Juliet cases. The reviewer's actual lanes (Go, Vue/TypeScript, CDK infrastructure, Bash tooling, governance markdown) have to be seeded by hand.

The public sets still earn a place as a **calibration lane**. Run the team's scorer on Martian's and Qodo's sets and check that it reproduces their published orderings before trusting it on private data.

The private corpus should mix three kinds of seeded bugs, because each alone misleads:

- **Reverted real fixes** ("PR mirrors"). SWE-smith found these the most effective of its four ways to synthesize bugs ([SWE-smith](https://arxiv.org/pdf/2504.21798)). The least contaminated realistic source is the fix history of the team's own repositories, provided those repositories are private.
- **LLM-generated bug diffs**, following MegaBugFix's diff-based corruption, for volume ([MegaBugFix](https://arxiv.org/html/2606.29088)).
- **Rule-based mutants** as easy controls. Tools exist for each language: gomutants and Gremlins for Go ([gomutants](https://github.com/gomutants/gomutants)), StrykerJS and Stryker.NET ([Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/testing/mutation-testing)), cargo-mutants and mutmut. Controls are all they are good for: across 32,002 mutants, **only 9.92% were strongly coupled to real faults** ([coupling study](https://www.researchgate.net/publication/367743233_How_Closely_are_Common_Mutation_Operators_Coupled_to_Real_Faults)). Synthetic-only evaluation "dramatically overestimates model capability" ([Bigger Isn't Always Better](https://arxiv.org/abs/2606.15689)).

Each seed should come with a failing test that proves the bug is real, as c-CRAB and SWE-smith do. It also needs a fix patch, a severity and a category, stored in Qodo's schema.

To make precision measurable, the corpus also needs two kinds of case with nothing to find:

- **Clean PRs**, on which every finding counts as a false positive.
- **Decoys**: intentional patterns that look wrong but are correct. CodeRabbit flagged "over-correction of intentional patterns" as a regression in Opus 4.7 ([CodeRabbit Opus 4.7](https://www.coderabbit.ai/blog/claude-opus-4-7-for-ai-code-review)), and the OWASP Benchmark's roughly half true-negative cases set the precedent ([OWASP Benchmark](https://owasp.org/www-project-benchmark/)).

Keep the seeds private, regenerate a slice for each model release, and never publish the diffs. On size, Anthropic says "20-50 simple tasks drawn from real failures is a great start" ([Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)), while DeepSource argues for 100 or more.

Multi-round behavior needs its own fixtures, because "multi-round" covers two different failures:

- **Noise inflation.** Review unchanged or clean code again, and count the new findings that appear on code nobody touched.
- **State tracking.** Review, fix, and review again. Here a deterministic fixer, a script that applies the ground-truth fix patches for whichever seeded bugs were found, keeps fixer variance out of the reviewer's score. The eval then measures whether round N re-flags fixed issues, invents new ones, or reaches APPROVED. MCR-Bench's lifecycle states are the public precedent for scoring this.

## Score recall, noise, and convergence separately, because upgrades move them in opposite directions

The incident has a documented mechanism.

**What Anthropic's Opus 5 guidance says.** It warns that explicit verification instructions ("use a subagent to verify") "cause over-verification on Claude Opus 5". It says a review prompt that says "only report high-severity issues" gets followed "literally", so the model reports less. It adds that the model "delegates to subagents more readily" and "can also expand the scope of a task" ([Prompting Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)).

**What CodeRabbit measured.** At extra-high effort, Opus 5 caught **55.2% of known issues versus a 61.1% production baseline** and produced **92 nitpicks versus 23**. CodeRabbit called Opus 4.8 "the family's balanced option" ([CodeRabbit Opus 5](https://www.coderabbit.ai/blog/opus-5-model-review)). That contradicts Anthropic's claim that Opus 5's extra findings "are mostly real issues", and it matches the team's experience of 4.8 working and 5.0 failing.

**What controlled studies show about extra rounds.** Multi-turn review raised false positives from 5.2 to 8.5 per artifact (**+62%**) and cut precision from 0.30 to 0.20, for a recall gain of only 0.08. The authors name two mechanisms: "false positive pressure" and "review target drift" ([More Rounds, More Noise](https://arxiv.org/abs/2603.16244)). On MCR-Bench, F1 roughly halves between round 2 and round 10, and over-reviewing accounts for 27.8% of false positives ([MCR-Bench](https://arxiv.org/html/2608.27442)).

**What works instead.** Independent passes that are aggregated beat conversational rounds. Cursor runs eight parallel passes with the diff order randomized, keeps only findings a majority of passes agree on, and lifted its resolution rate from 52% to over 70% ([Cursor](https://cursor.com/blog/building-bugbot)).

**How this maps to the team's own skill.** If the `/review` skill is the team's code-reviewer plugin, its manifest describes four things: a four-pass protocol with a "mandatory adversarial re-read", reviewer subagents (PE agents) that each run a further "Self-Adversarial" pass, fan-out to those agents, and a loop that repeats "until APPROVED". Each of these is scaffolding the Opus 5 guidance or the multi-round literature flags. That is a hypothesis, not a finding. The eval's first experiment should test it with an ablation arm: the same skill with and without those passes, on each model.

Opus 5.5 muddies any before-and-after comparison. Its default effort dropped from `high` to `medium`, and "effort level names don't correspond to the same amount of thinking across models" ([Prompting Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)). A comparison that does not pin effort therefore mixes two changes. CodeRabbit's Opus 5.5 run shows what "better but questionable" looks like in numbers. At standard effort it caught **51 of 80 bugs versus the baseline's 49**, yet it **missed 9 bugs the baseline caught**. At max effort, precision fell to 35.7% and comment volume rose to 140 versus the baseline's 116 ([CodeRabbit Opus 5.5](https://www.coderabbit.ai/blog/opus-5-5-model-review)). Totals that look flat hide a substantially different set of caught bugs. **The regression signal is the per-bug list of flips between models, not the recall average.**

| Signal | Definition | Grader | Precedent |
| - | - | - | - |
| Recall | Seeded bugs matched ÷ seeded bugs, by severity | Code: file plus line window, then a judge ensemble asking "same underlying issue?" | Qodo, Martian |
| Precision | Matched findings ÷ all findings after removing duplicates; every finding on a clean PR is a false positive; reported for actionable findings and for the full stream | Judge, corrected for known judge error | Martian, SWR-Bench, CodeRabbit |
| Claim correctness | Share of matched findings whose stated mechanism is true | Narrow binary judge; executable where possible | Martian #64, c-CRAB |
| Noise | Nit ratio; findings per PR (median, p90); rate of flagging decoys; severity mix vs baseline | Judge and code | CodeRabbit nitpick counts |
| Convergence | Rounds to APPROVED; rate of hitting the round cap; re-flags of fixed bugs; new findings on unchanged code; subagent dispatches; early stops | Code, over the transcript | MCR-Bench, More Rounds More Noise |
| Informativeness | Per finding: names the failure scenario, the location, and a fix that can be acted on | Binary judges on DeepCRCEval dimensions | DeepCRCEval |
| Speed and cost | Wall-clock time, input and output tokens, tool calls, dollars | Code | Anthropic's transcript metrics |

The claim-correctness row exists because the standard method misses the incident's "wrong findings" failure mode. Martian's judge grades "finding retention, not claim correctness". A comment at the right location with a false mechanism scores the same as a correct one ([Martian #64](https://github.com/withmartian/code-review-benchmark/issues/64)).

Judges add a second blind spot: **agreeableness bias**. LLM validators "reliably confirm correct feedback but frequently fail to reject incorrect feedback" ([Beyond Consensus](https://arxiv.org/html/2510.11822v2)). A judge asked whether a finding is valid will therefore tend to approve the nitpicks and wrong claims the eval exists to catch.

The countermeasures come from Hamel Husain's judge-validation practice ([Husain FAQ](https://hamel.dev/blog/posts/evals-faq/)):

- Use binary judges, one per failure mode.
- Validate each judge on at least 50 human-labeled passes and 50 failures, and ideally 100–200 labels per failure mode.
- Report the judge's true-positive rate (TPR) and true-negative rate (TNR).
- Correct pass rates for known judge error with θ̂ = (p_obs + TNR − 1) / (TPR + TNR − 1). The judgy package computes confidence intervals for this ([judgy](https://github.com/ai-evals-course/judgy)).

Judges also drift. A pre-registered audit found that changing the judge model version shifted scores by up to **133 points on a 0–1000 scale** ([Sunkavalli](https://arxiv.org/abs/2608.29517)). Pin the judge snapshot and hash its configuration. Re-score a frozen, human-labeled anchor set whenever the judge changes. This works where naive monitoring fails: a rolling z-test raised false alarms on **75% of streams with no drift at all** ([Li](https://arxiv.org/abs/2606.15474)).

A judge from a different model family protects against a Claude judge favoring Claude's own output, but ensembles across families do not cancel biases the families share ([Who Judges Matters](https://arxiv.org/pdf/2609.17857)).

The statistics follow from the fact that trials are noisy and paired. **Compare models on the same cases, as per-case differences**, because scores on the same questions correlate between 0.3 and 0.7 across frontier models ([Anthropic stats](https://www.anthropic.com/research/statistical-approach-to-model-evals)). At the small sample sizes typical here, standard normal-approximation intervals fall short: nominal 95% intervals reached only 92.5% coverage at N=100. Beta-Binomial or Wilson intervals hold up, and the `bayes_evals` library computes them ([Bowyer et al.](https://arxiv.org/html/2503.01747)). Most of the noise between runs comes from the model answering the same case differently, not from which cases were sampled, so **more trials per case buy more power than more cases** once the cases cover the failure modes ([Wang](https://arxiv.org/abs/2512.21326)).

Report pass^k alongside the mean, because a 75% per-trial success rate becomes about 42% over three trials ([Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).

No source defines a pass/fail/flaky verdict scheme, so the runner has to compose one:

- **Per case, per model.** PASS when the interval's lower bound clears the threshold. FAIL when its upper bound falls below the threshold. FLAKY when the interval straddles it.
- **Per model pair.** REGRESSION or IMPROVEMENT when the paired interval sits entirely outside a tolerance band ±δ set by power analysis. NO CHANGE when it sits inside the band. INCONCLUSIVE when the interval is too wide to tell, which means run more trials, not that nothing changed.
- **WARN.** Raised when tokens, rounds or findings per PR move outside their band even with every check green. OpenAI's GPT-4o sycophancy failure passed offline evals that "generally looked good" ([Willison on OpenAI](https://simonwillison.net/2025/May/2/what-we-missed-with-sycophancy/)).

Split the suite as gemini-cli does. Governance rules the skill must never break (round cap, output schema, no edits) belong in an always-pass lane. Hard-bug recall is a capability lane, where a low pass rate is expected.

Add a probe for instruction sensitivity: the same fixtures under the skill's severity filter and under a "report everything" variant. That separates a model that detects less from a model that obeys the filter more literally.

## Build a thin runner that owns four things and borrows everything else

Adopting a single tool is not enough, because none of them combines all of the following:

- the real Claude Code with project `CLAUDE.md` and plugins loaded
- custom matching of findings against ground truth
- a model × effort × skill-version matrix with paired statistics
- lists of which bugs flipped between models
- a Test Explorer view

Building a whole framework is also wrong. Anthropic's advice is to "quickly pick a framework that fits your workflow, then invest your energy in the evals themselves" ([Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)). Each new model generation breaks tools that write their own model-provider adapters; Bedrock's GPT-6 variants, for example, rejected a default `temperature` in DeepEval ([deepeval #3350](https://github.com/confident-ai/deepeval/issues/3350)). The runner should therefore execute the vendor's own binary or SDK and own only four things: the corpus, the scorer, the verdict policy and the presentation layer.

| Layer | Reuse | Build |
| - | - | - |
| Skill-level behavior, all skills | `claude plugin eval` unchanged, with `--model` and `--judge-model` pinned and `--json` output per model | A join across per-model JSON that flags cases that flipped, or skill-tuner's compare |
| Agent execution | Inspect SWE's `claude_code()` if the spike passes; otherwise the Claude Agent SDK directly | Fixture setup and teardown, loading `CLAUDE.md` and plugins, pinning effort, the deterministic fixer |
| Ground truth | Qodo's schema; Martian and Qodo sets as the calibration lane; SWE-smith's PR-mirror technique; mutation tools per language | Private seeded fixtures with failing tests, fix patches, severity and category; clean PRs and decoys; a rotating slice per release |
| Judging | Martian's MIT judge and duplicate-removal pipeline; DeepCRCEval's rubric dimensions; judgy | One binary judge per failure mode, the human-labeled calibration set, the anchor set, config hashes |
| Statistics | Inspect epochs with `pass_k` and bootstrap errors, or `bayes_evals`; skill-eval-harness's pairing model | The verdict policy and the per-bug flip report |
| Presentation | Inspect View or `report.html` for transcripts; CTRF and JUnit for CI; OTel events for live streaming | A VS Code test-controller adapter plus one webview for the model × case matrix |

The one open decision is which executor to use, and a short spike should settle it. Run Inspect SWE for one or two days and check three things:

1. `claude_code()` loads the plugin and a fixture `CLAUDE.md` inside the sandbox.
2. The effort setting passes through.
3. Routing model calls through Inspect does not change behavior compared with a native run.

The research could not confirm any of the three. If the spike passes, Inspect provides trials, pass^k, bootstrap errors and a live viewer for each sample, and the Test Explorer extension becomes a thin adapter over Inspect's logs. If it fails, drive the Claude Agent SDK directly (the same SDK promptfoo's provider wraps, with documented `CLAUDE.md` discovery and plugin loading) and adopt `bayes_evals` or skill-eval-harness for the statistics. Either way, keep the executor behind a narrow interface. It takes a case, model, effort level, skill version and trial number. It returns a findings file, the transcript, token counts, wall-clock time and an exit class that separates infrastructure errors from model failures.

The first layer can ship this week inside `lafollett-labs-claude-plugins`, next to the skills it tests:

- Write a `claude plugin eval` suite for the code-reviewer skill with the three free graders described in the first section: a subagent-dispatch cap, a findings count, and known-false findings.
- Raise `max_turns` and the timeout.
- Run it once per model against two plugin checkouts, one with the adversarial passes and one without.

That tests the leading hypothesis for tens of dollars per model, before a line of the new repo exists.

The review bench is where the real cost sits. As a rough estimate, suppose a review consumes tokens the way CodeRabbit measured for Opus 5: 60.5k input and 9.5k output ([CodeRabbit Opus 5](https://www.coderabbit.ai/blog/opus-5-model-review)). At Opus 5.5's $4/$20 per million tokens ([TechCrunch](https://techcrunch.com/2026/09/22/anthropic-releases-opus-5-5-with-lower-prices-and-fable-level-performance/)), one single-pass review costs about **$0.43**. A matrix of 50 cases × 5 trials × 3 models × 2 effort levels is 1,500 runs, about **$650 before judge calls**. A multi-agent, multi-round skill plausibly costs several times that. So run a small smoke subset on every skill change and the full matrix once per model release. Archive every baseline in the repo's own storage: once an old model is retired, a baseline that cannot be re-run is the only one left. Braintrust's free tier, for comparison, keeps data for only 14 days ([Braintrust pricing](https://www.braintrust.dev/pricing)).

## Conclusion

The deeper lesson of the incident is that governance artifacts carry hidden assumptions about which model they were written for. Instructions like "adversarially re-read," "only report high severity" or "loop until approved" compensate for a particular model's weaknesses. When the model changes, the same text can turn from fix into defect, which is what Anthropic's guidance says about verification scaffolding. That changes the question a release gate should ask. "Is the skill still green?" matters less than "which compensations does this model still need?" Answering it means tagging each compensating instruction as something the eval can switch off and running those ablation arms on every release. The eval's value comes from those arms far more than from its aggregate score.

The second implication is that the industry's standard review-benchmark method would have missed this incident. A judge that credits a finding for being in the right place, and that tends to accept whatever a reviewer claims, would score confident wrong findings as hits. Flat totals would hide the bugs that swapped between versions. An eval is only as good as its ability to fail on the exact behavior that hurt you. So the first private cases should be built from the transcripts of the Opus 5 spiral itself, which is Anthropic's "start from real failures" advice applied literally. The corpus and the calibrated judges gain value with every model release; the runner and its tree view are cheap to build.
