// Samplers driven by a caller's seeded uniform source, never Math.random, so a
// bootstrap built on them reproduces from its seed alone.
export type Rng = () => number

// Box–Muller. 1 − rng() lies in (0, 1], so the log never sees zero.
export function normal(rng: Rng): number {
  const u = 1 - rng()
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
