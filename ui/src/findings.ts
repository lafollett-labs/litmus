import type { GraderResult } from '../../src/core/types.ts'

// A review-match grade, read back into what the Findings panel shows. The
// rationale's line format is review-match's (src/graders/review-match.ts);
// test/ui/findings.test.ts runs the real grader, so the two cannot drift apart.
export type FindingsView = {
  matched: { bug: string; at: string }[]
  missed: string[]
  falsePositives: string[]
  decoyHits: string[]
  nits: string[]
  duplicates: string[]
  metrics: Record<string, number | null>
}

const OUTCOMES = { 'false positive: ': 'falsePositives', 'decoy hit: ': 'decoyHits', 'nit: ': 'nits', 'duplicate: ': 'duplicates' } as const

export function findingsOf(g: GraderResult): FindingsView | undefined {
  if (g.grader !== 'review-match') return undefined
  const out: FindingsView = { matched: [], missed: [], falsePositives: [], decoyHits: [], nits: [], duplicates: [], metrics: g.metrics ?? {} }
  for (const line of (g.rationale ?? '').split('\n')) {
    const m = /^ {2}(\S+) <- (.*)$/.exec(line)
    if (m) {
      out.matched.push({ bug: m[1]!, at: m[2]! })
      continue
    }
    if (line.startsWith('missed: ')) {
      out.missed.push(...line.slice('missed: '.length).split(', '))
      continue
    }
    for (const [prefix, field] of Object.entries(OUTCOMES) as [keyof typeof OUTCOMES, (typeof OUTCOMES)[keyof typeof OUTCOMES]][]) {
      if (line.startsWith(prefix)) out[field].push(line.slice(prefix.length))
    }
  }
  return out
}
