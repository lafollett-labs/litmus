import { test } from 'node:test'
import { ConfigError } from '../../src/core/errors.ts'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { extractJson, renderPrompt } from '../../src/executors/render.ts'
import { tree } from '../helpers/tmp.ts'

const dir = tree({ 'src/a.ts': 'one\ntwo\n', 'b.txt': 'x', '.git/config': 'secret', 'bin.dat': 'a\0b' })

test('{{fixture}} renders every file but .git, with paths and line numbers', () => {
  const out = renderPrompt('Review:\n{{fixture}}', dir)
  assert.match(out, /=== src\/a\.ts ===\n1 \| one\n2 \| two/)
  assert.match(out, /=== b\.txt ===\n1 \| x/)
  assert.match(out, /=== bin\.dat === \(binary, 3 bytes\)/)
  assert.doesNotMatch(out, /secret/)
})

test('for the harness, every @ that starts a word in a rendered file is defused, and the template\'s own text is left alone', () => {
  const dir = tree({ 'App.vue': "import X from '@/components/X.vue'\nsee @../truth.yaml\nmail a@b.c\n" })
  const out = renderPrompt('Review @src/app {{fixture}}', dir, undefined, { defuseMentions: true })
  assert.ok(out.startsWith('Review @src/app '))
  assert.ok(out.includes("'@\u2060/components/X.vue'") && out.includes(' @\u2060../truth.yaml') && out.includes('a@b.c'))
  assert.ok(!renderPrompt('{{fixture}}', dir).includes('\u2060'), 'the model executor renders files as they are')
})

test('{{diff}} renders the change, and {{file:...}} a single file', () => {
  const patch = join(tree({ 'change.patch': '+added' }), 'change.patch')
  assert.equal(renderPrompt('{{diff}}', dir, patch), '+added')
  assert.equal(renderPrompt('{{diff}}', dir), '')
  assert.match(renderPrompt('{{ file:src/a.ts }}', dir), /=== src\/a\.ts ===\n1 \| one/)
})

test('{{file:...}} cannot reach outside the workdir, and a missing file is a config error, not a crash', () => {
  assert.throws(() => renderPrompt('{{file:../truth.yaml}}', dir), (e: unknown) => e instanceof ConfigError && /outside the workdir/.test(e.message))
  assert.throws(() => renderPrompt('{{file:nope.go}}', dir), (e: unknown) => e instanceof ConfigError && /nope\.go/.test(e.message))
})

test('the last json fence wins, a bare object parses, and anything else is no object', () => {
  assert.deepEqual(extractJson('thinking...\n```json\n{"a":1}\n```\nfinal:\n```json\n{"findings":[]}\n```'), { findings: [] })
  assert.deepEqual(extractJson('  {"findings": []}  '), { findings: [] })
  assert.equal(extractJson('[1,2]'), undefined)
  assert.equal(extractJson('no json here'), undefined)
  assert.equal(extractJson('```json\n{broken\n```'), undefined)
})
