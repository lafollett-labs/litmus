import { latestVerdicts } from '../store/store.ts'
import { loadProject } from '../suite/load.ts'
import { select } from '../suite/select.ts'
import type { Io } from './main.ts'

export function list(configPath: string, selectors: string[], io: Io): number {
  const { config, suites } = loadProject(configPath)
  const selection = select(suites, selectors, new Set(Object.keys(config.configs)))
  const latest = latestVerdicts(config.resultsDir)
  const width = Math.max(...selection.map(s => s.case.name.length))
  let suite = ''
  for (const { case: c, trials } of selection) {
    if (c.suite !== suite) {
      suite = c.suite
      const n = selection.filter(s => s.case.suite === suite).length
      io.out(`${suite}  (${n} ${n === 1 ? 'case' : 'cases'})`)
    }
    const runs = trials ? trials.map(t => `@${t.config}#${t.trial}`).join(' ') : `${c.settings.trials} trials`
    const tags = c.settings.tags.length ? `  [${c.settings.tags.join(', ')}]` : ''
    const expect = c.spec.expect === 'fail' ? '  expect fail' : ''
    const seen = latest.get(c.id)
    const last = seen ? `  ${[...seen].sort(([a], [b]) => (a < b ? -1 : 1)).map(([cfg, v]) => `${cfg}: ${v}`).join(', ')}` : ''
    io.out(`  ${c.name.padEnd(width)}  ${c.spec.executor.kind.padEnd(7)}  ${runs}${tags}${expect}${last}`)
  }
  return 0
}
