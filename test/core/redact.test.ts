import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactor, secretValues } from '../../src/core/redact.ts'

test('every occurrence of every value is replaced, the longest value first', () => {
  const r = redactor(['sk-ant-1', 'sk-ant-12345'])
  assert.equal(r.text('key sk-ant-12345 and sk-ant-1, again sk-ant-1'), 'key [REDACTED] and [REDACTED], again [REDACTED]')
  assert.equal(redactor([]).text('sk-ant-1'), 'sk-ant-1')
})

test('bytes are redacted byte-exactly, and a binary file keeps every other byte', () => {
  const r = redactor(['kéy$&'])
  const bin = Buffer.concat([Buffer.from([0, 0xff, 0x80]), Buffer.from('kéy$&', 'utf8'), Buffer.from([0xfe])])
  assert.deepEqual(r.bytes(bin), Buffer.concat([Buffer.from([0, 0xff, 0x80]), Buffer.from('[REDACTED]'), Buffer.from([0xfe])]))
  const clean = Buffer.from([1, 2, 3])
  assert.equal(r.bytes(clean), clean)
})

test('a JSON value is redacted in its keys and nested values, before anything escapes it', () => {
  const r = redactor(['a"b\\c'])
  const out = r.json({ cmd: 'echo a"b\\c', nested: [{ 'a"b\\c': 1 }], n: 2, t: true, z: null })
  assert.deepEqual(out, { cmd: 'echo [REDACTED]', nested: [{ '[REDACTED]': 1 }], n: 2, t: true, z: null })
  assert.ok(!JSON.stringify(out).includes('a\\"b'))
})

test('the scrubbed set is every credential variable plus the config\'s own names, set and non-empty', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-a', AWS_SESSION_TOKEN: '', MY_TOKEN: 'mine', OTHER: 'not-listed' }
  assert.deepEqual(secretValues(['MY_TOKEN', 'UNSET'], env).sort(), ['mine', 'sk-a'])
})
