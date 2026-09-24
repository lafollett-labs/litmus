import type { Redactor } from '../core/redact.ts'
import type { ExecutorResult, RunEvent } from '../core/types.ts'
import type { Workdir } from '../sandbox/workdir.ts'
import type { LoadedCase } from '../suite/load.ts'
import type { ConfigDef, ConfigFile } from '../suite/schema.ts'

export type ExecJob = {
  key: string // trial key
  case: LoadedCase
  configName: string
  config: ConfigDef
  trial: number
  attempt: number
  workdir: Workdir
  suiteRoots: string[] // every configured suite root: the gate never lets a subject reach one
  out: { artifacts: string; transcript: string } // owned by the store; the executor writes here
  pricing: ConfigFile['pricing']
  emit: (e: RunEvent) => void
  redact: Redactor // applied to everything the executor writes or emits: a subject with a shell can print a key
  signal: AbortSignal // the operator's cancel
}

export type Executor = (job: ExecJob) => Promise<ExecutorResult>
