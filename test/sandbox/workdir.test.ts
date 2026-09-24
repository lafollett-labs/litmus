import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigError, InfraError } from '../../src/core/errors.ts'
import { scrubbedEnv } from '../../src/sandbox/env.ts'
import { snapshot, written } from '../../src/sandbox/snapshot.ts'
import { buildWorkdir } from '../../src/sandbox/workdir.ts'
import { oneCase } from '../helpers/cases.ts'
import { tree } from '../helpers/tmp.ts'

const CASE = 'name: c\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: regex, pattern: x }]\n'
const where = { run: '2026-09-24T12-00-00Z-a1b2', key: 's/c@fake#1', attempt: 1 }
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim()

test('only the fixture reaches the workdir: truth, proof, fix, fake and case.yaml stay behind', () => {
  const { c, base } = oneCase(CASE, {
    'fixture/src/a.go': 'package a\n',
    'truth.yaml': 'kind: clean\n',
    'proof/src/a_test.go': 'package a\n',
    'fix/b.patch': 'x',
    'fake.yaml': 'responses: [{ text: hi }]\n',
  })
  const w = buildWorkdir(c, where, base)
  try {
    assert.deepEqual(readdirSync(w.dir).sort(), ['.git', 'src'])
    assert.deepEqual(readdirSync(join(w.dir, 'src')), ['a.go'])
    assert.ok(!w.dir.startsWith(c.dir) && !c.dir.startsWith(w.root))
  } finally {
    w.cleanup()
  }
  assert.equal(existsSync(w.root), false)
})

test('the fixture is committed on main and the change on litmus/change, which is HEAD', () => {
  const { c, base } = oneCase(CASE, {
    'fixture/a.txt': 'one\n',
    'change.patch': 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n',
  })
  const w = buildWorkdir(c, where, base)
  try {
    assert.equal(git(w.dir, 'branch', '--show-current'), 'litmus/change')
    assert.equal(readFileSync(join(w.dir, 'a.txt'), 'utf8'), 'two\n')
    assert.equal(git(w.dir, 'show', 'main:a.txt'), 'one')
  } finally {
    w.cleanup()
  }
})

test('a symlink in the fixture is refused', () => {
  const { c, base } = oneCase(CASE, { 'fixture/a.txt': 'x' })
  symlinkSync(join(c.dir, 'truth.yaml'), join(c.fixtureDir!, 'peek'))
  assert.throws(() => buildWorkdir(c, where, base), (e: Error) => e instanceof ConfigError && /symlink/.test(e.message))
})

test('a symlink created by change.patch is refused after the patch applies', () => {
  const { c, base } = oneCase(CASE, {
    'fixture/a.txt': 'x\n',
    'change.patch': 'diff --git a/peek b/peek\nnew file mode 120000\n--- /dev/null\n+++ b/peek\n@@ -0,0 +1 @@\n+/etc/hosts\n\\ No newline at end of file\n',
  })
  assert.throws(() => buildWorkdir(c, where, base), (e: Error) => e instanceof ConfigError && /creates symlinks/.test(e.message))
})

test('a fixture that carries its own .git directory is refused', () => {
  const { c, base } = oneCase(CASE, { 'fixture/.git/config': '[core]\n\tfsmonitor = touch /tmp/pwned\n', 'fixture/a.txt': 'x' })
  assert.throws(() => buildWorkdir(c, where, base), /\.git directory/)
})

test('a patch that does not apply is a config error that names the case', () => {
  const { c, base } = oneCase(CASE, { 'fixture/a.txt': 'x\n', 'change.patch': 'diff --git a/nope b/nope\n--- a/nope\n+++ b/nope\n@@ -1 +1 @@\n-a\n+b\n' })
  assert.throws(() => buildWorkdir(c, where, base), (e: Error) => e instanceof ConfigError && /s\/c: change.patch does not apply/.test(e.message))
})

test('a workdir under a directory holding CLAUDE.md, CLAUDE.local.md or AGENTS.md is refused', () => {
  for (const f of ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']) {
    const { c } = oneCase(CASE, { 'fixture/a.txt': 'x' })
    const repo = tree({ [f]: '# rules' })
    assert.throws(() => buildWorkdir(c, where, repo), (e: Error) => e instanceof InfraError && !e.retryable && new RegExp(f).test(e.message), f)
  }
})

test('a FIFO or other special file in the fixture is refused', () => {
  const { c, base } = oneCase(CASE, { 'fixture/a.txt': 'x' })
  spawnSync('mkfifo', [join(c.fixtureDir!, 'pipe')])
  assert.throws(() => buildWorkdir(c, where, base), (e: Error) => e instanceof ConfigError && /pipe, which is neither a regular file nor a directory/.test(e.message))
})

test('a run id or attempt outside its grammar never reaches the recursive delete', () => {
  const { c, base } = oneCase(CASE, { 'fixture/a.txt': 'x' })
  assert.throws(() => buildWorkdir(c, { ...where, run: '../..' }, base), /not a run id/)
  assert.throws(() => buildWorkdir(c, { ...where, attempt: 0 }, base), /not an attempt number/)
})

test('every attempt gets a fresh workdir, even for the same trial', () => {
  const { c, base } = oneCase(CASE, { 'fixture/a.txt': 'x' })
  const first = buildWorkdir(c, where, base)
  writeFileSync(join(first.dir, 'leftover.txt'), 'from attempt 1')
  const again = buildWorkdir(c, where, base)
  try {
    assert.equal(existsSync(join(again.dir, 'leftover.txt')), false)
  } finally {
    again.cleanup()
  }
})

test('what the subject wrote is found by snapshot, and a planted .git hook never runs', () => {
  const { c, base } = oneCase(CASE, { 'fixture/a.txt': 'x' })
  const w = buildWorkdir(c, where, base)
  const marker = join(w.root, 'hook-ran')
  try {
    writeFileSync(join(w.dir, '.git/config'), `[core]\n\tfsmonitor = "touch ${marker}"\n\thooksPath = hooks\n`)
    writeFileSync(join(w.dir, 'findings.json'), '{}')
    writeFileSync(join(w.dir, 'a.txt'), 'changed')
    assert.deepEqual(written(w.before, snapshot(w.dir)), ['a.txt', 'findings.json'])
    assert.equal(existsSync(marker), false)
  } finally {
    w.cleanup()
  }
})

test('child environments keep the allowlist, redirect HOME, and drop every key', () => {
  const env = scrubbedEnv(
    { home: '/tmp/h', extra: { CLAUDE_CONFIG_DIR: '/tmp/c' } },
    { PATH: '/bin', LANG: 'C', LC_ALL: 'C', HOME: '/Users/me', ANTHROPIC_API_KEY: 'sk-ant', AWS_SECRET_ACCESS_KEY: 's', GITHUB_TOKEN: 'ghp', SOMETHING_NEW: 'x' },
  )
  assert.deepEqual(env, { PATH: '/bin', LANG: 'C', LC_ALL: 'C', HOME: '/tmp/h', CLAUDE_CONFIG_DIR: '/tmp/c' })
})
