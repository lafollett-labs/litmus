import { discoverSuites, loadConfig } from '../suite/load.ts'
import { select } from '../suite/select.ts'
import type { Io } from './main.ts'

export function list(configPath: string, selectors: string[], io: Io): number {
  const config = loadConfig(configPath)
  const selection = select(discoverSuites(config.roots), selectors, new Set(Object.keys(config.configs)))
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
    io.out(`  ${c.name.padEnd(width)}  ${c.spec.executor.kind.padEnd(7)}  ${runs}${tags}${expect}`)
  }
  return 0
}
