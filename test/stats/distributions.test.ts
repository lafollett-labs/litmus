import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normal, type Rng } from '../../src/stats/distributions.ts'
import { mulberry32 } from '../../src/stats/prng.ts'

// Seeded, so these checks are deterministic rather than flaky; no tolerance
// is tighter than about four standard errors at 20,000 draws.
const N = 20_000

function moments(draw: (rng: Rng) => number, seed = 7) {
  const rng = mulberry32(seed)
  const xs = Array.from({ length: N }, () => draw(rng))
  const mean = xs.reduce((s, x) => s + x, 0) / N
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (N - 1)
  return { xs, mean, variance }
}

const near = (actual: number, expected: number, eps: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < eps, `${what}: ${actual} is not within ${eps} of ${expected}`)

test('normal draws have mean zero and unit variance', () => {
  const m = moments(normal)
  near(m.mean, 0, 0.03, 'mean')
  near(m.variance, 1, 0.04, 'variance')
})
