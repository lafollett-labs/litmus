import { ConfigError } from '../core/errors.ts'
import { parseTrialKey, trialKey, type TrialRef } from '../core/ids.ts'
import type { LoadedCase, LoadedSuite } from './load.ts'

export type Selector =
  | { kind: 'suite'; suite: string }
  | { kind: 'case'; id: string }
  | { kind: 'glob'; pattern: RegExp; text: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'trial'; ref: TrialRef }

// One entry per selected case. `trials` is set only when every selector that
// reached the case named a single trial; any broader selector widens it back
// to every trial.
export type Selection = { case: LoadedCase; trials?: TrialRef[] }[]

export function parseSelector(text: string): Selector {
  const ref = parseTrialKey(text)
  if (ref) return { kind: 'trial', ref }
  if (text.startsWith('tag:')) return { kind: 'tag', tag: text.slice(4) }
  if (/[*?]/.test(text)) return { kind: 'glob', pattern: globToRegExp(text), text }
  if (text.includes('/')) return { kind: 'case', id: text }
  return { kind: 'suite', suite: text }
}

// A selector that matches nothing is an error. An empty selection that exits 0
// is a CI job reporting success on a typo. That includes a trial key naming a
// config the config file does not define: the trial it names cannot exist.
export function select(suites: LoadedSuite[], texts: string[], configs: ReadonlySet<string>): Selection {
  const all = suites.flatMap(s => s.cases)
  if (all.length === 0) throw new ConfigError('no cases to select from')
  if (texts.length === 0) return all.map(c => ({ case: c }))

  const picked = new Map<string, { case: LoadedCase; trials?: TrialRef[] }>()
  for (const text of texts) {
    const sel = parseSelector(text)
    if (sel.kind === 'trial' && !configs.has(sel.ref.config)) {
      throw new ConfigError(`selector "${text}" names config "${sel.ref.config}", which is not defined (defined: ${[...configs].join(', ')})`)
    }
    const hits = all.filter(c => matches(sel, c))
    if (hits.length === 0) throw new ConfigError(`selector "${text}" matched no cases`)
    for (const c of hits) {
      const prior = picked.get(c.id)
      if (sel.kind !== 'trial') {
        picked.set(c.id, { case: c })
      } else if (!prior) {
        picked.set(c.id, { case: c, trials: [sel.ref] })
      } else if (prior.trials && !prior.trials.some(t => trialKey(t) === text)) {
        prior.trials.push(sel.ref)
      }
    }
  }
  return all.filter(c => picked.has(c.id)).map(c => picked.get(c.id)!)
}

function matches(sel: Selector, c: LoadedCase): boolean {
  switch (sel.kind) {
    case 'suite':
      return c.suite === sel.suite
    case 'case':
      return c.id === sel.id
    case 'glob':
      return sel.pattern.test(c.id)
    case 'tag':
      return c.settings.tags.includes(sel.tag)
    case 'trial':
      return c.suite === sel.ref.suite && c.name === sel.ref.case && sel.ref.trial <= c.settings.trials
  }
}

// `*` and `?` never cross the suite/case slash, so `code-review*` means suites,
// and `*/go-*` means cases in any suite.
function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('')
    .map(ch => (ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return glob.includes('/') ? new RegExp(`^${body}$`) : new RegExp(`^${body}/[^/]+$`)
}
