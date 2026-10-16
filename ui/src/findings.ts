import type { GraderResult, ReviewDetails, ReviewFinding } from '../../src/core/types.ts'

// A review-match grade as the Findings panel shows it, read from the grade's
// structured details, never from its rationale: a finding title is the
// subject's output, and parsed prose would let it forge a line of its own.
export type FindingsView = {
  matched: ReviewDetails['matched']
  missed: string[]
  falsePositives: ReviewFinding[]
  decoyHits: (ReviewFinding & { near?: string })[]
  nits: ReviewFinding[]
  duplicates: (ReviewFinding & { near?: string })[]
  // Each list's count, from the metrics, which count every finding: the
  // details list at most 500 unmatched ones, and `omitted` says how many more.
  counts: { falsePositives: number; decoyHits: number; nits: number; duplicates: number }
  omitted: number
  metrics: Record<string, number | null>
}

export function findingsOf(g: GraderResult): FindingsView | undefined {
  if (g.grader !== 'review-match' || !g.details) return undefined
  const { matched, missed, unmatched } = g.details
  const as = (kind: ReviewDetails['unmatched'][number]['as']) => unmatched.filter(u => u.as === kind)
  const metrics = g.metrics ?? {}
  const count = (metric: string, listed: unknown[]) => (typeof metrics[metric] === 'number' ? metrics[metric] : listed.length)
  const [falsePositives, decoyHits, nits, duplicates] = [as('false_positive'), as('decoy_hit'), as('nit'), as('duplicate')]
  return {
    matched,
    missed,
    falsePositives,
    decoyHits,
    nits,
    duplicates,
    counts: { falsePositives: count('false_positives', falsePositives), decoyHits: count('decoy_hits', decoyHits), nits: count('nits', nits), duplicates: count('duplicates', duplicates) },
    omitted: g.details.omitted ?? 0,
    metrics,
  }
}

export const where = (f: ReviewFinding) => `${f.file}:${f.line} "${f.title}"`
