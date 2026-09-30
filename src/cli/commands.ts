import { accessSync, constants, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { ConfigError } from '../core/errors.ts'
import { redactor, secretValues } from '../core/redact.ts'
import type { VerdictKind } from '../core/types.ts'
import { colour, comparisonLines, plain, type Paint, type RunReport } from '../report/format.ts'
import { render, type DocumentFormat } from '../report/documents.ts'
import { compareExit, runExit, type Gate } from '../report/gate.ts'
import { pretty } from '../report/pretty.ts'
import { baselineSide, rerunPairs } from '../runner/rerun.ts'
import { pair, run } from '../runner/run.ts'
import { baselineRun, baselines, readRun, readTrials, setBaseline } from '../store/store.ts'
import { loadConfig, loadProject } from '../suite/load.ts'
import { select } from '../suite/select.ts'
import { resolveSide } from './address.ts'
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
  const trials = f.trials === undefined ? undefined : positive('--trials', f.trials)
  const { config, suites } = loadProject(f.configFile)

  let names: string[]
  let selectors = f.selectors
  let only: Set<string> | undefined
  let parent: string | undefined
  if (f.rerun !== undefined) {
    if (f.selectors.length) throw new ConfigError('--rerun takes no selectors: it reruns the pairs --only picks')
    if (f.config !== undefined) throw new ConfigError('--rerun runs the configs of the run it reruns; drop --config')
    const kinds = (f.only ?? '').split(',').map(s => s.trim()).filter(Boolean).map(k => {
      if (!Object.hasOwn(ONLY, k)) throw new ConfigError(`--only takes ${Object.keys(ONLY).join(', ')}; got "${k}"`)
      return ONLY[k]!
    })
    const stored = readRun(config.resultsDir, f.rerun)
    only = rerunPairs(stored, kinds)
    if (only.size === 0) {
      // A machine-readable stdout stays parseable: the note goes to stderr.
      const say = format === 'pretty' ? io.out : io.err
      say(`nothing to rerun: run ${stored.manifest.id} has no ${kinds.join(', ')} verdict`)
      return 0
    }
    names = Object.keys(stored.manifest.configs)
    selectors = [...new Set([...only].map(k => k.slice(0, k.lastIndexOf('@'))))]
    parent = stored.manifest.id
  } else {
    if (f.only !== undefined) throw new ConfigError('--only needs --rerun <run>')
    names = configNames(f.config, Object.keys(config.configs))
  }

  const baseline = f.baseline === undefined ? undefined : baselineSide(config.resultsDir, baselineRun(config.resultsDir, f.baseline), `baseline:${f.baseline}`)
  const gate: Gate = { allowFlaky: f.allowFlaky, allowInconclusive: f.allowInconclusive }
  const live = format === 'pretty' || f.out !== undefined ? pretty({ write: io.write, tty: io.tty }, paintFor(io)) : undefined
  const saved: string[] = []
  const toFile = format === 'pretty' && f.out !== undefined ? pretty({ write: t => saved.push(t), tty: false }, plain) : undefined

  const scheduled = new Set<string>()
  let r
  try {
    r = await run({
      config,
      selection: select(suites, selectors, new Set(Object.keys(config.configs))),
      configs: names,
      selectors,
      ...(trials === undefined ? {} : { trials }),
      ...(only ? { only } : {}),
      ...(parent ? { parent } : {}),
      ...(baseline ? { baseline } : {}),
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
    io.err(`litmus: the run failed: ${redactor(secretValues(config.redact)).text((e as Error).message)}`)
    if (live) io.write('exit 3\n')
    return 3
  }

  const exit = r.manifest.status === 'cancelled' ? (io.cancelCode?.() ?? 130) : runExit(r.verdicts, r.comparisons, gate)
  const report: RunReport = { manifest: r.manifest, verdicts: r.verdicts, comparisons: r.comparisons, notes: r.notes, trials: readTrials(config.resultsDir, r.id), scheduled: [...scheduled], gate, exit }
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
// followed, as the write will follow them.
function writable(out: string): void {
  if (out === '' || out.endsWith('/') || out.endsWith(sep)) throw new ConfigError(`--out ${JSON.stringify(out)} names a directory; name a file`)
  const path = resolve(out)
  const st = statSync(path, { throwIfNoEntry: false })
  if (st?.isDirectory()) throw new ConfigError(`--out ${out} is a directory; name a file`)
  const dir = dirname(st ? realpathSync(path) : path)
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new ConfigError(`--out ${out}: ${dir} is not a directory that exists`)
  try {
    accessSync(st ? path : dir, constants.W_OK)
  } catch {
    throw new ConfigError(`--out ${out}: ${st ? 'the file' : `the directory ${dir}`} is not writable`)
  }
}

function configNames(flag: string | undefined, defined: string[]): string[] {
  if (flag === undefined) {
    if (defined.length === 1) return defined
    throw new ConfigError(`name the configs to run with --config a,b (defined: ${defined.join(', ')})`)
  }
  const names = flag.split(',').map(s => s.trim()).filter(Boolean)
  if (names.length === 0) throw new ConfigError('--config needs at least one config name')
  const dup = names.find((n, i) => names.indexOf(n) !== i)
  if (dup !== undefined) throw new ConfigError(`--config names "${dup}" twice`)
  return names
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
  io.out(`exit ${exit}`)
  if (f.out !== undefined) {
    // As for run: the verdict stands; a failed write only turns a pass into 3.
    try {
      writeFileSync(f.out, `${JSON.stringify(c, null, 2)}\n`)
    } catch (e) {
      io.err(`litmus: could not write ${f.out}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`)
      return exit === 0 ? 3 : exit
    }
  }
  return exit
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
