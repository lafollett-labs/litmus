import { ConfigError } from '../core/errors.ts'
import { NAME } from '../core/ids.ts'
import { baselineSide, type RunSide } from '../runner/rerun.ts'
import { baselineRun, listRuns } from '../store/store.ts'

// docs/ARCHITECTURE.md § Addressing runs and comparisons:
//   <run id>                     that run; it must hold exactly one config
//   <run id>:<config>            that config within that run
//   baseline:<name>[:<config>]   the run stored under that baseline name
//   config:<name>                the latest finished run that includes that config
// A run that was cancelled, failed or is still running holds only part of its
// cases, so config:<name> never picks one. It can still be named by id.
export function resolveSide(resultsDir: string, text: string): { side: RunSide; config: string } {
  let id: string
  let config: string | undefined
  if (text.startsWith('baseline:')) {
    const [, name, cfg, ...more] = text.split(':')
    if (!name || more.length || cfg === '') throw new ConfigError(`"${text}" is not baseline:<name>[:<config>]`)
    id = baselineRun(resultsDir, name)
    config = cfg
  } else if (text.startsWith('config:')) {
    const name = text.slice('config:'.length)
    if (!NAME.test(name)) throw new ConfigError(`"${text}" is not config:<name>`)
    const latest = listRuns(resultsDir).find(m => m.status === 'finished' && Object.hasOwn(m.configs, name))
    if (!latest) throw new ConfigError(`no finished run under ${resultsDir} includes config "${name}"`)
    id = latest.id
    config = name
  } else {
    const i = text.indexOf(':')
    id = i < 0 ? text : text.slice(0, i)
    config = i < 0 ? undefined : text.slice(i + 1)
    if (config === '') throw new ConfigError(`"${text}" is not <run id>[:<config>]`)
  }
  const side = baselineSide(resultsDir, id, text)
  if (config === undefined) {
    if (side.configs.length !== 1) throw new ConfigError(`run ${id} holds configs ${side.configs.join(', ')}; name one as ${id}:<config>`)
    return { side, config: side.configs[0]! }
  }
  if (!side.configs.includes(config)) throw new ConfigError(`run ${id} has no config "${config}" (it has: ${side.configs.join(', ')})`)
  return { side, config }
}
