import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import { redactor, secretValues } from '../../src/core/redact.ts'
import { sessionTools } from '../../src/executors/gate.ts'
import { runHarness, type Query } from '../../src/executors/harness.ts'
import type { ExecJob } from '../../src/executors/types.ts'
import { buildWorkdir } from '../../src/sandbox/workdir.ts'
import { oneCase } from '../helpers/cases.ts'
import { fakeMessagesApi, type Script } from '../helpers/fake-messages-api.ts'
import { tree } from '../helpers/tmp.ts'

// The real SDK and the real Claude Code binary, against a fake Messages API on
// 127.0.0.1: $0, no key. Unit tests call the gate's hook by hand; only this
// proves Claude Code still asks it, so it is what an SDK bump has to pass.
const binary = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
const skip = (() => {
  try {
    createRequire(import.meta.url).resolve(`${binary}/package.json`)
    return false
  } catch {
    // In CI a missing binary is a failure, never a quiet skip.
    return process.env['CI'] ? false : `${binary} is not installed`
  }
})()

const TRUTH_CANARY = 'TRUTH-CANARY-7f3a'
const FILE_CANARY = 'FILE-SECRET-CANARY-91c2'

type Setup = { prompt?: string; executor?: string; files?: Record<string, string> }

async function session(script: (p: { truth: string; caseDir: string; secret: string }) => Script, setup: Setup = {}) {
  const { c, base } = oneCase(`name: c\nexecutor:\n  kind: harness\n  harness: claude-code\n  prompt: ${JSON.stringify(setup.prompt ?? 'Review a.go')}\n  max_turns: 20\n${setup.executor ?? ''}graders: [{ kind: regex, pattern: x }]\ntimeout_s: 100\n`, {
    'fixture/a.go': 'package a\n',
    'truth.yaml': `kind: clean\n# ${TRUTH_CANARY}\n`,
    ...setup.files,
  })
  const secret = join(realpathSync(tree({ '.aws/credentials': `[default]\naws_secret_access_key = ${FILE_CANARY}\n` })), '.aws/credentials')
  const caseDir = realpathSync(c.dir)
  const api = await fakeMessagesApi(script({ truth: join(caseDir, 'truth.yaml'), caseDir, secret }))
  const out = tree({ '.keep': '' })
  const suiteRoot = dirname(dirname(dirname(c.dir)))
  const saved = process.env['ANTHROPIC_API_KEY']
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-fake-e2e-000'
  const job: ExecJob = {
    key: 's/c@fake#1',
    case: c,
    configName: 'fake',
    config: { provider: 'anthropic', model: 'claude-sonnet-5' },
    trial: 1,
    attempt: 1,
    workdir: buildWorkdir(c, { run: '2026-10-19T12-00-00Z-e2e0', key: 's/c@fake#1', attempt: 1 }, base, [suiteRoot]),
    suiteRoots: [suiteRoot],
    resultsDir: join(out, 'runs'),
    out: { artifacts: join(out, 'artifacts'), transcript: join(out, 'transcript.jsonl') },
    pricing: {},
    emit: () => {},
    redact: redactor(secretValues([])),
    signal: new AbortController().signal,
  }
  // The one seam: point Claude Code at the fake API. scrubbedEnv drops
  // ANTHROPIC_BASE_URL, so it is added after the harness has built the env.
  const query: Query = ({ prompt, options }) => sdkQuery({ prompt, options: { ...options, env: { ...options.env, ANTHROPIC_BASE_URL: api.url } } })
  try {
    const r = await runHarness(job, query)
    const transcript = readFileSync(job.out.transcript, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { kind: string; tool?: string })
    return { r, transcript, bodies: api.bodies }
  } finally {
    if (saved === undefined) delete process.env['ANTHROPIC_API_KEY']
    else process.env['ANTHROPIC_API_KEY'] = saved
    job.workdir.cleanup()
    await api.close()
  }
}

test('real Claude Code: every way out of the workdir is refused, and nothing outside it reaches the model', { skip, timeout: 120_000 }, async () => {
  const { r, transcript, bodies } = await session(({ truth, caseDir, secret }) => ({
    main: [
      // Skill args expand @ mentions inside Claude Code, past the hook.
      [{ type: 'tool_use', id: 'toolu_01', name: 'Skill', input: { skill: 'loop', args: `@${caseDir}/` } }],
      [{ type: 'tool_use', id: 'toolu_02', name: 'Skill', input: { skill: 'run', args: `@${secret}` } }],
      [{ type: 'tool_use', id: 'toolu_03', name: 'Read', input: { file_path: truth } }],
      [{ type: 'tool_use', id: 'toolu_04', name: 'Glob', input: { pattern: '*', path: caseDir } }],
      [{ type: 'tool_use', id: 'toolu_05', name: 'Read', input: { file_path: 'a.go' } }],
      [{ type: 'tool_use', id: 'toolu_06', name: 'Agent', input: { description: 'look', prompt: `SUBAGENT-MARK read ${truth}`, run_in_background: false } }],
    ],
    isSub: body => JSON.stringify((body['messages'] as unknown[] | undefined)?.[0] ?? '').includes('SUBAGENT-MARK'),
    sub: [[{ type: 'tool_use', id: 'toolu_s1', name: 'Read', input: { file_path: truth } }]],
  }))
  assert.equal(r.exit, 'ok', r.reason ?? '')
  const sent = JSON.stringify(bodies)
  assert.ok(!sent.includes(TRUTH_CANARY), 'the ground truth reached the model')
  assert.ok(!sent.includes(FILE_CANARY), 'an operator file reached the model')
  assert.ok(sent.includes('package a'), 'the allowed Read of a.go never came back')
  assert.deepEqual(
    transcript.filter(e => e.kind === 'denied').map(e => e.tool),
    ['Skill', 'Skill', 'Read', 'Glob', 'Read'],
  )
})

test('real Claude Code: the model is offered only the tools the gate can allow', { skip, timeout: 120_000 }, async () => {
  for (const [flags, executor] of [
    [{ allowShell: false, allowNetwork: false }, ''],
    [{ allowShell: true, allowNetwork: true }, '  allow_shell: true\n  allow_network: true\n'],
  ] as const) {
    const { r, bodies } = await session(() => ({ main: [] }), { executor })
    assert.equal(r.exit, 'ok', r.reason ?? '')
    const loop = bodies.find(b => Array.isArray(b['tools']) && (b['tools'] as unknown[]).length > 0)!
    const offered = (loop['tools'] as { name: string }[]).map(t => t.name)
    const allowed = new Set(sessionTools(flags))
    assert.deepEqual(offered.filter(t => !allowed.has(t)), [], executor)
  }
})

test('real Claude Code: a plugin skill that puts its args in an @ mention cannot be handed a path outside the workdir', { skip, timeout: 120_000 }, async () => {
  const plugin = realpathSync(tree({ '.claude-plugin/plugin.json': '{"name":"rev"}', 'skills/files/SKILL.md': '---\nname: files\ndescription: review files\n---\nReview the file @$ARGUMENTS\n' }))
  const { r, transcript, bodies } = await session(
    ({ truth }) => ({
      main: [
        [{ type: 'tool_use', id: 'toolu_01', name: 'Skill', input: { skill: 'rev:files', args: truth } }],
        [{ type: 'tool_use', id: 'toolu_02', name: 'Skill', input: { skill: 'rev:files', args: 'a.go' } }],
      ],
    }),
    { executor: `  plugins: [${plugin}]\n` },
  )
  assert.equal(r.exit, 'ok', r.reason ?? '')
  assert.ok(!JSON.stringify(bodies).includes(TRUTH_CANARY), 'the ground truth reached the model')
  assert.deepEqual(transcript.filter(e => e.kind === 'denied').map(e => e.tool), ['Skill'])
})

test('real Claude Code: an @ mention inside a file the prompt renders is not read', { skip, timeout: 120_000 }, async () => {
  const { r, bodies } = await session(() => ({ main: [] }), { prompt: 'Review:\n{{fixture}}', files: { 'fixture/notes.txt': 'see @../truth.yaml and @/etc/hosts\n' } })
  assert.equal(r.exit, 'ok', r.reason ?? '')
  const sent = JSON.stringify(bodies)
  assert.ok(sent.includes('notes.txt'), 'the fixture was rendered')
  assert.ok(!sent.includes(TRUTH_CANARY) && !sent.includes('localhost'), 'a mentioned file was read')
})
