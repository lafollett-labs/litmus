# Security

Litmus runs models and agents against code, using your API keys, and records
everything they do. That raises three questions:

- where the keys go
- what a subject under test can reach
- what ends up in the results

This document states the intended answers. Where a milestone in
[docs/PLAN.md](docs/PLAN.md) has not landed yet, the control is a design
commitment, not code you can check.

## Reporting a vulnerability

Open a [security advisory](https://github.com/lafollett-labs/litmus/security/advisories/new)
rather than a public issue. If you would rather not use GitHub, email
`cali.lafollett@gmail.com` with `litmus` in the subject.

There is no bounty. You will get a fast answer, and public credit unless you
would rather not have it.

## The threat model

**The subject under test is the untrusted party.** A harness trial runs an
agent that has tools, and a subject that misbehaves is exactly what litmus is
meant to catch. So no instruction in a prompt counts as a control.

In scope:

- A subject that reads or writes outside its trial's workdir.
- A subject that reads the case's ground truth (`truth.yaml`, `fix/` or
  `fake.yaml`). That invalidates the eval, and it counts as a vulnerability.
- A subject that reaches the shell or the network when its case has not
  allowed it.
- A subject that reads the operator's keys.
- A suite, case or config file that runs code just by being loaded.
- A web page that drives `litmus serve` from another origin, for example to
  start runs that spend the operator's money.

Out of scope:

- A model giving a wrong, rude or useless answer. That is what litmus
  measures.

## Controls

| Control | What it does |
| - | - |
| Disposable workdir | Each trial works on a fresh copy of `fixture/`. Ground-truth files are never copied into it. |
| Default-deny tool gate | Harness file tools are confined to the workdir. Shell and network are refused unless the case opts in, and every refusal is recorded. |
| Keys from the environment | Keys are read at call time from standard environment variables. They are never written to `run.json`, `trial.json`, a transcript or an export. |
| Localhost only | `litmus serve` binds to `127.0.0.1` and rejects a foreign `Host`, or a foreign `Origin` on a mutating request. |
| Declarative suites | Suite files are data. The only thing a suite executes is the `command` a case names, and only inside the trial's workdir. |

Shell access (`allow_shell: true`) is not contained. It gives the subject a
real shell on your machine. Until the container executor lands (see "After
0.1.0" in the plan), use it only on a machine you are willing to lose.

## Results are sensitive

A transcript contains everything the subject saw and said: fixture code,
system prompts, and whatever it read. Treat `.litmus/` like source code with
the same confidentiality as your private suites. It is ignored by git in this
repository, so keep it ignored in yours.
