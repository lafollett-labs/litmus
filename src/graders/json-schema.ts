import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Ajv, type ValidateFunction } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { ConfigError } from '../core/errors.ts'
import { Findings } from '../suite/schema.ts'
import { readArtifact } from './common.ts'
import type { Grader } from './types.ts'

type Validate = (value: unknown) => string[] // the problems; empty when valid

const BUILTIN: Record<string, Validate> = {
  'litmus:findings': value => {
    const r = Findings.safeParse(value)
    return r.success ? [] : r.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
  },
}

// The schema is resolved before the artifact is looked at, so a typo in the
// schema path is a config error on every trial, not a quiet "artifact missing".
export const jsonSchema: Grader<'json-schema'> = async (spec, trial, ctx) => {
  const validate = spec.schema.startsWith('litmus:') ? builtin(spec.schema) : schemaFile(resolve(ctx.case.dir, spec.schema))
  const fail = (rationale: string) => ({ grader: 'json-schema', pass: false, rationale })
  const art = readArtifact(trial, spec.artifact)
  if (!art) return fail(`${spec.artifact} was not produced`)
  let value: unknown
  try {
    value = JSON.parse(art.text)
  } catch (e) {
    return fail(`${spec.artifact} is not JSON: ${(e as Error).message}`)
  }
  const problems = validate(value)
  if (problems.length) return fail(`${spec.artifact} does not match ${spec.schema}:\n${problems.slice(0, 10).join('\n')}`)
  return { grader: 'json-schema', pass: true, rationale: `${spec.artifact} matches ${spec.schema}` }
}

function builtin(name: string): Validate {
  const v = BUILTIN[name]
  if (!v) throw new ConfigError(`json-schema: unknown built-in schema "${name}" (known: ${Object.keys(BUILTIN).join(', ')})`)
  return v
}

// Draft-07 when the file says so, 2020-12 otherwise. Unknown keywords and
// formats are compile errors: a format litmus cannot check would otherwise be
// silently skipped, and every artifact would pass it.
function schemaFile(path: string): Validate {
  if (!existsSync(path)) throw new ConfigError(`json-schema: no schema file at ${path}`)
  let schema: unknown
  try {
    schema = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new ConfigError(`json-schema: ${path} is not JSON: ${(e as Error).message}`)
  }
  const draft = typeof schema === 'object' && schema !== null ? String((schema as { $schema?: unknown }).$schema ?? '') : ''
  const opts = { allErrors: true, logger: false as const }
  const ajv = draft.includes('draft-07') ? new Ajv(opts) : new Ajv2020(opts)
  let compiled: ValidateFunction
  try {
    compiled = ajv.compile(schema as object)
  } catch (e) {
    throw new ConfigError(`json-schema: ${path} is not a usable JSON Schema: ${(e as Error).message}`)
  }
  return value => (compiled(value) ? [] : (compiled.errors ?? []).map(e => `${e.instancePath || '(root)'}: ${e.message ?? 'invalid'}`))
}
