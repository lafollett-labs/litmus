import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
const LISTING_CANARY = 'LISTING-CANARY-5e0d.txt'

type Setup = { prompt?: string; executor?: string; files?: Record<string, string> }

async function session(script: (p: { truth: string; caseDir: string; secret: string }) => Script, setup: Setup = {}) {
  const { c, base } = oneCase(`name: c\nexecutor:\n  kind: harness\n  harness: claude-code\n  prompt: ${JSON.stringify(setup.prompt ?? 'Review a.go')}\n  max_turns: 20\n${setup.executor === 'PLUGIN' ? '' : (setup.executor ?? '')}graders: [{ kind: regex, pattern: x }]\ntimeout_s: 100\n`, {
    'fixture/a.go': 'package a\n',
    'truth.yaml': `kind: clean\n# ${TRUTH_CANARY}\n`,
    // A name only a listing of the case directory would show.
    [LISTING_CANARY]: '',
    ...setup.files,
  })
  const secret = join(realpathSync(tree({ '.aws/credentials': `[default]\naws_secret_access_key = ${FILE_CANARY}\n` })), '.aws/credentials')
  const caseDir = realpathSync(c.dir)
  const truth = join(caseDir, 'truth.yaml')
  // Placeholders the setup could not know: the case directory exists only now.
  const fill = (s: string) => s.replaceAll('PROMPT_TRUTH', truth).replaceAll('FIXTURE_TRUTH', truth)
  c.prompt = fill(c.prompt)
  for (const f of Object.keys(setup.files ?? {})) if (f.startsWith('fixture/')) writeFileSync(join(caseDir, f), fill(readFileSync(join(caseDir, f), 'utf8')))
  if (setup.executor === 'PLUGIN') {
    const plugin = realpathSync(
      tree({
        '.claude-plugin/plugin.json': '{"name":"rev"}',
        'skills/abs/SKILL.md': `---\nname: abs\ndescription: abs\n---\nBODY-MARKER context @${truth} and @\${CLAUDE_PLUGIN_ROOT}/../x\n`,
        'skills/files/SKILL.md': '---\nname: files\ndescription: files\n---\nBODY-MARKER Review the file @$ARGUMENTS\n',
        'skills/cjk/SKILL.md': '---\nname: cjk\ndescription: cjk\n---\nBODY-MARKER 审查文件。@$ARGUMENTS\n',
      }),
    )
    c.plugins = [plugin]
  }
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
      // Claude Code would expand these @ mentions itself, past the hook.
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
  assert.ok(!sent.includes(LISTING_CANARY), 'the case directory was listed')
  assert.deepEqual(
    transcript.filter(e => e.kind === 'denied').map(e => e.tool),
    ['Read', 'Glob', 'Read'],
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

test('real Claude Code: no @ mention in a plugin body, a skill\'s args, the prompt or a rendered file is read', { skip, timeout: 120_000 }, async () => {
  const { r, bodies } = await session(
    ({ truth }) => ({
      main: [
        [{ type: 'tool_use', id: 'toolu_01', name: 'Skill', input: { skill: 'rev:abs' } }],
        [{ type: 'tool_use', id: 'toolu_02', name: 'Skill', input: { skill: 'rev:files', args: truth } }],
        [{ type: 'tool_use', id: 'toolu_03', name: 'Skill', input: { skill: 'rev:cjk', args: `"${truth}"x` } }],
      ],
    }),
    {
      prompt: 'Review @PROMPT_TRUTH and:\n{{file:notes.txt}}',
      executor: 'PLUGIN',
      files: { 'fixture/notes.txt': 'see @../truth.yaml\nx。@FIXTURE_TRUTH\n' },
    },
  )
  assert.equal(r.exit, 'ok', r.reason ?? '')
  const sent = JSON.stringify(bodies)
  assert.ok(sent.includes('BODY-MARKER'), 'the skill bodies never reached the model')
  assert.ok(!sent.includes(TRUTH_CANARY), 'a mentioned file was read')
})
