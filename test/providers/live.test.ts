import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProvider } from '../../src/providers/index.ts'

// Real calls, real money (cents). Skipped unless LITMUS_LIVE=1 and the
// provider's credentials are present, so npm test never spends anything.
const live = process.env['LITMUS_LIVE'] === '1'
const skip = (need: string | undefined, what: string) => (!live ? 'set LITMUS_LIVE=1 to run' : need ? false : `${what} is not set`)

const ask = { messages: [{ role: 'user' as const, content: 'Reply with the single word: pong' }], max_tokens: 64 }

test('anthropic answers a one-word prompt', { skip: skip(process.env['ANTHROPIC_API_KEY'], 'ANTHROPIC_API_KEY') }, async () => {
  const r = await createProvider({ provider: 'anthropic', model: 'claude-haiku-4-5' }).complete({ ...ask, model: 'claude-haiku-4-5', signal: AbortSignal.timeout(60_000) })
  assert.match(r.text, /pong/i)
  assert.ok(r.usage.output_tokens > 0)
})

// Bedrock is opt-in by model and needs a region: whatever AWS credentials a
// machine happens to hold are never spent by default.
const bedrockReady = process.env['LITMUS_BEDROCK_MODEL'] && (process.env['AWS_REGION'] || process.env['AWS_DEFAULT_REGION'])
test('bedrock answers a one-word prompt', { skip: skip(bedrockReady || undefined, 'LITMUS_BEDROCK_MODEL and AWS_REGION') }, async () => {
  const model = process.env['LITMUS_BEDROCK_MODEL']!
  const r = await createProvider({ provider: 'bedrock', model }).complete({ ...ask, model, signal: AbortSignal.timeout(60_000) })
  assert.match(r.text, /pong/i)
})

test('openrouter answers a one-word prompt and reports its cost', { skip: skip(process.env['OPENROUTER_API_KEY'], 'OPENROUTER_API_KEY') }, async () => {
  const model = 'anthropic/claude-haiku-4.5'
  const r = await createProvider({ provider: 'openrouter', model }).complete({ ...ask, model, signal: AbortSignal.timeout(60_000) })
  assert.match(r.text, /pong/i)
  assert.equal(typeof r.usage.cost_usd, 'number')
})
