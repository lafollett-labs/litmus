import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decide, type GatePolicy } from '../../src/executors/gate.ts'
import { tree } from '../helpers/tmp.ts'

const root = realpathSync(tree({ 'work/src/a.ts': 'x', 'plugin/skills/review/SKILL.md': 'y', 'case/truth.yaml': 'secret' }))
const work = join(root, 'work')
symlinkSync(join(root, 'case/truth.yaml'), join(work, 'innocent.txt'))
mkdirSync(join(work, 'nested'), { recursive: true })
symlinkSync('/etc', join(work, 'nested/etc'))
writeFileSync(join(root, 'outside.txt'), 'z')

const base: GatePolicy = { workdir: work, readRoots: [join(root, 'plugin')], denyRoots: [], allowShell: false, allowNetwork: false, allowHooks: false }
const allowed = (tool: string, input: Record<string, unknown>, p = base) => decide(tool, input, p).allow

test('reads and writes inside the workdir are allowed, by relative or absolute path', () => {
  assert.ok(allowed('Read', { file_path: 'src/a.ts' }))
  assert.ok(allowed('Read', { file_path: join(work, 'src/a.ts') }))
  assert.ok(allowed('Write', { file_path: 'findings.json' }))
  assert.ok(allowed('Edit', { file_path: join(work, 'src/new/deep.ts') }))
  assert.ok(allowed('Glob', { pattern: 'src/**/*.ts' }))
  assert.ok(allowed('Grep', { pattern: 'TODO' }))
})

test('reads and writes outside the workdir are refused, including through ..', () => {
  assert.equal(allowed('Read', { file_path: join(root, 'outside.txt') }), false)
  assert.equal(allowed('Read', { file_path: '../case/truth.yaml' }), false)
  assert.equal(allowed('Write', { file_path: '/tmp/x' }), false)
  assert.equal(allowed('Glob', { pattern: '/etc/**' }), false)
  assert.equal(allowed('Grep', { pattern: 'x', path: '/' }), false)
})

test('a symlink is judged by where it lands, not by its name', () => {
  assert.equal(allowed('Read', { file_path: 'innocent.txt' }), false)
  assert.equal(allowed('Read', { file_path: 'nested/etc/hosts' }), false)
  assert.equal(allowed('Glob', { pattern: 'nested/etc/*' }), false)
})

test('plugin and subject roots are readable but never writable', () => {
  const skill = join(root, 'plugin/skills/review/SKILL.md')
  assert.ok(allowed('Read', { file_path: skill }))
  assert.equal(allowed('Edit', { file_path: skill }), false)
})

test('shell, network and MCP tools need their flags, and MCP needs both network and hooks', () => {
  assert.equal(allowed('Bash', { command: 'ls' }), false)
  assert.ok(allowed('Bash', { command: 'ls' }, { ...base, allowShell: true }))
  assert.equal(allowed('WebFetch', { url: 'https://x' }), false)
  assert.ok(allowed('WebFetch', { url: 'https://x' }, { ...base, allowNetwork: true }))
  assert.equal(allowed('mcp__github__create_issue', {}, { ...base, allowNetwork: true }), false)
  assert.ok(allowed('mcp__github__create_issue', {}, { ...base, allowNetwork: true, allowHooks: true }))
})

test('subagents and bookkeeping tools are allowed; a tool the gate does not know is refused', () => {
  for (const t of ['Agent', 'Task', 'TodoWrite', 'Skill']) assert.ok(allowed(t, {}), t)
  const d = decide('SomeNewTool', {}, base)
  assert.equal(d.allow, false)
  assert.match(!d.allow ? d.reason : '', /not a tool litmus allows/)
})

test('a pattern is judged from the tool\'s own search path', () => {
  assert.equal(allowed('Glob', { path: join(root, 'plugin'), pattern: '../case/*' }), false)
  assert.equal(allowed('Glob', { path: join(root, 'plugin'), pattern: 'skills/*' }), true)
})

test('a suite root is never readable, even inside a plugin root', () => {
  const p = { ...base, denyRoots: [join(root, 'plugin/skills')] }
  assert.equal(allowed('Read', { file_path: join(root, 'plugin/skills/review/SKILL.md') }, p), false)
  // A search that would descend into a suite root is refused too, from any base above it.
  assert.equal(allowed('Grep', { path: join(root, 'plugin'), pattern: 'secret' }, p), false)
  assert.equal(allowed('Glob', { path: join(root, 'plugin'), pattern: 'skills/**' }, p), false)
  assert.equal(allowed('Glob', { path: join(root, 'plugin'), pattern: '**/*.md' }, p), false)
  assert.equal(allowed('LS', { path: join(root, 'plugin') }, p), true) // one level of names, not a descent
  assert.equal(allowed('Read', { file_path: join(root, 'plugin/skills/review/SKILL.md') }), true)
})

test('nothing may write under the workdir .git, though it may be read', () => {
  mkdirSync(join(work, '.git'), { recursive: true })
  assert.equal(allowed('Write', { file_path: join(work, '.git/hooks/post-checkout') }), false)
  assert.equal(allowed('Edit', { file_path: '.git/config' }), false)
  assert.equal(allowed('Read', { file_path: '.git/HEAD' }), true)
})

test('a pattern that climbs with .. after a wildcard, or a ~ path, is refused', () => {
  assert.equal(allowed('Glob', { pattern: '*/../../etc/passwd' }), false)
  assert.equal(allowed('Grep', { pattern: 'x', glob: '**/../../../**' }), false)
  assert.equal(allowed('Read', { file_path: '~/.aws/credentials' }), false)
  assert.equal(allowed('Glob', { pattern: 'src/**/*.ts' }), true)
})

test('writing through a dangling symlink is refused: it would create the target, wherever it is', () => {
  symlinkSync(join(root, 'created-outside.txt'), join(work, 'dangling'))
  assert.equal(allowed('Write', { file_path: join(work, 'dangling') }), false)
  assert.equal(allowed('Write', { file_path: 'dangling/child.txt' }), false)
})

test('a non-string path is refused rather than guessed at', () => {
  assert.equal(allowed('Read', { file_path: ['a', 'b'] }), false)
})

test('the gate fails closed: a path it cannot judge is a denial, not a throw', () => {
  const d = decide('Read', { file_path: join(work, 'src/a.ts/x') }, base) // ENOTDIR through a file
  assert.equal(d.allow, false)
})

test('a subagent is allowed only in this session: worktree or remote isolation is refused', () => {
  assert.equal(allowed('Agent', { prompt: 'p', description: 'd' }), true)
  assert.equal(allowed('Agent', { prompt: 'p', isolation: 'worktree' }), false)
  assert.equal(allowed('Task', { prompt: 'p', isolation: 'remote' }), false)
})

test('brace and class forms that could climb or go absolute are refused', () => {
  for (const pattern of ['{..,src}/*', '{/etc,src}/*', 'src/{a,../../x}/*', '[/]etc/*', 'src/**/~/x']) {
    assert.equal(allowed('Glob', { pattern }), false, pattern)
  }
  assert.equal(allowed('Glob', { pattern: 'src/{a,b}.ts' }), true)
})

// Only meaningful where the volume ignores case, as default APFS does.
const caseInsensitive = (() => {
  try {
    return realpathSync.native(join(work, 'SRC')) === join(work, 'src')
  } catch {
    return false
  }
})()

test('a case variant cannot get past the .git refusal or into a suite root', { skip: caseInsensitive ? false : 'case-sensitive filesystem' }, () => {
  mkdirSync(join(work, '.git/hooks'), { recursive: true })
  assert.equal(allowed('Write', { file_path: join(work, '.GIT/hooks/post-checkout') }), false)
  assert.equal(allowed('Write', { file_path: '.Git/config' }), false)
  const reserved = { ...base, protect: ['final_message.txt'] }
  assert.equal(allowed('Write', { file_path: 'final_me\u017f\u017fage.txt' }, reserved), false) // ſ folds to s
  const p = { ...base, denyRoots: [join(root, 'plugin/skills')] }
  assert.equal(allowed('Read', { file_path: join(root, 'plugin/SKILLS/review/SKILL.md') }, p), false)
})
