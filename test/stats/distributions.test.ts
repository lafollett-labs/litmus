import { test } from 'node:test'
import assert from 'node:assert/strict'
import { beta, gamma, normal, type Rng } from '../../src/stats/distributions.ts'
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

test('gamma draws match the shape as mean and variance, above and below shape one', () => {
  for (const shape of [0.5, 1, 3, 30.5]) {
    const m = moments(rng => gamma(shape, rng))
    near(m.mean / shape, 1, 0.04, `mean at shape ${shape}`)
    near(m.variance / shape, 1, 0.1, `variance at shape ${shape}`)
    assert.ok(m.xs.every(x => x > 0), `shape ${shape} drew a non-positive value`)
  }
})

test('a gamma below shape one puts the right mass near zero, which the squeeze alone gets wrong', () => {
  // P(X < 0.01) for Gamma(0.5) is erf(0.1). Marsaglia–Tsang run directly at
  // shape 0.5 overshoots it by about 0.02 while its mean looks nearly right.
  const m = moments(rng => gamma(0.5, rng))
  near(m.xs.filter(x => x < 0.01).length / N, 0.1125, 0.01, 'P(X < 0.01)')
})

test('a gamma shape that is not positive is rejected', () => {
  for (const shape of [0, -1, Number.NaN]) {
    assert.throws(() => gamma(shape, mulberry32(1)), RangeError, String(shape))
  }
})

test('beta draws land in the unit interval with the analytic mean and variance', () => {
  for (const [a, b] of [[2, 5], [0.5, 30.5], [30.5, 0.5], [0.5, 0.5]] as const) {
    const m = moments(rng => beta(a, b, rng))
    const mean = a / (a + b)
    const variance = (a * b) / ((a + b) ** 2 * (a + b + 1))
    near(m.mean, mean, 0.01, `mean of Beta(${a}, ${b})`)
    near(m.variance / variance, 1, 0.1, `variance of Beta(${a}, ${b})`)
    assert.ok(m.xs.every(x => x >= 0 && x <= 1), `Beta(${a}, ${b}) left [0, 1]`)
  }
})

test('the same seed draws the same betas', () => {
  const draw = () => {
    const rng = mulberry32(3)
    return Array.from({ length: 50 }, () => beta(1.5, 0.5, rng))
  }
  assert.deepEqual(draw(), draw())
})
