import { accessSync, constants, lstatSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, sep } from 'node:path'
import { ConfigError } from '../core/errors.ts'
import { redactor, secretValues } from '../core/redact.ts'
import type { VerdictKind } from '../core/types.ts'
import { colour, comparisonLines, plain, type Paint, type RunReport } from '../report/format.ts'
import { render, type DocumentFormat } from '../report/documents.ts'
import { compareExit, runExit, type Gate } from '../report/gate.ts'
import { pretty } from '../report/pretty.ts'
import { serve } from '../server/server.ts'
import { planRun } from '../runner/plan.ts'
import { pair, run } from '../runner/run.ts'
import { baselines, readTrials, setBaseline } from '../store/store.ts'
import { loadConfig } from '../suite/load.ts'
import { resolveSide } from '../runner/address.ts'
import type { Io } from './main.ts'

const paintFor = (io: Io): Paint => (io.colour ? colour : plain)

export type RunFlags = {
  configFile: string
  selectors: string[]
  config?: string
  trials?: string
  baseline?: string
  allowFlaky: boolean
  allowInconclusive: boolean
  reporter: string
  out?: string
  rerun?: string
  only?: string
}

const FORMATS = ['pretty', 'json', 'ctrf', 'junit'] as const
const ONLY: Record<string, VerdictKind> = { fail: 'FAIL', flaky: 'FLAKY', error: 'ERROR', inconclusive: 'INCONCLUSIVE' }

// docs/ARCHITECTURE.md § CLI. The document named by --reporter goes to --out,
// or to stdout. stdout shows the live pretty view unless a machine-readable
// document is going there instead.
export async function runCommand(f: RunFlags, io: Io): Promise<number> {
  if (!(FORMATS as readonly string[]).includes(f.reporter)) throw new ConfigError(`--reporter must be one of ${FORMATS.join(', ')}, got "${f.reporter}"`)
  const format = f.reporter as (typeof FORMATS)[number]
  if (f.out !== undefined) writable(f.out)
  // The flag rules are checked here, so their errors name the flags.
  if (f.only !== undefined && f.rerun === undefined) throw new ConfigError('--only needs --rerun <run>')
  if (f.rerun !== undefined && f.selectors.length) throw new ConfigError('--rerun takes no selectors: it reruns the pairs --only picks')
  if (f.rerun !== undefined && f.config !== undefined) throw new ConfigError('--rerun runs the configs of the run it reruns; drop --config')
  const plan = planRun(
    f.configFile,
    {
      selectors: f.selectors,
      ...(f.config === undefined ? {} : { configs: configNames(f.config) }),
      ...(f.trials === undefined ? {} : { trials: positive('--trials', f.trials) }),
      ...(f.rerun === undefined ? {} : { rerun: { run: f.rerun, only: onlyKinds(f.only ?? '') } }),
      ...(f.baseline === undefined ? {} : { baseline: f.baseline }),
    },
    { configs: '--config a,b' },
  )
  if (plan.kind === 'nothing') {
    // A machine-readable stdout stays parseable: the note goes to stderr.
    ;(format === 'pretty' ? io.out : io.err)(plan.message)
    return 0
  }

  const gate: Gate = { allowFlaky: f.allowFlaky, allowInconclusive: f.allowInconclusive }
  const live = format === 'pretty' || f.out !== undefined ? pretty({ write: io.write, tty: io.tty }, paintFor(io)) : undefined
  const saved: string[] = []
  const toFile = format === 'pretty' && f.out !== undefined ? pretty({ write: t => saved.push(t), tty: false }, plain) : undefined

  const scheduled = new Set<string>()
  let r
  try {
    r = await run({
      ...plan.options,
      ...(io.signal ? { signal: io.signal } : {}),
      listener: e => {
        if (e.type === 'trial.queued') scheduled.add(e.key.slice(0, e.key.lastIndexOf('#')))
        live?.event(e)
        toFile?.event(e)
      },
    })
  } catch (e) {
    if (e instanceof ConfigError) throw e
    // litmus itself broke (the store could not be written): infrastructure
    // trouble, not a regression. The live view has already said so.
    io.err(`litmus: the run failed: ${redactor(secretValues(plan.options.config.redact)).text((e as Error).message)}`)
    if (live) io.write('exit 3\n')
    return 3
  }

  const exit = r.manifest.status === 'cancelled' ? (io.cancelCode?.() ?? 130) : runExit(r.verdicts, r.comparisons, gate)
  const report: RunReport = { manifest: r.manifest, verdicts: r.verdicts, comparisons: r.comparisons, notes: r.notes, trials: readTrials(plan.options.config.resultsDir, r.id), scheduled: [...scheduled], gate, exit }
  // The document is written before the live view ends, so the view's last
  // line is the exit the process really returns.
  toFile?.finish(report)
  const doc = format === 'pretty' ? saved.join('') : render(format as DocumentFormat, report)
  let final = exit
  if (f.out === undefined) {
    if (format !== 'pretty') io.write(doc)
  } else {
    // Checked before the run, but the disk can still fill: the run is written
    // either way, so this is infrastructure trouble, never a verdict.
    try {
      writeFileSync(f.out, doc)
    } catch (e) {
      io.err(`litmus: could not write ${f.out}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`)
      final = exit === 0 ? 3 : exit
    }
  }
  live?.finish({ ...report, exit: final })
  return final
}

// --out is checked before anything is spent: a typo in a path must be a usage
// error (exit 2), not a finished run whose result could not be kept. Links are
// followed, as the write will follow them. Returns the path to write, which is
// the path checked: the kernel walks every segment (`gone/../x` needs gone),
// so the raw spelling is kept, never resolve()d.
function writable(out: string): string {
  if (out === '' || out.endsWith('/') || out.endsWith(sep)) throw new ConfigError(`--out ${JSON.stringify(out)} names a directory; name a file`)
  const fail = (why: string) => new ConfigError(`--out ${out}: ${why}`)
  const errno = (e: unknown) => fail((e as NodeJS.ErrnoException).code ?? (e as Error).message)
  let st
  try {
    st = statSync(out, { throwIfNoEntry: false })
  } catch (e) {
    throw errno(e) // EACCES on the way, a name too long, a link loop
  }
  if (st?.isDirectory()) throw new ConfigError(`--out ${out} is a directory; name a file`)
  // A link whose target does not exist would be created through; refuse it.
  const link = (() => {
    try {
      return lstatSync(out, { throwIfNoEntry: false })?.isSymbolicLink() === true
    } catch {
      return false // ENOTDIR and the like: the parent check below says what is wrong
    }
  })()
  if (!st && link) throw fail('is a link to nothing')
  let dir: string
  try {
    dir = st ? dirname(realpathSync.native(out)) : realpathSync.native(dirname(out)) // native: the OS walks every segment, as the write will
  } catch {
    throw fail(`the directory ${dirname(out)} does not exist`)
  }
  if (!statSync(dir).isDirectory()) throw fail(`${dirname(out)} is not a directory`)
  try {
    accessSync(st ? out : dir, constants.W_OK)
  } catch {
    throw fail(`${st ? 'the file' : `the directory ${dir}`} is not writable`)
  }
  return out
}

function configNames(flag: string): string[] {
  const names = flag.split(',').map(s => s.trim()).filter(Boolean)
  if (names.length === 0) throw new ConfigError('--config needs at least one config name')
  const dup = names.find((n, i) => names.indexOf(n) !== i)
  if (dup !== undefined) throw new ConfigError(`--config names "${dup}" twice`)
  return names
}

function onlyKinds(text: string): VerdictKind[] {
  return text.split(',').map(s => s.trim()).filter(Boolean).map(k => {
    if (!Object.hasOwn(ONLY, k)) throw new ConfigError(`--only takes ${Object.keys(ONLY).join(', ')}; got "${k}"`)
    return ONLY[k]!
  })
}

function positive(flag: string, text: string): number {
  const n = Number(text)
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(n)) throw new ConfigError(`${flag} must be a positive whole number, got "${text}"`)
  return n
}

// Prints the comparison, and writes it only with --out: runs are append-only.
export function compareCommand(f: { configFile: string; sides: string[]; allowInconclusive: boolean; out?: string }, io: Io): number {
  if (f.sides.length !== 2) throw new ConfigError(`compare takes two sides, got ${f.sides.length}`)
  const config = loadConfig(f.configFile)
  const a = resolveSide(config.resultsDir, f.sides[0]!)
  const b = resolveSide(config.resultsDir, f.sides[1]!)
  if (f.out !== undefined) writable(f.out)
  const c = pair(a.side, a.config, b.side, b.config, { tolerance: config.compare.tolerance, warnRatio: config.compare.warn_ratio })
  const exit = compareExit(c, f.allowInconclusive)
  io.out(comparisonLines(c, paintFor(io)).join('\n'))
  // As for run: the verdict stands; a failed write only turns a pass into 3,
  // and the exit printed is the one returned.
  let final: number = exit
  if (f.out !== undefined) {
    try {
      writeFileSync(f.out, `${JSON.stringify(c, null, 2)}\n`)
    } catch (e) {
      io.err(`litmus: could not write ${f.out}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`)
      final = exit === 0 ? 3 : exit
    }
  }
  io.out(`exit ${final}`)
  return final
}

export function baselineCommand(f: { configFile: string; args: string[] }, io: Io): number {
  const config = loadConfig(f.configFile)
  const [verb, ...rest] = f.args
  if (verb === 'set' && rest.length === 2) {
    setBaseline(config.resultsDir, rest[0]!, rest[1]!)
    io.out(`baseline ${rest[0]} → ${rest[1]}`)
    return 0
  }
  if (verb === 'list' && rest.length === 0) {
    for (const [name, id] of Object.entries(baselines(config.resultsDir)).sort()) io.out(`${name}  ${id}`)
    return 0
  }
  throw new ConfigError('usage: litmus baseline set <name> <run> | litmus baseline list')
}

// Until the signal: a Ctrl-C cancels the live runs, waits for them to be
// written, and stops the server. That is the operator's intent, so it exits 0.
export async function serveCommand(f: { configFile: string; port: string }, io: Io): Promise<number> {
  const port = Number(f.port)
  if (!/^[0-9]+$/.test(f.port) || port > 65535) throw new ConfigError(`--port must be 0 to 65535, got "${f.port}"`)
  loadConfig(f.configFile) // a bad config is a usage error now, not a 400 on every request
  let litmus
  try {
    litmus = await serve({ configFile: f.configFile, port })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new ConfigError(`port ${port} is in use; pick another with --port`)
    throw e
  }
  io.out(`litmus serving ${litmus.url} (Ctrl-C to stop)`)
  const signal = io.signal
  if (signal) await new Promise(ok => (signal.aborted ? ok(undefined) : signal.addEventListener('abort', ok, { once: true })))
  await litmus.close()
  return 0
}
