import { lstatSync, realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { relativeInside } from './common.ts'
import type { Grader } from './types.ts'

// Existence in the workdir after the trial. A symlink the subject planted
// could make "out/report.md" exist somewhere else entirely, so the deepest
// entry that exists on the path must resolve inside the workdir, or the
// grade fails whatever `exists` asked for.
export const fileExists: Grader<'file-exists'> = async (spec, trial) => {
  const rel = relativeInside(spec.path, 'file-exists path')
  const root = realpathOrUndefined(trial.workdir)
  if (root === undefined) return { grader: 'file-exists', pass: false, rationale: `the workdir ${trial.workdir} is gone` }
  const abs = join(trial.workdir, rel)
  let probe = abs
  while (probe !== trial.workdir && probe !== dirname(probe) && !lexists(probe)) probe = dirname(probe)
  const real = realpathOrUndefined(probe)
  if (real === undefined || (real !== root && !real.startsWith(root + sep))) {
    return { grader: 'file-exists', pass: false, rationale: `${rel} leads outside the workdir through a symlink` }
  }
  const exists = probe === abs
  const pass = exists === spec.exists
  return { grader: 'file-exists', pass, rationale: `${rel} ${exists ? 'exists' : 'does not exist'}; want ${spec.exists ? 'it to exist' : 'it absent'}` }
}

function lexists(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

function realpathOrUndefined(p: string): string | undefined {
  try {
    return realpathSync(p)
  } catch {
    return undefined // missing, or a dangling link
  }
}
