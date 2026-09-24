import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProvider, priced } from '../../src/providers/index.ts'

test('each config builds the provider it names, without needing credentials up front', () => {
  assert.equal(createProvider({ provider: 'anthropic', model: 'claude-opus-5-5' }).id, 'anthropic')
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
})
