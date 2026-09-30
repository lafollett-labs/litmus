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

// A stored run as the baseline side of a comparison: its verdicts, its trial
// records (for WARN medians) and its case hashes (so a changed case is excluded).
export function baselineSide(resultsDir: string, id: string, label: string = id): { label: string; verdicts: Verdict[]; records: TrialRecord[]; hashes: Record<string, string> } {
  const stored = readRun(resultsDir, id)
  return {
    label,
    verdicts: stored.verdicts,
    records: readTrials(resultsDir, id),
    hashes: Object.fromEntries(stored.manifest.cases.map(c => [c.id, c.case_hash])),
  }
}
