import type { Usage } from '../core/types.ts'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type CompleteRequest = {
  model: string
  system?: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  max_tokens: number
  effort?: Effort
  params?: Record<string, unknown> // provider-specific, passed through untouched
  signal: AbortSignal
  // Which trial is asking. Real providers ignore it; the fake provider uses it
  // to pick its scripted response, and to fail only the first N attempts.
  trace?: { case_id: string; trial: number; attempt: number; fake_file?: string }
}

export type CompleteResponse = {
  text: string
  stop_reason: string | null // a refusal or a truncation is output for graders to judge, not an error
  usage: Usage
  raw: unknown
}

// Errors are classified at this boundary and nowhere else: a provider throws
// InfraError for anything that is not the model's answer, and returns
// everything that is.
export interface Provider {
  id: 'anthropic' | 'bedrock' | 'openrouter' | 'fake'
  complete(req: CompleteRequest): Promise<CompleteResponse>
}
