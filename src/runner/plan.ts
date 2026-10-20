import { ConfigError } from '../core/errors.ts'
import { trialKey } from '../core/ids.ts'
import type { VerdictKind } from '../core/types.ts'
import { baselineRun, readRun } from '../store/store.ts'
import { bedrockRegion } from '../providers/index.ts'
import { loadProject, type Config } from '../suite/load.ts'
import type { ConfigDef, JudgeDef } from '../suite/schema.ts'
import { select, type Selection } from '../suite/select.ts'
import { judgesOf } from './case-hash.ts'
import { baselineSide, rerunPairs } from './rerun.ts'
import type { RunOptions } from './run.ts'

// A run as the operator asked for it, from the CLI's flags or the API's body.
export type RunRequest = {
  selectors: string[]
  configs?: string[]
  trials?: number
  rerun?: { run: string; only: VerdictKind[] }
  baseline?: string
}

export type Plan = { kind: 'run'; options: Omit<RunOptions, 'signal' | 'listener'> } | { kind: 'nothing'; message: string }

// Everything the operator's input decides, checked before anything is spent.
// A rerun runs the configs of the run it reruns, so it takes neither configs
// nor selectors. A rerun whose verdict set matches nothing is not an error:
// there is simply nothing to do.
// `wording` names the configs field as the caller's user knows it: a flag on
// the command line, a body field in the API.
export function planRun(configFile: string, req: RunRequest, wording: { configs: string } = { configs: 'configs' }, env: NodeJS.ProcessEnv = process.env): Plan {
  const { config, suites } = loadProject(configFile, env)
  let configs: string[]
  let selectors = req.selectors
  let only: Set<string> | undefined
  let parent: string | undefined
  if (req.rerun) {
    if (req.selectors.length) throw new ConfigError('a rerun takes no selectors: it reruns the pairs its verdict set picks')
    if (req.configs !== undefined) throw new ConfigError('a rerun runs the configs of the run it reruns; name no configs')
    const stored = readRun(config.resultsDir, req.rerun.run)
    only = rerunPairs(stored, req.rerun.only)
    if (only.size === 0) return { kind: 'nothing', message: `nothing to rerun: run ${stored.manifest.id} has no ${req.rerun.only.join(', ')} verdict` }
    configs = Object.keys(stored.manifest.configs)
    selectors = [...new Set([...only].map(k => k.slice(0, k.lastIndexOf('@'))))]
    parent = stored.manifest.id
  } else {
    configs = configNames(req.configs, Object.keys(config.configs), wording.configs)
  }
  if (req.trials !== undefined && !(Number.isSafeInteger(req.trials) && req.trials > 0)) throw new ConfigError(`trials must be a positive whole number, got ${req.trials}`)
  const baseline = req.baseline === undefined ? undefined : baselineSide(config.resultsDir, baselineRun(config.resultsDir, req.baseline), `baseline:${req.baseline}`)
  const selection = select(suites, selectors, new Set(Object.keys(config.configs)))
  // expand() refuses the same way; saying so here keeps a key's config from
  // being judged on a region or provider the run was never going to use.
  for (const t of selection.flatMap(s => s.trials ?? [])) {
    if (!configs.includes(t.config)) throw new ConfigError(`trial ${trialKey(t)} names config "${t.config}", which this run does not use (${wording.configs} ${configs.join(',')})`)
  }
  runnable(config, configs, selection, only, env)
  return {
    kind: 'run',
    options: {
      config,
      selection,
      configs,
      selectors,
      ...(req.trials === undefined ? {} : { trials: req.trials }),
      ...(only ? { only } : {}),
      ...(parent ? { parent } : {}),
      ...(baseline ? { baseline } : {}),
    },
  }
}

// What would make every trial of a (case, config) pair an error is a config
// error now, before anything is spent: a bedrock config, or a bedrock judge a
// case calls, with no region; and a harness case on a provider the harness
// cannot use, or a model case on a provider only the harness can use. Only
// the pairs the run would run are checked, as expand() makes them: a trial
// key pins its own config, and a rerun runs only its pairs.
const HARNESS_PROVIDERS = ['anthropic', 'bedrock', 'claude-subscription']
const HARNESS_ONLY = ['claude-subscription']
function runnable(config: Config, configs: string[], selection: Selection, only: ReadonlySet<string> | undefined, env: NodeJS.ProcessEnv): void {
  const pairs = selection.flatMap(s => {
    const names = s.trials ? [...new Set(s.trials.map(t => t.config))] : configs
    return names.filter(n => !only || only.has(`${s.case.id}@${n}`)).map(name => ({ c: s.case, name }))
  })
  const regionless = (def: ConfigDef | JudgeDef) => def.provider === 'bedrock' && !bedrockRegion(def, env)
  const own = <T,>(m: Record<string, T>, name: string): T | undefined => (Object.hasOwn(m, name) ? m[name] : undefined)
  for (const name of new Set(pairs.map(p => p.name))) {
    const def = own(config.configs, name)
    if (def && regionless(def)) throw new ConfigError(`config "${name}" is on bedrock with no region: set region on the config, or AWS_REGION`)
  }
  for (const { c, name } of pairs) {
    const def = own(config.configs, name) // an unknown name is refused where the run starts
    if (def && c.spec.executor.kind === 'harness' && !HARNESS_PROVIDERS.includes(def.provider)) {
      throw new ConfigError(`${c.id} is a harness case, which cannot run on config "${name}" (provider ${def.provider}); the harness runs on ${HARNESS_PROVIDERS.slice(0, -1).join(', ')} or ${HARNESS_PROVIDERS.at(-1)}`)
    }
    if (def && c.spec.executor.kind !== 'harness' && HARNESS_ONLY.includes(def.provider)) {
      throw new ConfigError(`${c.id} is a ${c.spec.executor.kind} case, which cannot run on config "${name}" (provider ${def.provider}); a subscription token is for Claude Code sessions only`)
    }
  }
  for (const j of new Set(pairs.flatMap(p => judgesOf(p.c)))) {
    const def = own(config.judges, j)
    if (def && regionless(def)) throw new ConfigError(`judge "${j}" is on bedrock with no region: set region on the judge, or AWS_REGION`)
  }
}

// Left out, the configs default to the only one defined; with several, the
// operator must choose, since each one costs money.
function configNames(asked: string[] | undefined, defined: string[], field: string): string[] {
  if (asked === undefined) {
    if (defined.length === 1) return defined
    throw new ConfigError(`name the configs to run with ${field} (defined: ${defined.join(', ')})`)
  }
  if (asked.length === 0) throw new ConfigError('name at least one config')
  const dup = asked.find((n, i) => asked.indexOf(n) !== i)
  if (dup !== undefined) throw new ConfigError(`config "${dup}" is named twice`)
  return asked
}
