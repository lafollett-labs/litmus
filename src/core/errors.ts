// Why a trial stopped decides what happens next (docs/ARCHITECTURE.md § Flow):
// an infra error can only ever settle as ERROR (it is retried when it is the
// retryable kind); a model failure is a result, graded as FAIL and never
// retried. Getting this wrong turns a rate limit into a regression, or retries
// away the spiral litmus exists to catch.

export class InfraError extends Error {
  override name = 'InfraError'
}

export class ModelFailure extends Error {
  override name = 'ModelFailure'
}

// A bad litmus.config.yaml, suite, case or selector: the operator's to fix, never retried.
export class ConfigError extends Error {
  override name = 'ConfigError'
}
