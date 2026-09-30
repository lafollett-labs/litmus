import { hashJson, sha256 } from '../core/hash.ts'
import { EXTRACT_PROMPT_VERSION } from '../graders/index.ts'
import type { LoadedCase } from '../suite/load.ts'
import { hashTree } from '../suite/tree.ts'

// The judges a case can call: its judge graders, a review-match's confirm, and
// its extractor.
export function judgesOf(c: LoadedCase): string[] {
  const names = new Set<string>()
  for (const g of c.spec.graders) {
    if (g.kind === 'judge') names.add(g.judge)
    if (g.kind === 'review-match' && g.confirm !== undefined) names.add(g.confirm)
  }
  if (c.spec.extract) names.add(c.spec.extract.with)
  return [...names].sort()
}

// Everything that decides how a case is scored (docs/ARCHITECTURE.md §
// Comparison): its whole directory (case.yaml, truth.yaml, fixture/,
// change.patch, proof/, fix/, fake.yaml), the prompt it resolved (a
// prompt_file may live outside the case), the settings its suite layered on
// (tags aside),
// and the hashes of the judges and extractor it calls. A comparison excludes
// a case whose hash differs between sides, so an edit to ground truth is never
// blamed on the model. The subject is not in it: comparing subjects is the point.
export function caseHash(c: LoadedCase, judgeHash: (name: string) => string): string {
  const judges = Object.fromEntries(judgesOf(c).map(n => [n, judgeHash(n)]))
  return hashJson({
    tree: hashTree(c.dir),
    prompt: sha256(c.prompt),
    settings: { ...c.settings, tags: [] }, // tags choose cases; they do not score them
    judges,
    ...(c.spec.extract ? { extract_prompt: EXTRACT_PROMPT_VERSION } : {}),
  })
}
