import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
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
    workdir: buildWorkdir(c, { run: 'r', key: 's/c@opus#1', attempt: 1 }, base),
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

test('max turns is a model failure; an API 401 fails fast and a 529 retries', async () => {
  assert.equal((await runHarness(job(HARNESS()), scripted([result({ subtype: 'error_max_turns' })]).query)).exit, 'model_failure')
  const auth = await runHarness(job(HARNESS()), scripted([result({ subtype: 'error_during_execution', is_error: true, api_error_status: 401 })]).query)
  assert.deepEqual([auth.exit, auth.retryable], ['infra_error', false])
  const busy = await runHarness(job(HARNESS()), scripted([result({ subtype: 'error_during_execution', is_error: true, api_error_status: 529 })]).query)
  assert.deepEqual([busy.exit, busy.retryable], ['infra_error', true])
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
  assert.match(refused.reason ?? '', /declares hooks or MCP servers/)
  assert.equal(calls.length, 0)
  const allowed = await runHarness(job(HARNESS('  plugins: [plugin]\n  allow_hooks: true\n'), files), query)
  assert.equal(allowed.exit, 'ok')
  assert.equal(calls[0]!.plugins![0]!.path.endsWith('/plugin'), true)
})

test('a fixture with project hooks is refused when its project settings would load them', async () => {
  const { query } = scripted([result()])
  const r = await runHarness(job(HARNESS('  setting_sources: [project]\n'), { 'fixture/.claude/settings.json': '{"hooks":{}}' }), query)
  assert.match(r.reason ?? '', /the fixture declares hooks/)
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
