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

test('a json fence closes at the ``` that ends valid JSON, so a code block inside a string does not cut it short', () => {
  const finding = { file: 'a.ts', line: 5, severity: 'high', title: 't', explanation: 'e', fix: '```ts\nreturn a.start <= b.end\n```' }
  assert.deepEqual(extractJson(`Review:\n\`\`\`json\n${JSON.stringify({ findings: [finding] }, null, 2)}\n\`\`\``), { findings: [finding] })
  // A judge whose rationale quotes code.
  assert.deepEqual(extractJson('```json\n{"pass": true, "rationale": "the fix is ```x < y```"}\n```'), { pass: true, rationale: 'the fix is ```x < y```' })
  // A broken last fence falls back to the last one that parses, never to nothing.
  assert.deepEqual(extractJson('```json\n{"a":1}\n```\n```json\n{broken\n```'), { a: 1 })
  // A fence with no closer still parses to the end of the text.
  assert.equal(extractJson('```json\n{"a":1}\n'), undefined)
})
