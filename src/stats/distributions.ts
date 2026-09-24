// Samplers driven by a caller's seeded uniform source, never Math.random, so a
// bootstrap built on them reproduces from its seed alone.
export type Rng = () => number

// Box–Muller. 1 − rng() lies in (0, 1], so the log never sees zero.
export function normal(rng: Rng): number {
  const u = 1 - rng()
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// Marsaglia & Tsang (2000). Their squeeze only holds for shape ≥ 1; a Jeffreys
// posterior on a case with zero successes has shape 0.5, so below 1 it draws at
// shape + 1 and scales by U^(1/shape), which is exact.
export function gamma(shape: number, rng: Rng): number {
  if (!(shape > 0)) throw new RangeError(`gamma shape must be positive, got ${shape}`)
  if (shape < 1) return gamma(shape + 1, rng) * Math.pow(1 - rng(), 1 / shape)
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x: number
    let v: number
    do {
      x = normal(rng)
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = 1 - rng()
    if (u < 1 - 0.0331 * x ** 4) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

export function beta(a: number, b: number, rng: Rng): number {
  const x = gamma(a, rng)
  return x / (x + gamma(b, rng))
}
