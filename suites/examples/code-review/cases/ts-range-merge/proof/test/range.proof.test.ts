import { test } from 'node:test'
import assert from 'node:assert/strict'
import { merge, overlaps } from '../src/range.ts'

test('ranges that share an end point overlap', () => {
  assert.equal(overlaps({ start: 1, end: 3 }, { start: 3, end: 5 }), true)
  assert.equal(overlaps({ start: 3, end: 5 }, { start: 1, end: 3 }), true)
  assert.equal(overlaps({ start: 2, end: 2 }, { start: 2, end: 2 }), true)
})

test('merge joins ranges that share an end point', () => {
  assert.deepEqual(merge([{ start: 3, end: 5 }, { start: 1, end: 3 }]), [{ start: 1, end: 5 }])
})
