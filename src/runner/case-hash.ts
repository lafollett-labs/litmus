import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
// change.patch, proof/, fix/, fake.yaml), the prompt it resolved and the
// json-schema files its graders read (either may live outside the case), the
// settings its suite layered on (tags aside), and the hashes of the judges and
// extractor it calls. A comparison excludes a case whose hash differs between
// sides, so an edit to ground truth is never blamed on the model. The subject
// is not in it: comparing subjects is the point. A command grader's script
// outside the case is not in it either; nothing tells litmus what it reads.
export function caseHash(c: LoadedCase, judgeHash: (name: string) => string): string {
  const judges = Object.fromEntries(judgesOf(c).map(n => [n, judgeHash(n)]))
  const schemas = Object.fromEntries(
    c.spec.graders.flatMap((g, i) => (g.kind === 'json-schema' && !g.schema.startsWith('litmus:') ? [[String(i), sha256(readFileSync(resolve(c.dir, g.schema)))]] : [])),
  )
  return hashJson({
    tree: hashTree(c.dir),
    prompt: sha256(c.prompt),
    settings: { ...c.settings, tags: [] }, // tags choose cases; they do not score them
    judges,
    ...(Object.keys(schemas).length ? { schemas } : {}),
    ...(c.spec.extract ? { extract_prompt: EXTRACT_PROMPT_VERSION } : {}),
  })
}
