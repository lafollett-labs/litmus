import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inside } from '../../src/core/paths.ts'

test('inside is by whole segments, and the filesystem root holds everything', () => {
  assert.ok(inside('/a/b', '/a'))
  assert.ok(inside('/a', '/a'))
  assert.ok(!inside('/ab', '/a'))
  assert.ok(inside('/etc/passwd', '/'))
  assert.ok(inside('/', '/'))
})
