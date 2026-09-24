// The environment variables that hold provider credentials. Their values are
// what redaction scrubs and what a config's params may never contain; the
// config's own `redact` list adds to this set, never replaces it.
export const CREDENTIAL_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const

// A params key that names where a credential would go. Deliberately broad
// ("max_tokens" and "author" match too): a name can't prove a value is
// harmless, and params is for model behaviour, not transport or auth.
export const CREDENTIAL_KEY = /key|token|secret|password|passw|auth|credential|cookie|bearer|session/i
