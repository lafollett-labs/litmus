import type { RunEvent, Verdict, VerdictKind } from '../../src/core/types.ts'

// The tree's shape and state, with no Vue in it: the components render what
// these functions return, and node --test checks them directly.

export type SuiteView = {
  name: string
  cases: { id: string; name: string; executor: string; trials: number; tags: string[]; expect: 'pass' | 'fail'; latest: Record<string, VerdictKind> }[]
}

export type TrialState = 'queued' | 'running' | 'pass' | 'fail' | 'error' | 'cancelled'
export type Status = TrialState | 'flaky' | 'inconclusive' | 'none'

// What one run looks like from its event stream.
export type RunState = {
  id: string
  trials: Record<string, TrialState> // trial key -> state
  verdicts: Record<string, Verdict> // "<case>@<config>" -> verdict
  // elsewhere: live in another process (the CLI), so this page cannot follow
  // or cancel it; lost: the server went away mid-run.
  done: 'running' | 'finished' | 'cancelled' | 'failed' | 'elsewhere' | 'lost'
}

export function emptyRun(id: string): RunState {
  return { id, trials: {}, verdicts: {}, done: 'running' }
}

// Folds one event into the run's state; the same fold serves the live stream
// and a replay of a finished run.
export function apply(run: RunState, e: RunEvent): void {
  switch (e.type) {
    case 'trial.queued':
      run.trials[e.key] = 'queued'
      break
    case 'trial.started':
      run.trials[e.key] = 'running'
      break
    case 'trial.finished':
      run.trials[e.key] = e.status
      break
    case 'case.settled':
      run.verdicts[`${e.case}@${e.config}`] = e.verdict
      break
    case 'run.finished':
      run.done = 'finished'
      break
    case 'run.cancelled':
      run.done = 'cancelled'
      break
    case 'run.failed':
      run.done = 'failed'
      break
    default:
      break
  }
}

export const VERDICT_STATUS: Record<VerdictKind, Status> = { PASS: 'pass', FAIL: 'fail', FLAKY: 'flaky', ERROR: 'error', INCONCLUSIVE: 'inconclusive' }

export type Counts = { pass: number; fail: number; flaky: number; error: number; inconclusive: number }
const zero = (): Counts => ({ pass: 0, fail: 0, flaky: 0, error: 0, inconclusive: 0 })

export type Node = {
  id: string // unique in the tree: suite, case id, "<case>@<config>", or a trial key
  kind: 'suite' | 'case' | 'config' | 'trial'
  label: string
  status: Status
  counts: Counts // config-level verdicts at or under this node
  // What checking this row adds to a run's selection. A config row names its
  // trials by key, 1 to the case's own count, since a selector cannot name a
  // config; a case or suite row names itself and runs on the toolbar's configs.
  selector: string[]
  configs: string[] // the configs its trial keys name; none for a case or suite row
  selectable: boolean // false for a trial beyond the case's own count, which no selector can name
  children: Node[]
}

// Worst first: a parent shows the most urgent state beneath it.
const RANK: Status[] = ['running', 'queued', 'fail', 'error', 'flaky', 'inconclusive', 'cancelled', 'pass', 'none']
const worst = (xs: Status[]): Status => xs.reduce<Status>((w, s) => (RANK.indexOf(s) < RANK.indexOf(w) ? s : w), 'none')

const trialNumber = (key: string) => Number(key.slice(key.lastIndexOf('#') + 1))

// suite -> case -> config -> trial. A config row shows the run's verdict for
// it, or else the latest stored one; trial rows exist only for the run shown.
export function buildTree(suites: SuiteView[], configs: string[], run: RunState | null): Node[] {
  return suites.map(s => {
    const cases = s.cases.map(c => {
      const shown = configs.filter(cfg => c.latest[cfg] !== undefined || Object.keys(run?.trials ?? {}).some(k => k.startsWith(`${c.id}@${cfg}#`)))
      const rows = (shown.length ? shown : configs).map(cfg => {
        const prefix = `${c.id}@${cfg}#`
        const trials: Node[] = Object.entries(run?.trials ?? {})
          .filter(([k]) => k.startsWith(prefix))
          .sort(([a], [b]) => trialNumber(a) - trialNumber(b))
          .map(([key, state]) => ({ id: key, kind: 'trial', label: `#${trialNumber(key)}`, status: state, counts: zero(), selector: [key], configs: [cfg], selectable: trialNumber(key) <= c.trials, children: [] }))
        const v = run?.verdicts[`${c.id}@${cfg}`]?.verdict ?? (run && trials.length ? undefined : c.latest[cfg])
        const live = trials.map(t => t.status).filter(st => st === 'running' || st === 'queued')
        const status: Status = live.length ? worst(live) : v ? VERDICT_STATUS[v] : trials.length ? worst(trials.map(t => t.status)) : 'none'
        const counts = zero()
        if (v) counts[VERDICT_STATUS[v] as keyof Counts]++
        const keys = Array.from({ length: c.trials }, (_, i) => `${prefix}${i + 1}`)
        return { id: `${c.id}@${cfg}`, kind: 'config', label: cfg, status, counts, selector: keys, configs: [cfg], selectable: true, children: trials } satisfies Node
      })
      return { id: c.id, kind: 'case', label: c.name, status: worst(rows.map(r => r.status)), counts: sum(rows), selector: [c.id], configs: [], selectable: true, children: rows } satisfies Node
    })
    return { id: s.name, kind: 'suite', label: s.name, status: worst(cases.map(c => c.status)), counts: sum(cases), selector: [s.name], configs: [], selectable: true, children: cases } satisfies Node
  })
}

function sum(nodes: Node[]): Counts {
  const out = zero()
  for (const n of nodes) for (const k of Object.keys(out) as (keyof Counts)[]) out[k] += n.counts[k]
  return out
}

// The rows a text filter and status chips leave, with their ancestors. A text
// matches a row's id; a chip matches a config row's status (and its trials).
export function filterTree(nodes: Node[], text: string, chips: ReadonlySet<Status>): Node[] {
  const t = text.trim().toLowerCase()
  const keep = (n: Node): Node | undefined => {
    const hit = (!t || n.id.toLowerCase().includes(t)) && (chips.size === 0 || (n.kind === 'config' && chips.has(n.status)) || (n.kind === 'trial' && chips.has(n.status)))
    if (hit && (n.kind === 'config' || n.kind === 'trial')) return n
    const children = n.children.map(keep).filter((c): c is Node => c !== undefined)
    if (children.length) return { ...n, children }
    return hit && chips.size === 0 ? n : undefined
  }
  return nodes.map(keep).filter((n): n is Node => n !== undefined)
}

// A run of the checked rows. A checked row covers everything under it. Case
// and suite rows run on the toolbar's configs; config and trial rows run as
// trial keys, on their own config. The server runs one config list for every
// selector, so when both kinds are checked, a key naming a config the toolbar
// has not chosen would spread that config to the case rows too: that is
// refused with a reason rather than guessed at. So is a config or trial row
// checked under a checked case or suite, which runs on the toolbar's configs
// and trial count only: one whose config is not chosen, or whose trial number
// is past that count, would never run.
export type Selection = { select: string[]; configs: string[] } | { problem: string }

export function selection(tree: Node[], checked: ReadonlySet<string>, chosen: string[], trials?: number): Selection {
  const named = new Set<string>() // case and suite selectors
  const keys = new Map<string, string>() // trial key -> its config
  const covered = new Map<string, Node>() // a config or trial row under a checked case or suite
  const visit = (n: Node, under: boolean) => {
    if (checked.has(n.id) && n.selectable) {
      if (n.kind === 'config' || n.kind === 'trial') {
        if (under) covered.set(n.id, n)
        else for (const k of n.selector) keys.set(k, n.configs[0]!)
        return
      }
      if (!under) named.add(n.id)
      under = true
    }
    for (const c of n.children) visit(c, under)
  }
  tree.forEach(n => visit(n, false))
  const keyConfigs = [...new Set(keys.values())]
  if (named.size === 0) return keys.size ? { select: [...keys.keys()], configs: keyConfigs } : { problem: 'check the rows to run first' }
  if (chosen.length === 0) return { problem: 'choose the configs to run in the toolbar' }
  const lost = [...covered.values()].filter(n => !chosen.includes(n.configs[0]!))
  if (lost.length) {
    const cfgs = [...new Set(lost.map(n => n.configs[0]!))].join(', ')
    return { problem: `${lost.map(n => n.id).join(', ')} ${lost.length === 1 ? 'is' : 'are'} checked under a checked case or suite, which runs only on the toolbar's configs; choose ${cfgs} in the toolbar, or uncheck the row above` }
  }
  const past = trials === undefined ? [] : [...covered.values()].filter(n => Math.max(...n.selector.map(trialNumber)) > trials)
  if (past.length) {
    return { problem: `${past.map(n => n.id).join(', ')} ${past.length === 1 ? 'names a trial' : 'name trials'} past the trial count ${trials}, which the checked case or suite above runs; clear the count, or uncheck the row above` }
  }
  const stray = keyConfigs.filter(c => !chosen.includes(c))
  if (stray.length) return { problem: `the checked case and suite rows would run on ${stray.join(', ')} too; choose ${stray.join(', ')} in the toolbar, or run those rows on their own` }
  return { select: [...named, ...keys.keys()], configs: chosen }
}

export const BADGE: [keyof Counts, string][] = [
  ['pass', '✓'],
  ['fail', '✗'],
  ['flaky', '~'],
  ['error', '!'],
  ['inconclusive', '?'],
]
