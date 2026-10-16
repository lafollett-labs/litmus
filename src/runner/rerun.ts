import { ConfigError } from '../core/errors.ts'
import type { TrialRecord, Verdict, VerdictKind } from '../core/types.ts'
import { readRun, readTrials, type StoredRun } from '../store/store.ts'

// `--rerun <run> --only fail,flaky`: exactly the (case, config) pairs whose
// verdict is in the set, as the "<case>@<config>" keys run() takes in `only`.
export function rerunPairs(stored: StoredRun, only: readonly VerdictKind[]): Set<string> {
  if (only.length === 0) throw new ConfigError('--only needs at least one verdict (fail, flaky, error, inconclusive)')
  const want = new Set(only)
  return new Set(stored.verdicts.filter(v => want.has(v.verdict)).map(v => `${v.case}@${v.config}`))
}

// What a comparison needs from one side of it: verdicts, the trial records
// WARN takes medians over, the case hashes that exclude a changed case, and
// the subject and plugin hashes whose differences become notes.
export type RunSide = {
  label: string
  configs: string[]
  verdicts: Verdict[]
  records: TrialRecord[]
  hashes: Record<string, string>
  subjects: Record<string, string>
  plugins: Record<string, string>
}

// A stored run as the baseline side of a comparison.
export function baselineSide(resultsDir: string, id: string, label: string = id): RunSide {
  const stored = readRun(resultsDir, id)
  const { manifest } = stored
  return {
    label,
    configs: Object.keys(manifest.configs),
    verdicts: stored.verdicts,
    records: readTrials(resultsDir, id),
    hashes: Object.fromEntries(manifest.cases.map(c => [c.id, c.case_hash])),
    subjects: Object.fromEntries(manifest.cases.flatMap(c => (c.subject_hash ? [[c.id, c.subject_hash]] : []))),
    plugins: manifest.plugins,
  }
}
