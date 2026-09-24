# Security

Litmus runs models and agents against code, using your API keys, and records
everything they do. That raises three questions:

- where the keys go
- what a subject under test can reach
- what ends up in the results

This document states the intended answers. The mechanisms behind them are
specified in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) § Sandbox. Where a
milestone in [docs/PLAN.md](docs/PLAN.md) has not landed yet, the control is a
design commitment, not code you can check.

## Reporting a vulnerability

Open a [security advisory](https://github.com/lafollett-labs/litmus/security/advisories/new)
rather than a public issue. If you would rather not use GitHub, email
`cali.lafollett@gmail.com` with `litmus` in the subject.

There is no bounty. You will get a fast answer, and public credit unless you
would rather not have it.

## The threat model

**The subject under test is the untrusted party.** A harness trial runs an
agent with tools, and a subject that misbehaves is exactly what litmus is
meant to catch. So no instruction in a prompt counts as a control. Suites
contributed by other people are untrusted too, until you have read them.

In scope:

- A subject that reads or writes outside its trial's workdir.
- A subject that reads the case's ground truth (`truth.yaml`, `proof/`, `fix/`
  or `fake.yaml`). That invalidates the eval, and it counts as a vulnerability.
  This includes a symlink planted by a fixture or a patch.
- A subject that reaches the shell, the network, hooks or MCP servers when its
  case has not allowed them.
- A subject, or any child process litmus starts, that reads the operator's
  keys from its environment.
- A suite, case or config file that runs code just by being loaded.
- A key that appears in anything litmus writes: `run.json`, `trial.json`, a
  transcript, an artifact or an export.
- A web page that drives `litmus serve` from another origin, for example to
  start runs that spend the operator's money or to read transcripts.

Out of scope:

- A model giving a wrong, rude or useless answer. That is what litmus
  measures.

## Controls

| Control | What it does |
| - | - |
| Disposable workdir | Each attempt runs on a fresh copy of `fixture/` plus `change.patch`, under the OS temp directory. Ground-truth files are never copied into it. Symlinks are refused both before and after the patch is applied. |
| Settings isolation | A harness trial always passes `settingSources` explicitly: nothing, or the fixture's own project settings. A fixture settings file may set only `$schema`. Each trial gets a fresh `CLAUDE_CONFIG_DIR`, with auto-memory off. The operator's user and local settings, memory and claude.ai connectors never load. Managed (policy) settings on the host always load; the SDK cannot turn them off. |
| Default-deny tool gate | The gate is a PreToolUse hook, so it sees every tool call, including read-only tools, tools that settings allow, and subagent calls. File tools are confined to the workdir by realpath. Plugin and subject roots are readable but not writable. Writes under `.git/` and reads inside any suite root are refused. Shell, network, hooks and MCP servers are refused unless the case opts in. Every refusal is recorded. |
| Scrubbed child environments | The harness, `command` graders and `validate` proofs get an allowlisted environment, with `HOME` pointed at a temporary directory. Only the harness gets a credential, and only the one its provider needs. |
| Git before, snapshot after | Git runs only while the workdir is being built, with system, global and hook config disabled. The files a subject wrote are found by comparing snapshots, so nothing it writes into `.git/` ever runs. |
| API keys only | The harness authenticates with an API key or AWS credentials. It never uses a claude.ai login. |
| Redaction by value | Where events and records are produced, the values of known key variables are replaced with `[REDACTED]`, so every sink gets the same scrubbed text. That covers the Anthropic, OpenRouter and AWS keys, plus any listed under `redact`. Provider responses are stored as parsed bodies only. Credentials the AWS SDK resolves from a named profile never pass through litmus's environment, so they are not redacted. |
| Localhost only | `litmus serve` binds to `127.0.0.1`. It accepts only its own `Host`, requires its own `Origin` on any request that changes state, and sends no CORS headers. |
| Declarative loading | Loading a suite, case or config never runs code. |

## Where litmus runs code on purpose

Code runs only on these paths, and each one runs in a scrubbed environment:

| Path | Runs | Contained? |
| - | - | - |
| `litmus validate` | Each seeded bug's `proof` command, on a disposable copy of the case | No. Read a suite before you validate it |
| `command` grader | The case's command, in the workdir, after the subject has run | No. It may run code the subject wrote |
| `allow_shell: true` | A real shell for the subject | No |
| `allow_hooks: true` | Plugin and project hooks and MCP servers, as host processes | No |

A scrubbed environment keeps keys out of reach of casual reads. **It does not
contain a hostile process**, which can still read any file you can read. A
shell command, hook or MCP server started by the harness is the harness's
child, so it also holds the harness's credential: under `allow_shell`,
`echo $ANTHROPIC_API_KEY` works. Until
the container executor lands (see "After 0.1.0" in the plan), run the four
uncontained paths only on a machine you are willing to lose, and only for
suites whose authors you trust.

## Results are sensitive

A transcript contains everything the subject saw and said: fixture code,
system prompts, and whatever it read. Treat `.litmus/` like source code with
the same confidentiality as your private suites. It is ignored by git in this
repository, so keep it ignored in yours.
