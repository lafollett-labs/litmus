import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, InfraError } from '../../src/core/errors.ts'
import { createProvider, priced } from '../../src/providers/index.ts'

test('each config builds the provider it names, without needing credentials up front', () => {
  assert.equal(createProvider({ provider: 'anthropic', model: 'claude-opus-5-5' }, {}).id, 'anthropic')
  assert.equal(createProvider({ provider: 'bedrock', model: 'anthropic.claude-opus-5-5', region: 'us-east-1' }).id, 'bedrock')
  assert.equal(createProvider({ provider: 'openrouter', model: 'x/y' }).id, 'openrouter')
  assert.equal(createProvider({ provider: 'fake', model: 'fake' }).id, 'fake')
})

test('pricing fills cost from the table, but a cost the provider reported always wins', () => {
  const pricing = { 'claude-opus-5-5': { input: 4, output: 20 } }
  assert.deepEqual(priced({ input_tokens: 1_000_000, output_tokens: 500_000 }, 'claude-opus-5-5', pricing), {
    input_tokens: 1_000_000,
    output_tokens: 500_000,
    cost_usd: 14,
  })
  assert.equal(priced({ input_tokens: 5, output_tokens: 5, cost_usd: 0.01 }, 'claude-opus-5-5', pricing).cost_usd, 0.01)
  assert.equal(priced({ input_tokens: 5, output_tokens: 5 }, 'unpriced', pricing).cost_usd, undefined)
  assert.equal(priced({ input_tokens: 5, output_tokens: 5 }, 'constructor', pricing).cost_usd, undefined) // no prototype lookups
})

test('anthropic uses ANTHROPIC_API_KEY and nothing else: an auth token or a login profile is never picked up', async () => {
  for (const env of [{}, { ANTHROPIC_AUTH_TOKEN: 'bearer-from-env' }, { ANTHROPIC_PROFILE: 'work', ANTHROPIC_CONFIG_DIR: '/tmp/somewhere' }]) {
    const p = createProvider({ provider: 'anthropic', model: 'claude-opus-5-5' }, env)
    await assert.rejects(
      p.complete({ model: 'm', messages: [], max_tokens: 1, signal: new AbortController().signal }),
      (e: unknown) => e instanceof InfraError && !e.retryable && /ANTHROPIC_API_KEY is not set/.test(e.message),
      JSON.stringify(env),
    )
  }
})

test('bedrock takes its region from the config or AWS_REGION, and has none is a config error before any trial', () => {
  assert.equal(createProvider({ provider: 'bedrock', model: 'm' }, { AWS_REGION: 'eu-west-1' }).id, 'bedrock')
  assert.equal(createProvider({ provider: 'bedrock', model: 'm' }, { AWS_DEFAULT_REGION: 'eu-west-1' }).id, 'bedrock')
  assert.throws(() => createProvider({ provider: 'bedrock', model: 'm' }, {}), (e: unknown) => e instanceof ConfigError && /has no region/.test(String(e)))
})
