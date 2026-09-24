import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ConfigDef } from '../../src/suite/schema.ts'
import { runHarness, type Query } from '../../src/executors/harness.ts'
import type { ExecJob } from '../../src/executors/types.ts'
import { buildWorkdir } from '../../src/sandbox/workdir.ts'
import { oneCase } from '../helpers/cases.ts'
import { tree } from '../helpers/tmp.ts'

const saved = { ...process.env }
before(() => {
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test'
  process.env['OPENROUTER_API_KEY'] = 'sk-or-must-not-leak'
})
after(() => {
  process.env = saved
})

const HARNESS = (extra = '') =>
  `name: c\nexecutor:\n  kind: harness\n  harness: claude-code\n  prompt: /review\n  max_turns: 7\n${extra}graders: [{ kind: regex, pattern: x }]\ntimeout_s: 5\n`

function job(yaml: string, files: Record<string, string> = {}, config: ConfigDef = { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'medium' }, signal = new AbortController().signal): ExecJob {
  const { c, base } = oneCase(yaml, { 'fixture/a.go': 'package a\n', ...files })
  const out = tree({ '.keep': '' })
  return {
    key: 's/c@opus#1',
    case: c,
    configName: 'opus',
    config,
    trial: 1,
    attempt: 1,
    workdir: buildWorkdir(c, { run: '2026-09-24T12-00-00Z-a1b2', key: 's/c@opus#1', attempt: 1 }, base),
    suiteRoots: [],
    out: { artifacts: join(out, 'artifacts'), transcript: join(out, 'transcript.jsonl') },
    pricing: {},
    emit: () => {},
    signal,
  }
}

const result = (over: Record<string, unknown> = {}) =>
  ({
    type: 'result',
    subtype: 'success',
    result: 'All good.',
    is_error: false,
    num_turns: 2,
    total_cost_usd: 0.12,
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 10 },
    ...over,
  }) as unknown as SDKMessage

// A scripted stand-in for the SDK's query(): records the options it was given
// and replays messages, optionally running a callback mid-stream.
function scripted(messages: SDKMessage[], during?: (o: Options) => Promise<void>): { query: Query; calls: Options[] } {
  const calls: Options[] = []
  const query: Query = ({ options }) => {
    calls.push(options)
    return (async function* () {
      if (during) await during(options)
      for (const m of messages) yield m
    })()
  }
  return { query, calls }
}

test('the session is pinned: explicit empty settings, strict MCP, a private config dir, and one credential', async () => {
  const j = job(HARNESS())
  const { query, calls } = scripted([result()])
  await runHarness(j, query)
  const o = calls[0]!
  assert.deepEqual(o.settingSources, [])
  assert.equal(o.strictMcpConfig, true)
  assert.deepEqual(o.mcpServers, {})
  assert.equal(o.cwd, j.workdir.dir)
  assert.equal(o.model, 'claude-opus-5-5')
  assert.equal(o.effort, 'medium')
  assert.equal(o.maxTurns, 7)
  const env = o.env!
  assert.equal(env['CLAUDE_CONFIG_DIR'], j.workdir.claudeConfig)
  assert.equal(env['CLAUDE_CODE_DISABLE_AUTO_MEMORY'], '1')
  assert.equal(env['HOME'], j.workdir.home)
  assert.equal(env['ANTHROPIC_API_KEY'], 'sk-ant-test')
  assert.equal(env['OPENROUTER_API_KEY'], undefined)
})

test('the PreToolUse hook is the gate, so read-only tools cannot slip past it', async () => {
  const j = job(HARNESS())
  const verdicts: string[] = []
  const { query } = scripted([result()], async o => {
    const hook = o.hooks!.PreToolUse![0]!.hooks[0]!
    const ask = async (tool_name: string, tool_input: unknown) => {
      const out = (await hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't' } as never, 't', { signal: new AbortController().signal })) as {
        hookSpecificOutput: { permissionDecision: string }
      }
      verdicts.push(`${tool_name}:${out.hookSpecificOutput.permissionDecision}`)
    }
    await ask('Read', { file_path: 'a.go' })
    await ask('Read', { file_path: join(j.case.dir, 'truth.yaml') })
    await ask('Bash', { command: 'cat ~/.aws/credentials' })
    const denied = await o.canUseTool!('Bash', { command: 'ls' }, { signal: new AbortController().signal } as never)
    verdicts.push(`canUseTool:${denied?.behavior}`)
  })
  await runHarness(j, query)
  assert.deepEqual(verdicts, ['Read:allow', 'Read:deny', 'Bash:deny', 'canUseTool:deny'])
  const denials = readFileSync(j.out.transcript, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.kind === 'denied')
  assert.equal(denials.length, 3)
})

test('messages map onto the transcript, and the result onto usage, cost, final message and written files', async () => {
  const j = job(HARNESS())
  const { query } = scripted(
    [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.go' } }] }, parent_tool_use_id: null } as unknown as SDKMessage,
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'package a' }] }, parent_tool_use_id: null } as unknown as SDKMessage,
      result(),
    ],
    async o => writeFileSync(join(o.cwd!, 'findings.json'), '{"findings":[]}'),
  )
  const r = await runHarness(j, query)
  assert.equal(r.exit, 'ok')
  assert.deepEqual(r.usage, { input_tokens: 115, output_tokens: 20, cost_usd: 0.12 })
  assert.equal(readFileSync(r.artifacts['final_message.txt']!, 'utf8'), 'All good.')
  assert.equal(readFileSync(r.artifacts['findings.json']!, 'utf8'), '{"findings":[]}')
  const kinds = readFileSync(r.transcript, 'utf8').trim().split('\n').map(l => JSON.parse(l).kind)
  assert.deepEqual(kinds, ['message', 'tool_call', 'tool_result', 'usage'])
})

test('max turns is a model failure; an API error turn is an infra error by its status, never a graded answer', async () => {
  assert.equal((await runHarness(job(HARNESS()), scripted([result({ subtype: 'error_max_turns', errors: [] })]).query)).exit, 'model_failure')
  // The SDK reports an API error turn as a success result with is_error set and the error as its result text.
  const apiError = (status: number) => result({ is_error: true, api_error_status: status, result: `API Error: ${status} {"type":"error"}` })
  const auth = await runHarness(job(HARNESS()), scripted([apiError(401)]).query)
  assert.deepEqual([auth.exit, auth.retryable], ['infra_error', false])
  const busy = await runHarness(job(HARNESS()), scripted([apiError(529)]).query)
  assert.deepEqual([busy.exit, busy.retryable], ['infra_error', true])
  assert.match(busy.reason ?? '', /api error 529\): API Error: 529/)
  assert.notEqual(readFileSync(busy.artifacts['final_message.txt']!, 'utf8'), 'API Error: 529 {"type":"error"}')
  const crashed = await runHarness(job(HARNESS()), scripted([result({ subtype: 'error_during_execution', is_error: true, errors: ['spawn failed'] })]).query)
  assert.deepEqual([crashed.exit, crashed.retryable], ['infra_error', true])
  assert.match(crashed.reason ?? '', /spawn failed/)
})

test('tokens are counted across every model in the session, subagents included', async () => {
  const r = await runHarness(
    job(HARNESS()),
    scripted([
      result({
        total_cost_usd: 0.5,
        modelUsage: {
          'claude-opus-5-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, costUSD: 0.4 },
          'claude-haiku-4-5': { inputTokens: 300, outputTokens: 60, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.1 },
        },
      }),
    ]).query,
  )
  assert.deepEqual(r.usage, { input_tokens: 415, output_tokens: 80, cost_usd: 0.5 })
})

test('without an API key, or on a provider the harness cannot use, nothing runs', async () => {
  const { query, calls } = scripted([result()])
  delete process.env['ANTHROPIC_API_KEY']
  const noKey = await runHarness(job(HARNESS()), query)
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test'
  assert.deepEqual([noKey.exit, noKey.retryable], ['infra_error', false])
  const or = await runHarness(job(HARNESS(), {}, { provider: 'openrouter', model: 'x/y' }), query)
  assert.match(or.reason ?? '', /cannot run on the openrouter provider/)
  assert.equal(calls.length, 0)
})

test('a plugin that declares hooks is refused unless the case sets allow_hooks', async () => {
  const files = { 'plugin/hooks/hooks.json': '{}', 'plugin/.claude-plugin/plugin.json': '{"name":"p"}' }
  const { query, calls } = scripted([result()])
  const refused = await runHarness(job(HARNESS('  plugins: [plugin]\n'), files), query)
  assert.match(refused.reason ?? '', /has hooks\/hooks\.json; set allow_hooks: true/)
  assert.equal(calls.length, 0)
  const allowed = await runHarness(job(HARNESS('  plugins: [plugin]\n  allow_hooks: true\n'), files), query)
  assert.equal(allowed.exit, 'ok')
  assert.equal(calls[0]!.plugins![0]!.path.endsWith('/plugin'), true)
})

test('under project settings, a fixture\'s settings may set only $schema', async () => {
  const project = HARNESS('  setting_sources: [project]\n')
  const run = (settings: string, file = 'fixture/.claude/settings.json') => runHarness(job(project, { [file]: settings }), scripted([result()]).query)
  assert.equal((await run('{"$schema":"https://json.schemastore.org/claude-code-settings.json"}')).exit, 'ok')
  for (const [settings, re] of [
    ['{"hooks":{}}', /sets hooks; .* may set only \$schema/],
    ['{"permissions":{"allow":["Bash"]}}', /sets permissions/],
    ['{"env":{"X":"1"}}', /sets env/],
    ['not json', /not valid JSON/],
  ] as const) {
    const r = await run(settings)
    assert.deepEqual([r.exit, r.retryable], ['infra_error', false], settings)
    assert.match(r.reason ?? '', re, settings)
  }
  assert.match((await run('{"env":{}}', 'fixture/.claude/settings.local.json')).reason ?? '', /settings\.local\.json sets env/)
})

test('the session sets permissionMode default and removes the tool classes the case has not allowed', async () => {
  const { query, calls } = scripted([result()])
  await runHarness(job(HARNESS()), query)
  assert.equal(calls[0]!.permissionMode, 'default')
  assert.deepEqual(calls[0]!.disallowedTools, ['Bash', 'BashOutput', 'KillShell', 'KillBash', 'WebFetch', 'WebSearch'])
  await runHarness(job(HARNESS('  allow_shell: true\n')), query)
  assert.deepEqual(calls[1]!.disallowedTools, ['WebFetch', 'WebSearch'])
})

test('the harness prompt is rendered with the model prompt\'s placeholders', async () => {
  const yaml = HARNESS().replace('prompt: /review', 'prompt: "/review {{file:a.go}}"')
  const prompts: string[] = []
  const q: Query = ({ prompt, options }) => (prompts.push(prompt), scripted([result()]).query({ prompt, options }))
  await runHarness(job(yaml), q)
  assert.match(prompts[0]!, /^\/review === a\.go ===\n1 \| package a/)
})

test('a suite root is never readable, even inside a plugin, and a directory subject is its own read root', async () => {
  const pluginRoot = realpathSync(tree({ 'SKILL.md': 's', 'evals/private/case.yaml': 'secret' }))
  let policyChecks: { allow: boolean }[] = []
  const { query } = scripted([result()], async o => {
    const hook = o.hooks!.PreToolUse![0]!.hooks[0]!
    const ask = async (file_path: string) => {
      const out = (await hook({ tool_name: 'Read', tool_input: { file_path } } as never, undefined, { signal: new AbortController().signal })) as { hookSpecificOutput: { permissionDecision: string } }
      policyChecks.push({ allow: out.hookSpecificOutput.permissionDecision === 'allow' })
    }
    await ask(join(o.plugins![0]!.path, 'SKILL.md'))
    await ask(join(o.plugins![0]!.path, 'evals/private/case.yaml'))
    await ask(join(o.plugins![0]!.path, '../sibling/x.md'))
  })
  const j = job(HARNESS(`  plugins: [${pluginRoot}]\n`).replace('name: c\n', `name: c\nsubject: ${pluginRoot}\n`))
  j.suiteRoots = [join(pluginRoot, 'evals')]
  await runHarness(j, query)
  assert.deepEqual(policyChecks.map(p => p.allow), [true, false, false])
  policyChecks = []
})

const hang: Query = ({ options }) =>
  (async function* (): AsyncGenerator<SDKMessage> {
    await new Promise((_ok, fail) => options.abortController!.signal.addEventListener('abort', () => fail(new Error('aborted'))))
  })()

test('a timeout is a model failure and a cancel is cancelled', async () => {
  const slow = job(HARNESS().replace('timeout_s: 5', 'timeout_s: 1'))
  assert.equal((await runHarness(slow, hang)).exit, 'model_failure')
  const ctl = new AbortController()
  const pending = runHarness(job(HARNESS(), {}, undefined, ctl.signal), hang)
  setTimeout(() => ctl.abort(), 20)
  assert.equal((await pending).exit, 'cancelled')
})

const ask = async (o: Options, tool_name: string, tool_input: Record<string, unknown>) => {
  const hook = o.hooks!.PreToolUse![0]!.hooks[0]!
  const out = (await hook({ tool_name, tool_input } as never, undefined, { signal: new AbortController().signal })) as { hookSpecificOutput: { permissionDecision: string } }
  return out.hookSpecificOutput.permissionDecision
}

test('the case, its suite and its root are denied even when the caller passes no suite roots', async () => {
  const decisions: string[] = []
  const j = job(HARNESS(), { 'truth.yaml': 'kind: clean\n' })
  const { query } = scripted([result()], async o => {
    decisions.push(await ask(o, 'Read', { file_path: join(j.case.dir, 'truth.yaml') }))
  })
  await runHarness(j, query)
  assert.deepEqual(decisions, ['deny'])
})

test('under project settings the subject may not write .claude, .mcp.json or the reserved final_message.txt', async () => {
  const decisions: string[] = []
  const { query } = scripted([result()], async o => {
    for (const file_path of ['.claude/settings.json', '.CLAUDE/skills/x/SKILL.md', '.mcp.json', 'final_message.txt', 'notes.md']) decisions.push(await ask(o, 'Write', { file_path }))
  })
  await runHarness(job(HARNESS('  setting_sources: [project]\n')), query)
  assert.deepEqual(decisions, ['deny', 'deny', 'deny', 'deny', 'allow'])
})

test('a plugin manifest key outside the allowlist, or hooks in component frontmatter, needs allow_hooks', async () => {
  const run = (files: Record<string, string>, extra = '') => runHarness(job(HARNESS(`  plugins: [plugin]\n${extra}`), files), scripted([result()]).query)
  assert.match((await run({ 'plugin/.claude-plugin/plugin.json': '{"name":"p","lspServers":{}}' })).reason ?? '', /plugin\.json declares lspServers/)
  assert.match((await run({ 'plugin/.lsp.json': '{}' })).reason ?? '', /has \.lsp\.json/)
  assert.match((await run({ 'plugin/skills/review/SKILL.md': '---\nname: review\nhooks:\n  PreToolUse: []\n---\nbody' })).reason ?? '', /skills\/review\/SKILL\.md declares hooks in its frontmatter/)
  assert.equal((await run({ 'plugin/.claude-plugin/plugin.json': '{"name":"p","version":"1","author":{"name":"a"},"keywords":[]}', 'plugin/skills/r/SKILL.md': '---\nname: r\n---\nx' })).exit, 'ok')
  assert.equal((await run({ 'plugin/.lsp.json': '{}' }, '  allow_hooks: true\n')).exit, 'ok')
  const fixture = await runHarness(job(HARNESS('  setting_sources: [project]\n'), { 'fixture/.claude/agents/a.md': '---\nmcpServers: {}\n---\n' }), scripted([result()]).query)
  assert.match(fixture.reason ?? '', /the fixture: agents\/a\.md declares mcpServers/)
})

test('a stream that ends quietly after the clock stops is classified by the clock', async () => {
  const quiet = (then: SDKMessage[]): Query => ({ options }) =>
    (async function* () {
      await new Promise(ok => options.abortController!.signal.addEventListener('abort', ok))
      for (const m of then) yield m
    })()
  const ctl = new AbortController()
  const cancelled = runHarness(job(HARNESS(), {}, undefined, ctl.signal), quiet([]))
  setTimeout(() => ctl.abort(), 20)
  assert.equal((await cancelled).exit, 'cancelled')
  const timedOut = await runHarness(job(HARNESS().replace('timeout_s: 5', 'timeout_s: 1')), quiet([result({ subtype: 'error_during_execution', is_error: true, errors: ['aborted'] })]))
  assert.equal(timedOut.exit, 'model_failure')
  assert.ok(timedOut.artifacts['final_message.txt'], 'a timeout keeps what the subject wrote, like max_turns')
})

test('an API-error turn with no status retries, unless its text says auth or billing', async () => {
  const noStatus = (text: string) => runHarness(job(HARNESS()), scripted([result({ is_error: true, result: text })]).query)
  assert.equal((await noStatus('API Error: Connection error.')).retryable, true)
  assert.equal((await noStatus('Invalid API key · Please run /login')).retryable, false)
  assert.equal((await noStatus('Credit balance is too low')).retryable, false)
})
