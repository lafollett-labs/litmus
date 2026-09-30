// An inclusive range of integers: [start, end], with start <= end.
export type Range = { start: number; end: number }

// True when the two ranges share at least one integer.
export function overlaps(a: Range, b: Range): boolean {
  return a.start <= b.end && b.start <= a.end
}
