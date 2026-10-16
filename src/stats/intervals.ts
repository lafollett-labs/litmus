import type { Interval } from '../core/types.ts'

// z for a two-sided 95% interval at full double precision, so stored intervals
// match reference implementations digit for digit rather than to 1.96.
const Z_95 = 1.959963984540054

// Wilson rather than the normal approximation: at the trial counts litmus runs
// (3 to 30), p ± z·√(p(1−p)/n) collapses to zero width at 0/n and n/n, which
// would let five straight passes clear any threshold.
export function wilson(successes: number, n: number, z: number = Z_95): Interval | null {
  if (n === 0) return null
  if (successes < 0 || successes > n) {
    throw new RangeError(`wilson: successes ${successes} is outside 0..${n}`)
  }
  const p = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  // At 0/n and n/n the bound on that side is exactly 0 or 1 in closed form, but
  // the arithmetic lands an ulp off (10/10 gives hi = 0.9999999999999999), and
  // that fails a `hi >= threshold` check at threshold 1.
  const lo = successes === 0 ? 0 : Math.max(0, center - half)
  const hi = successes === n ? 1 : Math.min(1, center + half)
  return { lo, hi }
}

// Exact (Clopper–Pearson) 95%: the p at which seeing s or fewer (or s or more)
// successes has probability 2.5%, found by bisection on the binomial tail.
// Conservative by construction, which is what a 1- to 8-trial side needs:
// Wilson's coverage there dips well under 95%.
export const CP_MAX_N = 1000

export function clopperPearson(successes: number, n: number): Interval | null {
  // The tail is summed term by term, which overflows past about n = 1000; the
  // comparison only needs it below 9 trials.
  if (!Number.isInteger(n) || n < 0 || n > CP_MAX_N) throw new RangeError(`clopperPearson: n ${n} must be an integer in 0..${CP_MAX_N}`)
  if (n === 0) return null
  if (!Number.isInteger(successes) || successes < 0 || successes > n) throw new RangeError(`clopperPearson: successes ${successes} is not an integer in 0..${n}`)
  const atMost = (x: number, p: number) => {
    let t = 0
    for (let k = 0; k <= x; k++) t += choose(n, k) * p ** k * (1 - p) ** (n - k)
    return t
  }
  const bisect = (reached: (p: number) => boolean) => {
    let a = 0
    let b = 1
    for (let i = 0; i < 60; i++) {
      const m = (a + b) / 2
      if (reached(m)) b = m
      else a = m
    }
    return b
  }
  return {
    lo: successes === 0 ? 0 : bisect(p => 1 - atMost(successes - 1, p) >= 0.025),
    hi: successes === n ? 1 : bisect(p => atMost(successes, p) <= 0.025),
  }
}

// Multiplicative form keeps every partial product an integer, so the result is
// exact for any n a trial count will reach; factorials overflow past 170.
export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  const m = Math.min(k, n - k)
  let out = 1
  for (let i = 1; i <= m; i++) out = (out * (n - m + i)) / i
  return out
}

// Unbiased estimators over n trials with c successes: pass@k (some one of k
// trials succeeds) and pass^k (all k do). Plugging c/n into 1 − (1 − p)^k or p^k
// instead reads pass@k low and pass^k high, badly so at litmus trial counts.
export function passAtK(n: number, c: number, k: number): number {
  checkK(n, c, k)
  return 1 - choose(n - c, k) / choose(n, k)
}

export function passPowK(n: number, c: number, k: number): number {
  checkK(n, c, k)
  return choose(c, k) / choose(n, k)
}

function checkK(n: number, c: number, k: number): void {
  if (k < 1 || k > n) throw new RangeError(`k ${k} is outside 1..${n}`)
  if (c < 0 || c > n) throw new RangeError(`successes ${c} is outside 0..${n}`)
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  // Default sort compares as strings, which puts 10 before 9.
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
