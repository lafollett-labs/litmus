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
  done: 'running' | 'finished' | 'cancelled' | 'failed'
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
  selector: string[] // what checking this row adds to a run's selection
  configs: string[] // configs the selection needs
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
          .map(([key, state]) => ({ id: key, kind: 'trial', label: `#${trialNumber(key)}`, status: state, counts: zero(), selector: [key], configs: [cfg], children: [] }))
        const v = run?.verdicts[`${c.id}@${cfg}`]?.verdict ?? (run && trials.length ? undefined : c.latest[cfg])
        const live = trials.map(t => t.status).filter(st => st === 'running' || st === 'queued')
        const status: Status = live.length ? worst(live) : v ? VERDICT_STATUS[v] : trials.length ? worst(trials.map(t => t.status)) : 'none'
        const counts = zero()
        if (v) counts[VERDICT_STATUS[v] as keyof Counts]++
        return { id: `${c.id}@${cfg}`, kind: 'config', label: cfg, status, counts, selector: [c.id], configs: [cfg], children: trials } satisfies Node
      })
      return { id: c.id, kind: 'case', label: c.name, status: worst(rows.map(r => r.status)), counts: sum(rows), selector: [c.id], configs: [], children: rows } satisfies Node
    })
    return { id: s.name, kind: 'suite', label: s.name, status: worst(cases.map(c => c.status)), counts: sum(cases), selector: [s.name], configs: [], children: cases } satisfies Node
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

// A run of the checked rows: the selectors they add, and the configs to run
// them with. A checked config or trial row brings its own config along, so a
// trial key is never refused for naming a config the run does not use.
export function selection(tree: Node[], checked: ReadonlySet<string>, chosen: string[]): { select: string[]; configs: string[] } {
  const select = new Set<string>()
  const configs = new Set(chosen)
  const visit = (n: Node) => {
    if (checked.has(n.id)) {
      if (n.kind === 'config') {
        // One config of a case: its trials by key, since a selector cannot name a config.
        for (const t of n.children) select.add(t.id)
        if (!n.children.length) select.add(n.selector[0]!)
      } else {
        for (const s of n.selector) select.add(s)
      }
      for (const c of n.configs) configs.add(c)
      return
    }
    n.children.forEach(visit)
  }
  tree.forEach(visit)
  return { select: [...select], configs: [...configs] }
}

export const BADGE: [keyof Counts, string][] = [
  ['pass', '✓'],
  ['fail', '✗'],
  ['flaky', '~'],
  ['error', '!'],
  ['inconclusive', '?'],
]
