#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { ConfigError } from '../core/errors.ts'
import { list } from './list.ts'

const USAGE = `usage: litmus <command> [options]

commands:
  list [select...]    the suite tree

options:
  --config-file <path>  litmus.config.yaml to use (default: ./litmus.config.yaml)
  -h, --help            this text`

// Every command takes these (docs/ARCHITECTURE.md § CLI). --config is not one
// of them: under run it names the configurations to compare.
const COMMON = {
  'config-file': { type: 'string', default: 'litmus.config.yaml' },
  help: { type: 'boolean', short: 'h', default: false },
} as const

export type Io = { out: (line: string) => void; err: (line: string) => void }

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
        if (values.help) {
          io.out(USAGE)
          return 0
        }
        return list(values['config-file'], positionals, io)
      }
      default:
        io.err(`unknown command "${command}"\n\n${USAGE}`)
        return 2
    }
  } catch (e) {
    if (e instanceof ConfigError || (e instanceof TypeError && 'code' in e && String(e.code).startsWith('ERR_PARSE_ARGS'))) {
      io.err(e.message)
      return 2
    }
    throw e
  }
}

if (import.meta.main) {
  // `litmus list | head` closes the pipe early; that is the reader being done,
  // not a crash worth a stack trace.
  process.stdout.on('error', e => {
    if ((e as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0)
    throw e
  })
  const code = await main(process.argv.slice(2), {
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
  })
  process.exitCode = code
}
