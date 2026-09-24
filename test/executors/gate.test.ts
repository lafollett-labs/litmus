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

const base: GatePolicy = { workdir: work, readRoots: [join(root, 'plugin')], allowShell: false, allowNetwork: false, allowHooks: false }
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

test('a non-string path is refused rather than guessed at', () => {
  assert.equal(allowed('Read', { file_path: ['a', 'b'] }), false)
})
