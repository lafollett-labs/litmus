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
  signal?: AbortSignal // stops at the next case or proof; a running proof's process group is killed
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
    if (o.signal?.aborted) break
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
    const proofDir = join(c.dir, 'proof')
    let proofBad = false
    try {
      // On the tree the harness would get, before proof/ is laid over it: a
      // run never shows the subject proof/.
      const refused = harnessPreflight(c, wd.dir, config.roots)
      if (refused) say('error', refused)
      // lstat: a dangling proof link is still a link, and refused as one.
      if (lstatSync(proofDir, { throwIfNoEntry: false })) {
        const bad = proofTree(c, proofDir, wd.dir)
        for (const m of bad) say('error', m)
        proofBad = bad.length > 0
      }
    } finally {
      wd.cleanup()
    }

    // A suite root inside a harness case's subject root would put every
    // case's ground truth where the harness may read. (A plugin holding one is
    // refused by harnessPreflight; a model case's subject is a file it reads
    // as its system prompt, and nothing reads the folder around it.)
    const holder = c.spec.executor.kind === 'harness' ? subjectRootOf(c) : undefined
    if (holder !== undefined && existsSync(holder)) {
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

    // A proof/ tree already reported as bad would fail every proof the same way.
    if (o.proofs !== false && !proofBad && c.truth?.kind === 'seeded') {
      for (const bug of c.truth.bugs) {
        if (o.signal?.aborted) break
        const why = await proof(c, bug, copy, redact, o.proofTimeoutS ?? s.timeout_s, o.signal)
        if (why) say('error', `bug ${bug.id}: ${why}`)
      }
    }
  }
  return out
}

// One bug's proof on its own copy: the change plus proof/ must fail it, and
// the change plus proof/ plus the bug's fix must pass it.
async function proof(c: LoadedCase, bug: { id: string; proof: string; fix: string }, copy: () => ReturnType<typeof buildWorkdir>, redact: Redactor, timeoutS: number, signal?: AbortSignal): Promise<string | undefined> {
  let wd: ReturnType<typeof buildWorkdir>
  try {
    wd = copy()
  } catch (e) {
    return (e as Error).message
  }
  try {
    const proofDir = join(c.dir, 'proof')
    try {
      if (lstatSync(proofDir, { throwIfNoEntry: false })) copyTree(proofDir, wd.dir, c.id, 'proof/')
    } catch (e) {
      return (e as Error).message
    }
    const fix = resolve(c.dir, bug.fix)
    if (!inside(fix, c.dir)) return `fix ${bug.fix} lies outside the case`
    if (!existsSync(fix)) return `fix ${bug.fix} does not exist`
    // Links followed: a fix/ that is a link out of the case lies outside it too.
    if (!inside(realpathSync.native(fix), realpathSync.native(c.dir))) return `fix ${bug.fix} resolves outside the case`

    const before = await sh(bug.proof, wd, c, redact, timeoutS, signal)
    if (signal?.aborted) return undefined
    if (before.pass) return `its proof passes before the fix, so it proves nothing: ${bug.proof}${before.rationale.replace(/^exit 0/, '')}`
    if (/^timeout after/.test(before.rationale)) return `its proof timed out before the fix (${timeoutS}s): ${bug.proof}`
    try {
      git(wd.dir, ['apply', fix], `${c.id}: fix ${bug.fix} does not apply after change.patch`)
    } catch (e) {
      return (e as Error).message
    }
    const after = await sh(bug.proof, wd, c, redact, timeoutS, signal)
    if (signal?.aborted) return undefined
    if (!after.pass) return `its proof still fails with the fix applied: ${bug.proof}\n${after.rationale}`
    return undefined
  } finally {
    wd.cleanup()
  }
}

// The command grader's runner: a scrubbed env, its own process group killed on
// timeout or on the signal, and output redacted before it is cut.
function sh(run: string, wd: { dir: string; home: string }, c: LoadedCase, redact: Redactor, timeoutS: number, signal = new AbortController().signal) {
  const trial = { workdir: wd.dir, home: wd.home } as TrialResult
  const ctx = { case: c, redact, signal } as GradeContext
  return command({ kind: 'command', run, timeout_s: timeoutS }, trial, ctx).then(r => ({ pass: r.pass, rationale: r.rationale ?? '' }))
}

// What is wrong with a case's proof/ tree, overlaid on a post-change copy: a
// proof may only add regular files, and only where the fixture has none.
function proofTree(c: LoadedCase, proofDir: string, work: string): string[] {
  const root = lstatSync(proofDir)
  if (root.isSymbolicLink()) return [`proof/ is a symlink; a proof may not be or contain a link`]
  if (!root.isDirectory()) return [`proof is not a directory; a proof is a tree of files laid over the fixture`]
  const out: string[] = []
  for (const rel of files(proofDir)) {
    const parts = rel.split('/')
    // A proof path that runs through a fixture file cannot be laid over it.
    const through = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/')).find(p => existsSync(join(work, p)) && !lstatSync(join(work, p)).isDirectory())
    if (through !== undefined) out.push(`proof/${rel} runs through ${through}, a file in the fixture (after change.patch); a proof may only add files`)
    // An overlay that replaced a file of the change would test something
    // other than what the subject is shown.
    else if (existsSync(join(work, rel))) out.push(`proof/${rel} also exists in the fixture (after change.patch); a proof may only add files`)
  }
  if (out.length) return out
  // The overlay itself refuses a link, a .git, or anything but a file or directory.
  try {
    copyTree(proofDir, work, c.id, 'proof/')
  } catch (e) {
    return [(e as Error).message]
  }
  return []
}

// Every regular file under dir, as a path relative to it. A .git entry is
// left out: the copy is a git repository, so it would read as a shadowed file,
// and the overlay refuses it by name instead.
function files(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.toLowerCase() === '.git') continue
      const path = join(d, name)
      const st = lstatSync(path)
      if (st.isDirectory()) walk(path)
      else out.push(relative(dir, path).split(sep).join('/'))
    }
  }
  walk(dir)
  return out
}
