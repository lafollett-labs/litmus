import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mulberry32 } from '../../src/stats/prng.ts'

const take = (next: () => number, n: number) => Array.from({ length: n }, next)

test('the sequence for a seed is pinned, so a stored comparison recomputes identically', () => {
  assert.deepEqual(take(mulberry32(1), 3), [0.6270739405881613, 0.002735721180215478, 0.5274470399599522])
})

test('two generators with the same seed produce the same sequence', () => {
  assert.deepEqual(take(mulberry32(42), 100), take(mulberry32(42), 100))
})

test('different seeds produce different sequences', () => {
  assert.notDeepEqual(take(mulberry32(1), 10), take(mulberry32(2), 10))
})

test('every draw lands in [0, 1), including for seeds beyond 32 bits', () => {
  for (const seed of [0, 1, 0xffffffff, 2 ** 40 + 7, -3]) {
    for (const x of take(mulberry32(seed), 10_000)) {
      assert.ok(x >= 0 && x < 1, `seed ${seed} drew ${x}`)
    }
  }
})
