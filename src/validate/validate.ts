import { existsSync, lstatSync, readdirSync, realpathSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { ConfigError, InfraError } from '../core/errors.ts'
import { runId, trialKey } from '../core/ids.ts'
import { inside } from '../core/paths.ts'
import { redactor, secretValues, type Redactor } from '../core/redact.ts'
import { harnessPreflight, subjectRootOf } from '../executors/harness.ts'
import { command } from '../graders/command.ts'
import type { GradeContext, TrialResult } from '../graders/index.ts'
import { buildWorkdir, copyTree, git } from '../sandbox/workdir.ts'
import { minTrialsToPass } from '../stats/verdict.ts'
import type { Config, LoadedCase } from '../suite/load.ts'

export type Problem = { case: string; level: 'error' | 'warn'; message: string }

export type ValidateOptions = {
  proofs?: boolean // run each seeded bug's proof (default true)
  env?: NodeJS.ProcessEnv
  workBase?: string // where validation copies are built (default: the OS temp dir)
  proofTimeoutS?: number // default: the case's timeout_s
}

// docs/ARCHITECTURE.md § litmus validate: the checks a run makes when it loads
// a suite, made up front on a disposable copy of each case, plus every seeded
// bug's proof, which must fail on the change and pass once the bug's fix is
// applied. Nothing is ever run in, or written to, the suite itself.
export async function validate(config: Config, cases: LoadedCase[], o: ValidateOptions = {}): Promise<Problem[]> {
  const run = runId()
  const base = o.workBase ?? tmpdir()
  try {
    return await check(config, cases, o, run, base)
  } finally {
    // Every copy removes itself, which leaves the run's own directory empty.
    try {
      rmdirSync(join(base, 'litmus', run))
    } catch {
      // never made (no case got as far as a copy), or not empty: left alone
    }
  }
}

async function check(config: Config, cases: LoadedCase[], o: ValidateOptions, run: string, base: string): Promise<Problem[]> {
  const env = o.env ?? process.env
  const redact = redactor(secretValues(config.redact, env))
  const avoid = [config.resultsDir, ...config.roots]
  const out: Problem[] = []
  for (const c of cases) {
    const say = (level: Problem['level'], message: string) => out.push({ case: c.id, level, message: redact.text(message) })
    let attempt = 0
    // A fresh copy of the post-change tree: the fixture, then change.patch.
    const copy = () => buildWorkdir(c, { run, key: trialKey({ suite: c.suite, case: c.name, config: 'validate', trial: 1 }), attempt: ++attempt }, base, avoid)

    let wd: ReturnType<typeof buildWorkdir>
    try {
      wd = copy()
    } catch (e) {
      if (!(e instanceof ConfigError || e instanceof InfraError)) throw e
      say('error', e.message)
      continue
    }
    try {
      const proofDir = join(c.dir, 'proof')
      if (existsSync(proofDir)) {
        // An overlay that replaced a file of the change would test something
        // other than what the subject is shown.
        for (const rel of files(proofDir)) if (existsSync(join(wd.dir, rel))) say('error', `proof/${rel} also exists in the fixture (after change.patch); a proof may only add files`)
      }
      const refused = harnessPreflight(c, wd.dir, config.roots)
      if (refused) say('error', refused)
    } finally {
      wd.cleanup()
    }

    // A suite root inside a plugin or subject root would put every case's
    // ground truth where the harness is allowed to read.
    for (const holder of [...c.plugins, subjectRootOf(c)].filter((p): p is string => p !== undefined && existsSync(p))) {
      const trapped = config.roots.filter(existsSync).find(r => inside(realpathSync.native(r), realpathSync.native(holder)))
      if (trapped) say('error', `suite root ${trapped} lies inside ${holder}, which the harness may read; move one out of the other`)
    }

    const s = c.settings
    if (s.policy === 'rate') {
      const need = minTrialsToPass(s.threshold)
      if (s.trials < need) say('warn', `policy rate with threshold ${s.threshold} needs at least ${need} unbroken passes to return PASS; the case runs ${s.trials} trials, so it can only ever be INCONCLUSIVE or worse`)
    }
    if (c.truth?.kind === 'clean') {
      for (const g of c.spec.graders) {
        if (g.kind !== 'review-match') continue
        for (const bound of ['min_recall', 'min_claims_correct'] as const) {
          if (g.pass[bound] !== undefined) say('warn', `review-match sets ${bound}, which is never defined on a clean case (it has no bugs), so it never applies`)
        }
      }
    }

    if (o.proofs !== false && c.truth?.kind === 'seeded') {
      for (const bug of c.truth.bugs) {
        const why = await proof(c, bug, copy, redact, o.proofTimeoutS ?? s.timeout_s)
        if (why) say('error', `bug ${bug.id}: ${why}`)
      }
    }
  }
  return out
}

// One bug's proof on its own copy: the change plus proof/ must fail it, and
// the change plus proof/ plus the bug's fix must pass it.
async function proof(c: LoadedCase, bug: { id: string; proof: string; fix: string }, copy: () => ReturnType<typeof buildWorkdir>, redact: Redactor, timeoutS: number): Promise<string | undefined> {
  let wd: ReturnType<typeof buildWorkdir>
  try {
    wd = copy()
  } catch (e) {
    return (e as Error).message
  }
  try {
    const proofDir = join(c.dir, 'proof')
    if (existsSync(proofDir)) copyTree(proofDir, wd.dir, c.id, 'proof/')
    const fix = resolve(c.dir, bug.fix)
    if (!inside(fix, c.dir)) return `fix ${bug.fix} lies outside the case`
    if (!existsSync(fix)) return `fix ${bug.fix} does not exist`

    const before = await sh(bug.proof, wd, c, redact, timeoutS)
    if (before.pass) return `its proof passes before the fix, so it proves nothing: ${bug.proof}${before.rationale.replace(/^exit 0/, '')}`
    if (/^timeout after/.test(before.rationale)) return `its proof timed out before the fix (${timeoutS}s): ${bug.proof}`
    try {
      git(wd.dir, ['apply', fix], `${c.id}: fix ${bug.fix} does not apply after change.patch`)
    } catch (e) {
      return (e as Error).message
    }
    const after = await sh(bug.proof, wd, c, redact, timeoutS)
    if (!after.pass) return `its proof still fails with the fix applied: ${bug.proof}\n${after.rationale}`
    return undefined
  } finally {
    wd.cleanup()
  }
}

// The command grader's runner: a scrubbed env, its own process group killed on
// timeout, and output redacted before it is cut.
function sh(run: string, wd: { dir: string; home: string }, c: LoadedCase, redact: Redactor, timeoutS: number) {
  const trial = { workdir: wd.dir, home: wd.home } as TrialResult
  const ctx = { case: c, redact, signal: new AbortController().signal } as GradeContext
  return command({ kind: 'command', run, timeout_s: timeoutS }, trial, ctx).then(r => ({ pass: r.pass, rationale: r.rationale ?? '' }))
}

// Every regular file under dir, as a path relative to it.
function files(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name)
      const st = lstatSync(path)
      if (st.isDirectory()) walk(path)
      else out.push(relative(dir, path).split(sep).join('/'))
    }
  }
  walk(dir)
  return out
}
