#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { ConfigError } from '../core/errors.ts'
import { baselineCommand, compareCommand, runCommand } from './commands.ts'
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

a side is <run id>, <run id>:<config>, baseline:<name>[:<config>] or config:<name>
a selector is <suite>, <suite>/<case>, a glob, tag:<tag>, or a trial key

options:
  --config-file <path>  litmus.config.yaml to use (default: ./litmus.config.yaml)
  -h, --help            this text

exit codes (run): 0 ok, 1 a blocking verdict or a REGRESSION, 2 a usage or
config error, 3 infrastructure trouble only, 130 cancelled`

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
      io.err(e.message)
      return 2
    }
    throw e
  }
}

function help(io: Io): number {
  io.out(USAGE)
  return 0
}

if (import.meta.main) {
  // `litmus list | head` closes the pipe early; that is the reader being done,
  // not a crash worth a stack trace.
  process.stdout.on('error', e => {
    if ((e as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0)
    throw e
  })
  // The first Ctrl-C cancels: trials in flight end cancelled and the run is
  // written. A second one leaves at once.
  const ctl = new AbortController()
  let code = 130
  const cancel = (signal: 'SIGINT' | 'SIGTERM', exit: number) => () => {
    if (ctl.signal.aborted) process.exit(exit)
    code = exit
    process.stderr.write(`\n${signal}: cancelling; again to quit now\n`)
    ctl.abort(new Error(`cancelled by ${signal}`))
  }
  process.on('SIGINT', cancel('SIGINT', 130))
  process.on('SIGTERM', cancel('SIGTERM', 143))
  const tty = process.stdout.isTTY === true
  const exit = await main(process.argv.slice(2), {
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
    write: text => process.stdout.write(text),
    tty,
    colour: tty && !process.env.NO_COLOR,
    signal: ctl.signal,
    cancelCode: () => code,
  })
  process.exitCode = exit
}
