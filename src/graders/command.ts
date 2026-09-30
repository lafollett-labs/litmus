import { spawn } from 'node:child_process'
import type { GraderResult } from '../core/types.ts'
import { scrubbedEnv } from '../sandbox/env.ts'
import type { Grader } from './types.ts'

const TAIL_BYTES = 4000
// The last stretch of output is kept whole and redacted before it is cut to
// TAIL_BYTES: a cut through a key would leave a fragment redaction cannot match.
const WINDOW_BYTES = 1 << 20

// Runs code the subject may have written, so it gets no credentials, and it is
// uncontained (docs/ARCHITECTURE.md § Sandbox). The shell leads its own process
// group: on a timeout the whole group is killed, because `sh -c "go test"`
// leaves grandchildren holding stdout open, and waiting on them would hang
// grading forever. Its code can print any file the operator can read, so its
// output is redacted here, before it is cut.
export const command: Grader<'command'> = (spec, trial, ctx) =>
  new Promise<GraderResult>(resolve => {
    const result = (pass: boolean, rationale: string): GraderResult => ({ grader: 'command', pass, rationale })
    if (ctx.signal.aborted) return resolve(result(false, 'cancelled'))

    const child = spawn('/bin/sh', ['-c', spec.run], {
      cwd: trial.workdir,
      env: scrubbedEnv({ home: trial.home }),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let tail = Buffer.alloc(0)
    const keep = (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk])
      if (tail.length > WINDOW_BYTES) tail = tail.subarray(tail.length - WINDOW_BYTES)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const output = () => {
      const safe = ctx.redact.bytes(tail)
      const text = safe.subarray(Math.max(0, safe.length - TAIL_BYTES)).toString('utf8').trimEnd()
      return text ? `\n${text}` : ''
    }

    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined
    let settled = false
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // the group is already gone
      }
    }
    const fromExit = () => {
      const e = exited!
      return e.code === 0 ? result(true, `exit 0${output()}`) : result(false, `${e.code === null ? `killed by ${e.signal}` : `exit ${e.code}`}${output()}`)
    }
    const finish = (r: GraderResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      child.stdout.destroy()
      child.stderr.destroy()
      resolve(r)
    }
    const onAbort = () => (killGroup(), finish(result(false, 'cancelled')))
    const timer = setTimeout(() => {
      killGroup()
      // The shell may have exited while something it left behind (setsid,
      // say) still holds the pipes; its exit code is still the answer.
      finish(exited ? fromExit() : result(false, `timeout after ${spec.timeout_s}s${output()}`))
    }, spec.timeout_s * 1000)
    ctx.signal.addEventListener('abort', onAbort, { once: true })

    child.on('error', e => (killGroup(), finish(result(false, `could not run /bin/sh: ${e.message}`))))
    // Anything the command left running in the background dies with it.
    child.on('exit', (code, signal) => ((exited = { code, signal }), killGroup()))
    child.on('close', () => exited && finish(fromExit()))
  })
