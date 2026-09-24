import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { query as sdkQuery, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ExecutorResult, Usage } from '../core/types.ts'
import { scrubbedEnv } from '../sandbox/env.ts'
import { snapshot, written } from '../sandbox/snapshot.ts'
import { deadline } from './deadline.ts'
import { decide, type GatePolicy } from './gate.ts'
import { Transcript } from './transcript.ts'
import type { ExecJob } from './types.ts'

export type Query = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>

// Claude Code as the system under test (docs/ARCHITECTURE.md § Executor
// `harness`). The subject is whatever the case loads into it: plugins, a
// fixture CLAUDE.md or AGENTS.md, the prompt. Everything else about the
// session is pinned here so two runs differ only in the model.
export async function runHarness(job: ExecJob, query: Query = sdkQuery as unknown as Query): Promise<ExecutorResult> {
  const exec = job.case.spec.executor
  if (exec.kind !== 'harness') throw new Error(`runHarness given a ${exec.kind} case`)
  const started = Date.now()
  const tx = new Transcript(job.out.transcript, job.key, job.emit)
  mkdirSync(job.out.artifacts, { recursive: true })
  const zero: Usage = { input_tokens: 0, output_tokens: 0 }
  const done = (exit: ExecutorResult['exit'], extra: Partial<ExecutorResult> = {}): ExecutorResult => ({
    exit,
    artifacts: {},
    transcript: tx.path,
    usage: zero,
    wall_clock_ms: Date.now() - started,
    ...extra,
  })
  const refuse = (reason: string) => done('infra_error', { reason, retryable: false })

  const creds = credentials(job)
  if (typeof creds === 'string') return refuse(creds)

  const plugins = exec.plugins.map(p => resolve(job.case.dir, p))
  if (!exec.allow_hooks) {
    const hooked = [...plugins.filter(declaresHooks), ...(exec.setting_sources.includes('project') && projectHooks(job.workdir.dir) ? ['the fixture'] : [])]
    // Hooks and MCP servers run as host processes, outside the gate; a case
    // has to say it accepts that before any of them load.
    if (hooked.length) return refuse(`${hooked.join(', ')} declares hooks or MCP servers; set allow_hooks: true to run them uncontained`)
  }

  const policy: GatePolicy = {
    workdir: realpathSync(job.workdir.dir),
    readRoots: [...plugins, ...(job.case.subject ? [dirname(job.case.subject.path)] : [])].filter(existsSync).map(p => realpathSync(p)),
    allowShell: exec.allow_shell,
    allowNetwork: exec.allow_network,
    allowHooks: exec.allow_hooks,
  }
  const gate = (tool: string, input: Record<string, unknown>) => {
    const d = decide(tool, input, policy)
    if (!d.allow) tx.denied(tool, d.reason)
    return d
  }

  const clock = deadline(job.signal, job.case.settings.timeout_s * 1000)
  const options: Options = {
    cwd: job.workdir.dir,
    model: 'model' in job.config ? job.config.model : 'fake',
    ...('effort' in job.config && job.config.effort ? { effort: job.config.effort } : {}),
    maxTurns: exec.max_turns,
    // Always explicit: leaving settingSources out loads the operator's own
    // ~/.claude settings, hooks and memory into the trial.
    settingSources: exec.setting_sources,
    plugins: plugins.map(path => ({ type: 'local' as const, path })),
    strictMcpConfig: true,
    mcpServers: {},
    persistSession: false,
    abortController: clock.controller,
    env: scrubbedEnv({
      home: job.workdir.home,
      extra: {
        CLAUDE_CONFIG_DIR: job.workdir.claudeConfig,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
        ...creds,
      },
    }),
    // The PreToolUse hook is the gate. canUseTool alone is not enough: Claude
    // Code auto-approves read-only tools without asking it, and Read on
    // ../truth.yaml would sail through. canUseTool stays as a second, deny-by-
    // default check for anything that does reach it.
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async input => {
              const i = input as { tool_name: string; tool_input: unknown }
              const d = gate(i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>)
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse' as const,
                  permissionDecision: d.allow ? ('allow' as const) : ('deny' as const),
                  ...(d.allow ? {} : { permissionDecisionReason: d.reason }),
                },
              }
            },
          ],
        },
      ],
    },
    canUseTool: async (tool, input) => {
      const d = gate(tool, input)
      return d.allow ? { behavior: 'allow' as const, updatedInput: input } : { behavior: 'deny' as const, message: d.reason }
    },
  }

  let final = ''
  let result: Extract<SDKMessage, { type: 'result' }> | undefined
  try {
    for await (const m of query({ prompt: job.case.prompt, options })) {
      if (m.type === 'assistant') {
        for (const block of m.message.content) {
          if (block.type === 'text') {
            tx.message('assistant', block.text)
            final = block.text
          } else if (block.type === 'tool_use') {
            tx.toolCall(block.id, block.name, block.input)
          }
        }
      } else if (m.type === 'user' && Array.isArray(m.message.content)) {
        for (const block of m.message.content) {
          if (typeof block === 'object' && block.type === 'tool_result') {
            const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
            tx.toolResult(block.tool_use_id, text, block.is_error === true)
          }
        }
      } else if (m.type === 'result') {
        result = m
      }
    }
  } catch (e) {
    const why = clock.stopped()
    if (why === 'cancelled') return done('cancelled')
    if (why === 'timeout') return done('model_failure', { reason: `timeout after ${job.case.settings.timeout_s}s` })
    return done('infra_error', { reason: `harness failed: ${(e as Error).message}`, retryable: true })
  } finally {
    clock.clear()
  }

  if (!result) return done('infra_error', { reason: 'harness ended without a result message', retryable: true })
  const u = result.usage
  const usage: Usage = {
    input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    output_tokens: u.output_tokens ?? 0,
    cost_usd: result.total_cost_usd,
  }
  tx.usage(usage)
  if (result.subtype === 'success') final = result.result

  const artifacts = collect(job, final)
  if (result.subtype === 'success') return done('ok', { artifacts, usage })
  if (result.subtype === 'error_max_turns') return done('model_failure', { reason: `stopped at max_turns (${exec.max_turns})`, artifacts, usage })
  if (result.subtype === 'error_max_budget_usd') return done('model_failure', { reason: 'stopped at the budget cap', artifacts, usage })
  const raw = (result as { api_error_status?: unknown }).api_error_status
  const status = typeof raw === 'number' ? raw : null
  // No status means the harness itself broke, not the model: retry it.
  const retryable = status === null || status === 408 || status === 409 || status === 429 || status >= 500
  return done('infra_error', { reason: `harness error (${result.subtype}${status ? ` ${status}` : ''})`, retryable, artifacts, usage })
}

// The files the subject wrote (by snapshot, never by asking git) plus its last
// word, copied out so they outlive the workdir.
function collect(job: ExecJob, final: string): Record<string, string> {
  const artifacts: Record<string, string> = {}
  for (const rel of written(job.workdir.before, snapshot(job.workdir.dir))) {
    const to = join(job.out.artifacts, rel)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(join(job.workdir.dir, rel), to)
    artifacts[rel] = to
  }
  artifacts['final_message.txt'] = join(job.out.artifacts, 'final_message.txt')
  writeFileSync(artifacts['final_message.txt'], final)
  return artifacts
}

// The one credential the harness's provider needs, or why there is none. A
// claude.ai login is never used: an eval run on a subscription is billed and
// rate-limited differently from the API runs it gets compared against.
function credentials(job: ExecJob): Record<string, string> | string {
  const env = process.env
  switch (job.config.provider) {
    case 'anthropic':
      return env['ANTHROPIC_API_KEY'] ? { ANTHROPIC_API_KEY: env['ANTHROPIC_API_KEY'] } : 'the claude-code harness needs ANTHROPIC_API_KEY (a claude.ai login is never used)'
    case 'bedrock': {
      const out: Record<string, string> = { CLAUDE_CODE_USE_BEDROCK: '1' }
      const region = job.config.region ?? env['AWS_REGION'] ?? env['AWS_DEFAULT_REGION']
      if (!region) return 'the claude-code harness on bedrock needs a region (config.region or AWS_REGION)'
      out['AWS_REGION'] = region
      for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE']) if (env[k]) out[k] = env[k]!
      // HOME is redirected, so a named profile needs its files pointed at.
      if (out['AWS_PROFILE']) {
        out['AWS_CONFIG_FILE'] = env['AWS_CONFIG_FILE'] ?? join(homedir(), '.aws/config')
        out['AWS_SHARED_CREDENTIALS_FILE'] = env['AWS_SHARED_CREDENTIALS_FILE'] ?? join(homedir(), '.aws/credentials')
      }
      return out
    }
    default:
      return `the claude-code harness cannot run on the ${job.config.provider} provider`
  }
}

export function declaresHooks(pluginDir: string): boolean {
  if (existsSync(join(pluginDir, 'hooks/hooks.json')) || existsSync(join(pluginDir, '.mcp.json'))) return true
  const manifest = join(pluginDir, '.claude-plugin/plugin.json')
  if (!existsSync(manifest)) return false
  try {
    const m = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>
    return 'hooks' in m || 'mcpServers' in m
  } catch {
    return true // unreadable manifest: assume the worst
  }
}

function projectHooks(dir: string): boolean {
  if (existsSync(join(dir, '.mcp.json'))) return true
  for (const f of ['.claude/settings.json', '.claude/settings.local.json']) {
    const path = join(dir, f)
    if (!existsSync(path)) continue
    try {
      if ('hooks' in (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)) return true
    } catch {
      return true
    }
  }
  return false
}
