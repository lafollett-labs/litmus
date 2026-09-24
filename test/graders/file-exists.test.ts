import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigError } from '../../src/core/errors.ts'
import { fileExists } from '../../src/graders/file-exists.ts'
import { ctx, spec, trial } from '../helpers/grading.ts'
import { tree } from '../helpers/tmp.ts'

test('a file the subject wrote exists; one it did not write does not', async () => {
  const t = trial({ workdir: { 'out/report.md': '# ok' } })
  assert.equal((await fileExists(spec({ kind: 'file-exists', path: 'out/report.md' }), t, ctx())).pass, true)
  assert.equal((await fileExists(spec({ kind: 'file-exists', path: './out/report.md' }), t, ctx())).pass, true)
  assert.equal((await fileExists(spec({ kind: 'file-exists', path: 'out/missing.md' }), t, ctx())).pass, false)
})

test('exists: false passes only when the path is absent', async () => {
  const t = trial({ workdir: { 'debug.log': 'x' } })
  assert.equal((await fileExists(spec({ kind: 'file-exists', path: 'debug.log', exists: false }), t, ctx())).pass, false)
  assert.equal((await fileExists(spec({ kind: 'file-exists', path: 'nope/debug.log', exists: false }), t, ctx())).pass, true)
})

test('an absolute path or a .. segment is a config error', async () => {
  const t = trial()
  await assert.rejects(fileExists(spec({ kind: 'file-exists', path: '/etc/passwd' }), t, ctx()), ConfigError)
  await assert.rejects(fileExists(spec({ kind: 'file-exists', path: '../truth.yaml' }), t, ctx()), ConfigError)
  await assert.rejects(fileExists(spec({ kind: 'file-exists', path: 'a/../../b' }), t, ctx()), ConfigError)
})

test('canary: a symlink out of the workdir fails whichever way exists points', async () => {
  const outside = tree({ 'secret/report.md': 'x' })
  const t = trial()
  mkdirSync(join(t.workdir, 'sub'), { recursive: true })
  symlinkSync(join(outside, 'secret'), join(t.workdir, 'sub', 'out'))
  for (const [path, exists] of [['sub/out/report.md', true], ['sub/out/report.md', false], ['sub/out/nothing/here', false], ['sub/out', true]] as const) {
    const r = await fileExists(spec({ kind: 'file-exists', path, exists }), t, ctx())
    assert.equal(r.pass, false, `${path} exists: ${exists}`)
    assert.match(r.rationale ?? '', /outside the workdir/)
  }
})
