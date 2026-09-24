// Why a trial stopped decides what happens next (docs/ARCHITECTURE.md § Flow):
// an infra error can only ever settle as ERROR, and is retried only when it is
// retryable; a model failure is a result, graded as FAIL and never retried. Getting this wrong turns a rate limit into a regression, or retries
// away the spiral litmus exists to catch.

export class InfraError extends Error {
  override name = 'InfraError'
  // Throttling, 5xx and network failures are worth retrying. A rejected key, a
  // model id the provider does not serve, or a malformed request will fail the
  // same way every time: it settles as ERROR at once instead of burning retries.
  readonly retryable: boolean

  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.retryable = options.retryable ?? true
  }
}

export class ModelFailure extends Error {
  override name = 'ModelFailure'
}

// A bad litmus.config.yaml, suite, case or selector: the operator's to fix, never retried.
export class ConfigError extends Error {
  override name = 'ConfigError'
}
