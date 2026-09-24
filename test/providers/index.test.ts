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

test('with a key set, anthropic sends only X-Api-Key, never a bearer token from ANTHROPIC_AUTH_TOKEN', async () => {
  const seen: Headers[] = []
  const f = (async (_url: string, init: RequestInit) => (seen.push(new Headers(init.headers)), new Response('{}', { status: 401 }))) as unknown as typeof fetch
  const saved = process.env['ANTHROPIC_AUTH_TOKEN']
  process.env['ANTHROPIC_AUTH_TOKEN'] = 'bearer-from-env' // where the SDK would look for it
  try {
    await createProvider({ provider: 'anthropic', model: 'm' }, { ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 'bearer-from-env' }, f)
      .complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, signal: new AbortController().signal })
      .catch(() => {})
  } finally {
    if (saved === undefined) delete process.env['ANTHROPIC_AUTH_TOKEN']
    else process.env['ANTHROPIC_AUTH_TOKEN'] = saved
  }
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.get('x-api-key'), 'k')
  assert.equal(seen[0]!.get('authorization'), null)
})

test('openrouter reads its key from the env it is given', async () => {
  await assert.rejects(
    createProvider({ provider: 'openrouter', model: 'x/y' }, {}).complete({ model: 'x/y', messages: [], max_tokens: 1, signal: new AbortController().signal }),
    /OPENROUTER_API_KEY is not set/,
  )
})

test('bedrock takes its region from the config or AWS_REGION, and has none is a config error before any trial', () => {
  assert.equal(createProvider({ provider: 'bedrock', model: 'm' }, { AWS_REGION: 'eu-west-1' }).id, 'bedrock')
  assert.equal(createProvider({ provider: 'bedrock', model: 'm' }, { AWS_DEFAULT_REGION: 'eu-west-1' }).id, 'bedrock')
  assert.throws(() => createProvider({ provider: 'bedrock', model: 'm' }, {}), (e: unknown) => e instanceof ConfigError && /has no region/.test(String(e)))
})
