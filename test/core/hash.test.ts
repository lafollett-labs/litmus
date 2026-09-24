import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashJson, sha256, stableStringify } from '../../src/core/hash.ts'

test('sha256 matches the known digest of the empty string', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('key order at any depth does not change the hash', () => {
  const a = { model: 'm', provider: 'p', params: { temperature: 0, top_p: 1 } }
  const b = { params: { top_p: 1, temperature: 0 }, provider: 'p', model: 'm' }
  assert.equal(hashJson(a), hashJson(b))
})

test('any value change does change the hash', () => {
  assert.notEqual(hashJson({ model: 'a' }), hashJson({ model: 'b' }))
  assert.notEqual(hashJson({ n: 1 }), hashJson({ n: '1' }))
})

test('values JSON would mangle are refused rather than hashed into a collision', () => {
  assert.throws(() => hashJson({ at: new Date(1) }), TypeError)
  assert.throws(() => hashJson({ m: new Map() }), TypeError)
  assert.throws(() => hashJson({ n: Number.NaN }), TypeError)
  assert.throws(() => hashJson(undefined), TypeError)
  assert.throws(() => hashJson([1, undefined]), TypeError)
  assert.throws(() => hashJson(new Array(1)), /sparse array/)
  assert.throws(() => hashJson({ [Symbol('s')]: 1 }), /symbol keys/)
  assert.throws(() => hashJson(Object.assign([1], { [Symbol('s')]: 1 })), /symbol keys/)
  assert.throws(() => hashJson(Object.assign([1], { note: 'x' })), /named properties/)
  assert.doesNotThrow(() => hashJson([null]))
})

test('a __proto__ key is hashed as a key, not swallowed', () => {
  const tricky = JSON.parse('{"__proto__":{"model":"evil"},"x":1}') as unknown
  assert.notEqual(hashJson(tricky), hashJson({ x: 1 }))
  assert.equal(stableStringify(tricky), '{"__proto__":{"model":"evil"},"x":1}')
})

test('undefined fields drop out, and array order is preserved', () => {
  assert.equal(stableStringify({ a: 1, b: undefined }), '{"a":1}')
  assert.notEqual(hashJson([1, 2]), hashJson([2, 1]))
})
