import Anthropic from '@anthropic-ai/sdk'
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk'
import { ConfigError, InfraError } from '../core/errors.ts'
import type { Usage } from '../core/types.ts'
import type { ConfigDef, ConfigFile, JudgeDef } from '../suite/schema.ts'
import { fakeProvider } from './fake.ts'
import { messagesProvider, streamingSend } from './messages.ts'
import { openrouterProvider } from './openrouter.ts'
import type { Provider } from './types.ts'

export type { CompleteRequest, CompleteResponse, Effort, Provider } from './types.ts'

// maxRetries: 0 on every SDK client. The runner owns retries, so it can count
// attempts, back off, and record each retry as an event; SDK retries hidden
// underneath would make a flaky provider look like a slow one.
export function createProvider(def: ConfigDef | JudgeDef, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Provider {
  const transport = fetchImpl ? { fetch: fetchImpl } : {}
  switch (def.provider) {
    case 'anthropic': {
      // The key is ANTHROPIC_API_KEY and nothing else. Left to itself the SDK
      // falls back to ANTHROPIC_AUTH_TOKEN and then to an `ant auth login`
      // profile on disk, whose base_url can send the eval to another host,
      // billed to another account.
      const apiKey = env['ANTHROPIC_API_KEY']
      if (!apiKey) return unavailable('anthropic', 'ANTHROPIC_API_KEY is not set')
      return messagesProvider('anthropic', streamingSend(new Anthropic({ apiKey, authToken: null, maxRetries: 0, ...transport })))
    }
    case 'bedrock': {
      // Resolved here so a missing region is a config error before any trial,
      // not an SDK error thrown from inside one.
      const awsRegion = ('region' in def && def.region) || env['AWS_REGION'] || env['AWS_DEFAULT_REGION']
      if (!awsRegion) throw new ConfigError(`bedrock ${def.model} has no region: set region on the config, or AWS_REGION`)
      return messagesProvider('bedrock', streamingSend(new AnthropicBedrockMantle({ maxRetries: 0, awsRegion, ...transport })))
    }
    case 'openrouter':
      return openrouterProvider({ ...transport, env })
    case 'fake':
      return fakeProvider()
  }
}

// A provider that fails every call the same way, without sending anything.
function unavailable(id: Provider['id'], why: string): Provider {
  return {
    id,
    complete: () => Promise.reject(new InfraError(why, { retryable: false })),
  }
}

// Fill cost from the pricing table when the provider reported none. A cost the
// provider reported always wins: it is what was actually charged.
export function priced(usage: Usage, model: string, pricing: ConfigFile['pricing']): Usage {
  if (usage.cost_usd !== undefined) return usage
  const p = Object.hasOwn(pricing, model) ? pricing[model] : undefined
  if (!p) return usage
  return { ...usage, cost_usd: (usage.input_tokens * p.input + usage.output_tokens * p.output) / 1_000_000 }
}
