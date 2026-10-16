#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { ConfigError } from '../core/errors.ts'
import { redactor, secretValues } from '../core/redact.ts'
import { loadConfig } from '../suite/load.ts'
import { baselineCommand, compareCommand, runCommand, serveCommand, validateCommand } from './commands.ts'
import { list } from './list.ts'

const USAGE = `usage: litmus <command> [options]

commands:
  list [select...]                     the suite tree, with the latest verdicts
  run [select...] --config a,b         run cases; every later config is compared with the first
      [--trials N] [--baseline name] [--allow-flaky] [--allow-inconclusive]
      [--reporter pretty|json|ctrf|junit] [--out path]
  run --rerun <run> --only fail,flaky,error,inconclusive
  compare <side> <side> [--allow-inconclusive] [--out path]
  baseline set <name> <run> | baseline list
  validate [select...]                 check cases, and run every seeded bug's proof
  serve [--port 4317]                  the API and UI on 127.0.0.1 until Ctrl-C

a side is <run id>, <run id>:<config>, baseline:<name>[:<config>] or config:<name>
a selector is <suite>, <suite>/<case>, a glob, tag:<tag>, or a trial key

options:
  --config-file <path>  litmus.config.yaml to use (default: ./litmus.config.yaml)
  -h, --help            this text

exit codes (run): 0 ok, 1 a blocking verdict or a REGRESSION, 2 a usage or
config error, 3 infrastructure trouble only, 130 cancelled by SIGINT, 143 by SIGTERM
exit codes (compare): 0 ok, 1 a REGRESSION (or INCONCLUSIVE), 2 a usage or
config error, 3 infrastructure trouble`

// Every command takes these (docs/ARCHITECTURE.md § CLI). --config is not one
// of them: under run it names the configurations to compare.
const COMMON = {
  'config-file': { type: 'string', default: 'litmus.config.yaml' },
  help: { type: 'boolean', short: 'h', default: false },
} as const

const RUN = {
  ...COMMON,
  config: { type: 'string' },
  trials: { type: 'string' },
  baseline: { type: 'string' },
  'allow-flaky': { type: 'boolean', default: false },
  'allow-inconclusive': { type: 'boolean', default: false },
  reporter: { type: 'string', default: 'pretty' },
  out: { type: 'string' },
  rerun: { type: 'string' },
  only: { type: 'string' },
} as const

const SERVE = { ...COMMON, port: { type: 'string', default: '4317' } } as const

const COMPARE = { ...COMMON, 'allow-inconclusive': { type: 'boolean', default: false }, out: { type: 'string' } } as const

// out and err print whole lines; write prints raw text (the live view redraws
// its status line with it). tty turns the status line on, colour the colours.
export type Io = {
  out: (line: string) => void
  err: (line: string) => void
  write: (text: string) => void
  tty: boolean
  colour: boolean
  signal?: AbortSignal
  cancelCode?: () => number // the exit code of the signal that cancelled the run
}

// Exit codes are part of the contract (docs/ARCHITECTURE.md § CLI): 2 means the
// operator's input was wrong, so CI can tell a typo from a regression.
export async function main(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined) {
    io.err(USAGE)
    return 2
  }
  if (command === '-h' || command === '--help' || command === 'help') {
    io.out(USAGE)
    return 0
  }
  try {
    switch (command) {
      case 'list': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: COMMON })
        if (values.help) return help(io)
        return list(values['config-file'], positionals, io)
      }
      case 'run': {
        const { values: v, positionals } = parseArgs({ args: rest, allowPositionals: true, options: RUN })
        if (v.help) return help(io)
        return await runCommand(
          {
            configFile: v['config-file'],
            selectors: positionals,
            allowFlaky: v['allow-flaky'],
            allowInconclusive: v['allow-inconclusive'],
            reporter: v.reporter,
            ...(v.config === undefined ? {} : { config: v.config }),
            ...(v.trials === undefined ? {} : { trials: v.trials }),
            ...(v.baseline === undefined ? {} : { baseline: v.baseline }),
            ...(v.out === undefined ? {} : { out: v.out }),
            ...(v.rerun === undefined ? {} : { rerun: v.rerun }),
            ...(v.only === undefined ? {} : { only: v.only }),
          },
          io,
        )
      }
      case 'compare': {
        const { values: v, positionals } = parseArgs({ args: rest, allowPositionals: true, options: COMPARE })
        if (v.help) return help(io)
        return compareCommand({ configFile: v['config-file'], sides: positionals, allowInconclusive: v['allow-inconclusive'], ...(v.out === undefined ? {} : { out: v.out }) }, io)
      }
      case 'baseline': {
        const { values: v, positionals } = parseArgs({ args: rest, allowPositionals: true, options: COMMON })
        if (v.help) return help(io)
        return baselineCommand({ configFile: v['config-file'], args: positionals }, io)
      }
      case 'validate': {
        const { values: v, positionals } = parseArgs({ args: rest, allowPositionals: true, options: COMMON })
        if (v.help) return help(io)
        return await validateCommand({ configFile: v['config-file'], selectors: positionals }, io)
      }
      case 'serve': {
        const { values: v, positionals } = parseArgs({ args: rest, allowPositionals: true, options: SERVE })
        if (v.help) return help(io)
        if (positionals.length) throw new ConfigError(`serve takes no arguments, got ${positionals.join(' ')}`)
        return await serveCommand({ configFile: v['config-file'], port: v.port }, io)
      }
      default:
        io.err(`unknown command "${command}"\n\n${USAGE}`)
        return 2
    }
  } catch (e) {
    if (e instanceof TypeError && 'code' in e && String(e.code).startsWith('ERR_PARSE_ARGS')) {
      io.err(`${e.message}\n\n${USAGE}`)
      return 2
    }
    if (e instanceof ConfigError) {
      io.err(redactFor(argv).text(e.message))
      return 2
    }
    // Anything else (a results directory that cannot be read, a run record of
    // the wrong shape) is infrastructure trouble, never a REGRESSION: one
    // redacted line and exit 3, with no stack trace and its absolute paths.
    io.err(`litmus: ${redactFor(argv).text(e instanceof Error ? e.message : String(e))}`)
    return 3
  }
}

// The config's own redact list when it still loads, and the credential
// variables always.
function redactFor(argv: string[]) {
  let names: readonly string[] = []
  try {
    const { values } = parseArgs({ args: argv.slice(1), options: COMMON, strict: false, allowPositionals: true })
    names = loadConfig(String(values['config-file'] ?? 'litmus.config.yaml')).redact
  } catch {
    // the credential variables alone
  }
  return redactor(secretValues(names))
}

function help(io: Io): number {
  io.out(USAGE)
  return 0
}

if (import.meta.main) {
  // A reader that closes early (`litmus list | head`) is done reading, not a
  // crash. Writing stops there, and the command still finishes: a run that
  // was piped through head must end written, with its real exit code.
  let closed = false
  process.stdout.on('error', e => {
    if ((e as NodeJS.ErrnoException).code === 'EPIPE') closed = true
    else throw e
  })
  const write = (text: string) => void (closed || process.stdout.write(text))
  // A log reader that has gone (`2>&1 | head`) is not the run's failure either.
  process.stderr.on('error', () => undefined)
  // Only a run (or a server, with its live runs), or a validate running proofs,
  // is worth cancelling: the first Ctrl-C (or SIGTERM) cancels, trials or
  // proofs in flight are stopped (their process groups killed) and cleaned
  // up; a second one leaves at once. Every other command finishes in moments.
  const ctl = new AbortController()
  let code = 130
  // main() takes the first argument as the command; were options ever allowed
  // before it, this gate would have to follow.
  if (['run', 'serve', 'validate'].includes(process.argv[2] ?? '')) {
    const cancel = (signal: 'SIGINT' | 'SIGTERM', exit: number) => () => {
      if (ctl.signal.aborted) process.exit(exit)
      code = exit
      process.stderr.write(`\n${signal}: cancelling; again to quit now\n`)
      ctl.abort(new Error(`cancelled by ${signal}`))
    }
    process.on('SIGINT', cancel('SIGINT', 130))
    process.on('SIGTERM', cancel('SIGTERM', 143))
  }
  const tty = process.stdout.isTTY === true
  const exit = await main(process.argv.slice(2), {
    out: line => write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
    write,
    tty,
    colour: tty && !process.env.NO_COLOR,
    signal: ctl.signal,
    cancelCode: () => code,
  })
  process.exitCode = exit
}
