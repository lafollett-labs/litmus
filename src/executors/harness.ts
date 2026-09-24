import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { isMap, isScalar, parseDocument } from 'yaml'
import { query as sdkQuery, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ExecutorResult, Usage } from '../core/types.ts'
import { scrubbedEnv } from '../sandbox/env.ts'
import { snapshot, written } from '../sandbox/snapshot.ts'
import { deadline } from './deadline.ts'
import { fold, inside } from '../core/paths.ts'
import { decide, NETWORK_TOOLS, SHELL_TOOLS, type GatePolicy } from './gate.ts'
import { renderPrompt } from './render.ts'
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
  const tx = new Transcript(job.out.transcript, job.key, job.emit, job.redact)
  mkdirSync(job.out.artifacts, { recursive: true })
  const zero: Usage = { input_tokens: 0, output_tokens: 0 }
  const done = (exit: ExecutorResult['exit'], extra: Partial<ExecutorResult> = {}): ExecutorResult => ({
    exit,
    artifacts: {},
    transcript: tx.path,
    usage: zero,
    wall_clock_ms: Date.now() - started,
    ...extra,
    ...(extra.reason === undefined ? {} : { reason: job.redact.text(extra.reason) }),
  })
  const refuse = (reason: string) => done('infra_error', { reason, retryable: false })

  const creds = credentials(job)
  if (typeof creds === 'string') return refuse(creds)

  const plugins = job.case.plugins // absolute, and checked to exist, at load
  const project = exec.setting_sources.includes('project')
  // Hooks, MCP and LSP servers run as host processes, outside the gate, and a
  // case has to say it accepts that (allow_hooks) before any of them load. The
  // scan runs either way: what allow_hooks waives is only those process
  // signals, never the gate's own checks (isolation, links, unparseable keys).
  const found = [...plugins.map(p => pluginRunsProcesses(p, exec.allow_hooks)), project ? fixtureRunsProcesses(job.workdir.dir, exec.allow_hooks) : undefined].find(
    x => x !== undefined,
  )
  if (found) return refuse(`${found.reason}; ${found.fix}`)
  if (project) {
    const bad = fixtureSettings(job.workdir.dir)
    if (bad) return refuse(bad)
  }

  // A directory subject is its own root; a file subject's root is the folder
  // it lives in (a skill's SKILL.md beside its references).
  const subjectRoot = job.case.subject ? (job.case.subject.kind === 'dir' ? job.case.subject.path : dirname(job.case.subject.path)) : undefined
  // .native: the on-disk case, so the gate compares like with like.
  const real = (paths: string[]) => paths.filter(existsSync).map(p => realpathSync.native(p))
  // The case's own directory, its suite and its root are denied whatever the
  // caller passes: the ground truth is always somewhere in there.
  const suiteDir = dirname(dirname(job.case.dir))
  const denyRoots = real([...job.suiteRoots, job.case.dir, suiteDir, dirname(suiteDir)])
  const trapped = (r: string) => denyRoots.find(d => inside(r, d))
  // A plugin inside a suite would load but could not read a single one of its
  // own files, and the skill failing would read as the model's fault.
  for (const plugin of real(plugins)) {
    const under = trapped(plugin)
    if (under) return refuse(`plugin ${plugin} lies inside ${under}, where the gate denies every read; move it outside the suite`)
  }
  const policy: GatePolicy = {
    workdir: realpathSync.native(job.workdir.dir),
    // A subject root inside a deny root is only a version for the harness, so
    // it simply is not readable.
    readRoots: real([...plugins, ...(subjectRoot ? [subjectRoot] : [])]).filter(r => !trapped(r)),
    denyRoots,
    // Written mid-session, these would overwrite an artifact litmus writes
    // itself, or be read back as the session's own MCP config.
    protect: ['final_message.txt', ...(project ? ['.mcp.json'] : [])],
    // Under project settings, a .claude directory at any depth is config the
    // session would discover and load.
    protectSegments: project ? ['.claude'] : [],
    allowShell: exec.allow_shell,
    allowNetwork: exec.allow_network,
    allowHooks: exec.allow_hooks,
  }
  const gate = (tool: string, input: Record<string, unknown>) => {
    const d = decide(tool, input, policy)
    if (!d.allow) {
      try {
        tx.denied(tool, d.reason)
      } catch {
        // an unwritable transcript must not turn a denial into a hook error
      }
    }
    return d
  }

  const prompt = renderPrompt(job.case.prompt, job.workdir.dir, job.case.changePatch)
  const clock = deadline(job.signal, job.case.settings.timeout_s * 1000)
  const options: Options = {
    cwd: job.workdir.dir,
    // Explicit, so a fixture or a default can never widen it. Tool classes the
    // case has not allowed are removed from the model's context as well as
    // refused by the gate.
    permissionMode: 'default',
    disallowedTools: [...(exec.allow_shell ? [] : SHELL_TOOLS), ...(exec.allow_network ? [] : NETWORK_TOOLS)],
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
  // A harness timeout is the subject's session running long: a model failure,
  // graded for metrics like max_turns, so it keeps what the subject wrote.
  const byClock = (): ExecutorResult | undefined => {
    const why = clock.stopped()
    if (why === 'cancelled') return done('cancelled')
    if (why === 'timeout') return done('model_failure', { reason: `timeout after ${job.case.settings.timeout_s}s`, artifacts: collect(job, final) })
    return undefined
  }
  try {
    for await (const m of query({ prompt, options })) {
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
    const stopped = byClock()
    if (stopped) return stopped
    return done('infra_error', { reason: `harness failed: ${(e as Error).message}`, retryable: true })
  } finally {
    clock.clear()
  }
  // The SDK may end the stream quietly, or with an error result, after an
  // abort: the clock's reason still decides, unless the session had already
  // finished cleanly before it stopped.
  if (!(result?.subtype === 'success' && !result.is_error)) {
    const stopped = byClock()
    if (stopped) return stopped
  }

  if (!result) return done('infra_error', { reason: 'harness ended without a result message', retryable: true })
  const usage = usageOf(result)
  tx.usage(usage)
  // A turn that ended on an API error ("API Error: 529 ...") arrives as a
  // success result with is_error set, and its result text is the error, not
  // an answer. Grading it would turn an overload into a FAIL.
  const apiError = result.subtype === 'success' && result.is_error
  if (result.subtype === 'success' && !apiError) final = result.result

  const artifacts = collect(job, final)
  if (result.subtype === 'success' && !apiError) return done('ok', { artifacts, usage })
  if (result.subtype === 'error_max_turns') return done('model_failure', { reason: `stopped at max_turns (${exec.max_turns})`, artifacts, usage })
  if (result.subtype === 'error_max_budget_usd') return done('model_failure', { reason: 'stopped at the budget cap', artifacts, usage })
  const status = result.subtype === 'success' && typeof result.api_error_status === 'number' ? result.api_error_status : null
  const detail = result.subtype === 'success' ? result.result : result.errors.join('; ')
  // No status usually means the harness itself broke, or the connection did:
  // retry it. An API-error turn with no status whose text says auth or
  // billing will fail the same way every time.
  const retryable =
    status === null ? !(apiError && FAILS_AGAIN_TEXT.test(detail)) : status === 408 || status === 409 || status === 429 || (status >= 500 && status < 600)
  const reason = `harness error (${apiError ? 'api error' : result.subtype}${status ? ` ${status}` : ''})${detail ? `: ${detail.slice(0, 300)}` : ''}`
  return done('infra_error', { reason, retryable, artifacts, usage })
}

const FAILS_AGAIN_TEXT = /authentication|invalid (x-)?api[ -]key|permission|credit balance|billing|unauthori[sz]ed|forbidden/i

// Tokens from modelUsage, which covers every model call in the session:
// subagents included. `usage` is the main loop only, and a review skill that
// fans out to reviewers spends most of its tokens outside it.
function usageOf(result: Extract<SDKMessage, { type: 'result' }>): Usage {
  const models = Object.values(result.modelUsage ?? {})
  if (models.length === 0) {
    const u = result.usage
    return {
      input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      output_tokens: u.output_tokens ?? 0,
      cost_usd: result.total_cost_usd,
    }
  }
  const sum = (f: (m: (typeof models)[number]) => number) => models.reduce((n, m) => n + (f(m) ?? 0), 0)
  return {
    input_tokens: sum(m => m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens),
    output_tokens: sum(m => m.outputTokens),
    cost_usd: result.total_cost_usd,
  }
}

// The files the subject wrote (by snapshot, never by asking git) plus its last
// word, copied out so they outlive the workdir. Redacted on the way out: with
// allow_shell, a subject can write a key into a file.
function collect(job: ExecJob, final: string): Record<string, string> {
  const artifacts: Record<string, string> = {}
  for (const rel of written(job.workdir.before, snapshot(job.workdir.dir))) {
    const to = join(job.out.artifacts, rel)
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, job.redact.bytes(readFileSync(join(job.workdir.dir, rel))))
    artifacts[rel] = to
  }
  artifacts['final_message.txt'] = join(job.out.artifacts, 'final_message.txt')
  writeFileSync(artifacts['final_message.txt'], job.redact.text(final))
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
      for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_PROFILE']) if (env[k]) out[k] = env[k]!
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

// A plugin may carry prompts: skills, agents and commands. Anything that makes
// Claude Code start a host process (hooks, MCP, LSP or monitor servers) needs
// allow_hooks. The manifest is an allowlist, so a component type Claude Code
// adds later is refused until it is classified here. Every markdown file in the
// tree is checked, wherever the manifest points its components, and a symlink
// anywhere is refused because it could point a component at a file this check
// never reads. Returns why a plugin is refused, if it is.
const SAFE_MANIFEST_KEYS = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'commands', 'agents', 'skills'])
const PROCESS_FILES = ['hooks/hooks.json', '.mcp.json', '.lsp.json', 'monitors/monitors.json']
const PROCESS_KEYS = new Set(['hooks', 'mcpservers', 'lspservers', 'monitors', 'statusline'])

// Why a plugin or fixture is refused, and what would fix it. Only a real
// process signal is waived by allow_hooks and points at it: a YAML typo must
// not steer an operator toward the one setting that turns process checks off.
type Refusal = { reason: string; fix: string; waivable: boolean }
const RUNS = 'set allow_hooks: true to run them uncontained'
const runs = (reason: string): Refusal => ({ reason, fix: RUNS, waivable: true })
const blocks = (reason: string, fix: string): Refusal => ({ reason, fix, waivable: false })

export function pluginRunsProcesses(dir: string, allowHooks = false): Refusal | undefined {
  if (!allowHooks) for (const f of PROCESS_FILES) if (existsSync(join(dir, f))) return runs(`plugin ${dir} has ${f}`)
  const manifest = join(dir, '.claude-plugin/plugin.json')
  if (existsSync(manifest)) {
    let m: unknown
    try {
      m = JSON.parse(readFileSync(manifest, 'utf8'))
    } catch (e) {
      return blocks(`plugin ${dir} has a plugin.json that is not valid JSON (${(e as Error).message})`, 'fix the JSON')
    }
    if (m === null || typeof m !== 'object' || Array.isArray(m)) return blocks(`plugin ${dir}'s plugin.json is not an object`, 'fix the JSON')
    const extra = Object.keys(m).filter(k => !SAFE_MANIFEST_KEYS.has(k))
    if (extra.length && !allowHooks) return runs(`plugin ${dir}'s plugin.json declares ${extra.join(', ')}`)
  }
  // A plugin's .git is walked too: its manifest can point a component there.
  return treeRunsProcesses(dir, `plugin ${dir}`, () => true, false, allowHooks)
}

// Under project settings Claude Code discovers .claude/skills, agents and
// commands at every depth of the fixture, not only at its root. The fixture's
// .git is litmus's own (a fixture .git is refused at build), so it is skipped.
function fixtureRunsProcesses(dir: string, allowHooks: boolean): Refusal | undefined {
  if (!allowHooks && existsSync(join(dir, '.mcp.json'))) return runs('the fixture has .mcp.json')
  return treeRunsProcesses(dir, 'the fixture', rel => rel.split('/').some(seg => fold(seg) === '.claude'), true, allowHooks)
}

function treeRunsProcesses(root: string, who: string, inScope: (rel: string) => boolean, skipGit: boolean, allowHooks: boolean): Refusal | undefined {
  const visit = (d: string): Refusal | undefined => {
    for (const name of readdirSync(d).sort()) {
      if (skipGit && fold(name) === '.git') continue
      const path = join(d, name)
      const rel = relative(root, path).split(sep).join('/')
      const st = lstatSync(path)
      if (st.isSymbolicLink()) return blocks(`${who}: ${rel} is a symlink, which could point a component at a file this check never reads`, 'replace the link with the files it points at')
      if (st.isDirectory()) {
        const found = visit(path)
        if (found) return found
      } else if (st.isFile() && /\.md$/i.test(name) && inScope(rel)) {
        const found = frontmatterRunsProcesses(readFileSync(path, 'utf8'), allowHooks)
        if (found) return { ...found, reason: `${who}: ${rel} ${found.reason}` }
      }
    }
    return undefined
  }
  return visit(root)
}

// Frontmatter is read with Claude Code's own fence, whose closing --- need not
// start a line, and with the strict one, which catches a --- inside a value.
// Each top-level key is then judged as a plain string, and anything that is
// not one is refused rather than second-guessed. Claude Code's YAML coerces
// a collection key ([hooks]) to "hooks" and merges a quoted "<<", so matching
// its semantics key by key is a race; refusing every key it could read
// differently is not. Frontmatter that does not parse is refused too.
const FENCES = [/^---\s*\n([\s\S]*?)---\s*\n?/, /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/]

function frontmatterRunsProcesses(text: string, allowHooks: boolean): Refusal | undefined {
  const body = text.replace(/^\uFEFF/, '')
  for (const fence of FENCES) {
    const m = fence.exec(body)
    if (!m) continue
    const doc = parseDocument(m[1]!)
    const error = doc.errors[0]
    if (error) return blocks(`has frontmatter that is not valid YAML (${error.message.split('\n')[0]})`, 'quote the value so the frontmatter parses')
    if (!isMap(doc.contents)) continue
    for (const { key } of doc.contents.items) {
      if (!isScalar(key) || typeof key.value !== 'string') return blocks('has a frontmatter key that is not a plain string', 'use plain string keys')
      if (key.value === '<<') return blocks('has a << merge key in its frontmatter', 'write the keys out instead of merging them')
      // An agent definition can ask to run in a git worktree, where the gate
      // cannot follow it, so this one is refused whatever allow_hooks says.
      if (fold(key.value) === 'isolation') return blocks('declares isolation in its frontmatter', 'remove isolation: a subagent must run inside this session')
      if (PROCESS_KEYS.has(fold(key.value)) && !allowHooks) return runs(`declares ${key.value} in its frontmatter`)
    }
  }
  return undefined
}

// Under setting_sources [project], a fixture's settings may set only $schema.
// Permissions, env, hooks and helper commands would otherwise run, or approve
// things, outside the gate. Returns why the fixture is refused, if it is.
function fixtureSettings(dir: string): string | undefined {
  for (const f of ['.claude/settings.json', '.claude/settings.local.json']) {
    const path = join(dir, f)
    if (!existsSync(path)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return `the fixture's ${f} is not valid JSON`
    }
    const keys = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).filter(k => k !== '$schema') : ['(not an object)']
    if (keys.length) return `the fixture's ${f} sets ${keys.join(', ')}; under setting_sources [project] it may set only $schema`
  }
  return undefined
}
