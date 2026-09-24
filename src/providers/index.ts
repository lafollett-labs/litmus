import Anthropic from '@anthropic-ai/sdk'
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk'
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
export function createProvider(def: ConfigDef | JudgeDef): Provider {
  switch (def.provider) {
    case 'anthropic':
      return messagesProvider('anthropic', streamingSend(new Anthropic({ maxRetries: 0 })))
    case 'bedrock':
      return messagesProvider(
        'bedrock',
        streamingSend(new AnthropicBedrockMantle({ maxRetries: 0, ...('region' in def && def.region ? { awsRegion: def.region } : {}) })),
      )
    case 'openrouter':
      return openrouterProvider()
    case 'fake':
      return fakeProvider()
  }
}

// Fill cost from the pricing table when the provider reported none. A cost the
// provider reported always wins: it is what was actually charged.
export function priced(usage: Usage, model: string, pricing: ConfigFile['pricing']): Usage {
  if (usage.cost_usd !== undefined) return usage
  const p = pricing[model]
  if (!p) return usage
  return { ...usage, cost_usd: (usage.input_tokens * p.input + usage.output_tokens * p.output) / 1_000_000 }
}
