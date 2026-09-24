# Contributing

Thanks for looking at litmus. It is pre-release, and
[docs/PLAN.md](docs/PLAN.md) says what exists and what is next. Right now the
most useful contribution is an issue:

- a failure mode your evals miss
- a suite you would want to run
- a flaw in the contracts in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## License

Litmus is MIT-licensed, and contributions are accepted under the same license.
By submitting one, you agree that your work is licensed under MIT and that you
have the right to submit it.

## Setup

```bash
nvm use            # Node 26 (.nvmrc)
npm ci
npm run check      # type-check everything
npm test           # unit and integration tests; they use the fake provider and cost nothing
npm run test:ui    # Playwright, against the runner UI
```

The package scripts arrive in milestone M0. Until then, there is nothing to
build.

Tests never call a real model. The live smoke tests run only when
`LITMUS_LIVE=1` is set and the provider's key is in your environment, and each
one costs cents.

## Workflow

Every change lands through a pull request, and `main` stays releasable.

```
branch → small commits → pull request → review → green CI → rebase-merge
```

- Each commit is one logical change, and `npm run check && npm test` passes at
  every commit.
- Commit subjects look like `feat: stream trial usage events`. Use one of the
  types `feat`, `fix`, `docs`, `test`, `refactor`, `chore` or `ci`. The body
  says why the change was made.
- A change to a schema, an event, an API route or a verdict rule updates
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) in the same pull request.
- A claim in a pull request is checkable: give the command and what it printed.

## Contributing a suite

The suites in this repository are examples, canaries and demonstrations.
**Don't contribute a suite that you use to gate a model rollout.** A public
seeded bug ends up in training data, and a gate a model has memorized passes
for the wrong reason.

A seeded-bug case needs:

- a proof command that fails while the bug is present and passes once its fix
  is applied, which `litmus validate` checks
- the fix, as a patch
- a severity and a category
- fixture code you have the right to license under MIT

## Reporting a bug

Include:

- the command you ran
- the case or trial key
- the config (provider and model)
- what you expected, and what you saw

The trial's `trial.json` helps most. **Check its transcript before attaching
it.** A transcript holds everything the subject saw.

To report a security problem, follow [SECURITY.md](SECURITY.md) rather than
opening an issue.
