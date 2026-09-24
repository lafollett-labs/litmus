// Math.random cannot be seeded, and an unseeded bootstrap gives a stored
// comparison a different interval each time it is recomputed; near the
// tolerance that flips a REGRESSION to INCONCLUSIVE between two reads of the
// same run. Mulberry32 is 32-bit state, fast, and plenty for 2,000 resamples.
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
