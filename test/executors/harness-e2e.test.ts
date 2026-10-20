import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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

type Setup = { prompt?: string; executor?: string; files?: Record<string, string>; fill?: (caseDir: string, c: ExecJob['case']) => void }

async function session(script: (p: { truth: string; caseDir: string; secret: string }) => Script, setup: Setup = {}) {
  const { c, base } = oneCase(`name: c\nexecutor:\n  kind: harness\n  harness: claude-code\n  prompt: ${JSON.stringify(setup.prompt ?? 'Review a.go')}\n  max_turns: 20\n${setup.executor ?? ''}graders: [{ kind: regex, pattern: x }]\ntimeout_s: 100\n`, {
    'fixture/a.go': 'package a\n',
    'truth.yaml': `kind: clean\n# ${TRUTH_CANARY}\n`,
    // A name only a listing of the case directory would show.
    [LISTING_CANARY]: '',
    ...setup.files,
  })
  const secret = join(realpathSync(tree({ '.aws/credentials': `[default]\naws_secret_access_key = ${FILE_CANARY}\n` })), '.aws/credentials')
  const caseDir = realpathSync(c.dir)
  // Case files the setup wrote with placeholders only it can resolve now.
  setup.fill?.(caseDir, c)
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

test('real Claude Code: no @ mention is read from a plugin body, skill args, the prompt, a fixture or a diff, and skills stay listed', { skip, timeout: 120_000 }, async () => {
  // One canary per place, outside every root, so a control run shows which place leaked.
  const VECTORS = ['body', 'root', 'args', 'cjk', 'prompt', 'fixture', 'diff'] as const
  const secrets = realpathSync(tree({ ...Object.fromEntries(VECTORS.filter(v => v !== 'root').map(v => [`${v}.txt`, `MENTION-CANARY-${v}\n`])), 'x': 'MENTION-CANARY-root\n' }))
  const at = (v: (typeof VECTORS)[number]) => join(secrets, `${v}.txt`)
  const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: SKILL-DESC-${name}\n---\nBODY-${name} ${body}\n`
  const plugin = join(secrets, 'plugin')
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), '{"name":"rev"}')
  for (const [name, body] of [['abs', `context @${at('body')}`], ['root', 'context @${CLAUDE_PLUGIN_ROOT}/../x'], ['files', 'Review the file @$ARGUMENTS'], ['cjk', '审查文件。@$ARGUMENTS']]) {
    mkdirSync(join(plugin, 'skills', name!), { recursive: true })
    writeFileSync(join(plugin, 'skills', name!, 'SKILL.md'), skill(name!, body!))
  }
  const { r, bodies } = await session(
    () => ({
      main: [
        [{ type: 'tool_use', id: 'toolu_01', name: 'Skill', input: { skill: 'rev:abs' } }],
        [{ type: 'tool_use', id: 'toolu_02', name: 'Skill', input: { skill: 'rev:root' } }],
        [{ type: 'tool_use', id: 'toolu_03', name: 'Skill', input: { skill: 'rev:files', args: at('args') } }],
        [{ type: 'tool_use', id: 'toolu_04', name: 'Skill', input: { skill: 'rev:cjk', args: `"${at('cjk')}"x` } }],
      ],
    }),
    {
      prompt: `Review @${at('prompt')} and:\n{{file:notes.txt}}\n{{diff}}`,
      files: { 'fixture/notes.txt': `x。@${at('fixture')}\n`, 'fixture/d.txt': 'old\n' },
      fill: (caseDir, c) => {
        writeFileSync(join(caseDir, 'change.patch'), `--- a/d.txt\n+++ b/d.txt\n@@ -1 +1 @@\n-old\n+y、@${at('diff')}\n`)
        c.changePatch = join(caseDir, 'change.patch')
        c.plugins = [plugin]
      },
    },
  )
  assert.equal(r.exit, 'ok', r.reason ?? '')
  const sent = JSON.stringify(bodies)
  assert.deepEqual(VECTORS.filter(v => sent.includes(`MENTION-CANARY-${v}`)), [], 'a mentioned file was read')
  // The first main-loop request, before any skill has run.
  const first = JSON.stringify(bodies.find(b => Array.isArray(b['tools']) && (b['tools'] as unknown[]).length > 0))
  for (const name of ['abs', 'root', 'files', 'cjk']) {
    assert.ok(sent.includes(`BODY-${name}`), `the ${name} skill body never reached the model`)
    // The listing is how a subject finds a skill its prompt does not name.
    assert.ok(first.includes(`SKILL-DESC-${name}`), `the ${name} skill was not listed`)
  }
})

// Claude Code itself refuses a CLAUDE.md import from outside the project, not
// eval-confined mode, so this watches for an SDK that stops refusing it.
test('real Claude Code: a CLAUDE.md, the fixture\'s or one the subject writes, imports nothing from outside the workdir', { skip, timeout: 120_000 }, async () => {
  const secrets = realpathSync(tree({ 'root.txt': 'IMPORT-CANARY-root\n', 'nested.txt': 'IMPORT-CANARY-nested\n', 'written.txt': 'IMPORT-CANARY-written\n' }))
  const { r, bodies } = await session(
    () => ({
      main: [
        [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: 'sub/x.txt' } }],
        // Written by the subject, then a Read beside it.
        [{ type: 'tool_use', id: 'toolu_02', name: 'Write', input: { file_path: 'sub2/CLAUDE.md', content: `WRITTEN-MARK @${join(secrets, 'written.txt')}\n` } }],
        [{ type: 'tool_use', id: 'toolu_03', name: 'Read', input: { file_path: 'sub2/y.txt' } }],
      ],
    }),
    {
      executor: '  setting_sources: [project]\n',
      files: {
        'fixture/CLAUDE.md': `ROOT-MARK @${join(secrets, 'root.txt')}\n`,
        'fixture/sub/CLAUDE.md': `NESTED-MARK @${join(secrets, 'nested.txt')}\n`,
        'fixture/sub/x.txt': 'x\n',
        'fixture/sub2/y.txt': 'y\n',
      },
    },
  )
  assert.equal(r.exit, 'ok', r.reason ?? '')
  const sent = JSON.stringify(bodies)
  // Each CLAUDE.md loaded, so each import was offered the chance to leak.
  for (const mark of ['ROOT-MARK', 'NESTED-MARK']) assert.ok(sent.includes(mark), `${mark} never loaded`)
  // 0.3.281 does not load, as memory, a CLAUDE.md the session wrote itself, so
  // its import is not attempted. If an SDK starts loading it, the canary check
  // below covers it.
  assert.ok(!sent.includes('IMPORT-CANARY'), 'a CLAUDE.md imported a file outside the workdir')
})
