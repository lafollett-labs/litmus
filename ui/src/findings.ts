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
  metrics: Record<string, number | null>
}

export function findingsOf(g: GraderResult): FindingsView | undefined {
  if (g.grader !== 'review-match' || !g.details) return undefined
  const { matched, missed, unmatched } = g.details
  const as = (kind: ReviewDetails['unmatched'][number]['as']) => unmatched.filter(u => u.as === kind)
  return { matched, missed, falsePositives: as('false_positive'), decoyHits: as('decoy_hit'), nits: as('nit'), duplicates: as('duplicate'), metrics: g.metrics ?? {} }
}

export const where = (f: ReviewFinding) => `${f.file}:${f.line} "${f.title}"`
