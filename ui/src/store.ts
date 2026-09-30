import { computed, reactive } from 'vue'
import type { Comparison, VerdictKind } from '../../src/core/types.ts'
import { api, follow, type TrialDetail } from './api.ts'
import { apply, buildTree, emptyRun, filterTree, selection, type RunState, type Status, type SuiteView } from './model.ts'

export type View = 'tree' | 'compare'

export const state = reactive({
  suites: [] as SuiteView[],
  configs: [] as string[],
  chosen: [] as string[], // the toolbar's configs
  trials: '' as string, // the toolbar's trial count; blank uses each case's own
  run: null as RunState | null,
  comparisons: [] as Comparison[],
  checked: new Set<string>(),
  expanded: new Set<string>(),
  filter: '',
  chips: new Set<Status>(),
  detail: null as { key: string; data: TrialDetail | null; error: string | null } | null,
  view: 'tree' as View,
  message: null as string | null,
  busy: false,
})

let unfollow: (() => void) | null = null

export const tree = computed(() => buildTree(state.suites, state.configs, state.run))
export const visible = computed(() => filterTree(tree.value, state.filter, state.chips))
export const running = computed(() => state.run?.done === 'running')

export async function load(): Promise<void> {
  const [suites, configs, runs] = await Promise.all([api.suites(), api.configs(), api.runs()])
  state.suites = suites
  state.configs = Object.keys(configs.configs)
  if (!state.chosen.length) state.chosen = state.configs.slice(0, 1)
  for (const s of suites) state.expanded.add(s.name)
  const latest = runs[0]
  if (latest && !state.run) watchRun(latest.id)
}

// Shows a run: its stored events replayed, then live ones while it runs.
export function watchRun(id: string): void {
  unfollow?.()
  // Reactive from the start: events fold into the same proxy the tree reads.
  const run = reactive(emptyRun(id))
  state.run = run
  state.comparisons = []
  unfollow = follow(id, e => apply(run, e), () => void settled(id))
}

async function settled(id: string): Promise<void> {
  if (state.run?.id !== id) return
  // The stream can end without a last event (a run whose record was cut
  // short): the stored run is the truth then.
  const [stored, suites] = await Promise.all([api.run(id), api.suites()])
  if (state.run?.id !== id) return
  if (state.run.done === 'running') state.run.done = stored.manifest.status === 'running' ? 'failed' : stored.manifest.status
  state.comparisons = stored.comparisons
  state.suites = suites
}

async function start(body: Parameters<typeof api.start>[0]): Promise<void> {
  state.message = null
  state.busy = true
  try {
    const r = await api.start(body)
    if (r.id === null) state.message = r.message ?? 'nothing to run'
    else watchRun(r.id)
  } catch (e) {
    state.message = (e as Error).message
  } finally {
    state.busy = false
  }
}

const trialCount = () => {
  const n = Number(state.trials)
  return state.trials.trim() && Number.isSafeInteger(n) && n > 0 ? { trials: n } : {}
}

export const runAll = () => start({ select: [], configs: state.chosen, ...trialCount() })

export function runSelected(): Promise<void> {
  const s = selection(tree.value, state.checked, state.chosen)
  if (!s.select.length) {
    state.message = 'check the rows to run first'
    return Promise.resolve()
  }
  return start({ ...s, ...trialCount() })
}

export function rerun(only: VerdictKind[]): Promise<void> {
  if (!state.run) {
    state.message = 'no run to rerun from'
    return Promise.resolve()
  }
  return start({ rerun: { run: state.run.id, only } })
}

export async function cancel(): Promise<void> {
  if (!state.run || state.run.done !== 'running') return
  try {
    await api.cancel(state.run.id)
  } catch (e) {
    state.message = (e as Error).message
  }
}

export async function openTrial(key: string): Promise<void> {
  if (!state.run) return
  const id = state.run.id
  state.detail = { key, data: null, error: null }
  try {
    const data = await api.trial(id, key)
    if (state.detail?.key === key) state.detail.data = data
  } catch (e) {
    if (state.detail?.key === key) state.detail.error = (e as Error).message
  }
}

export function toggle(set: Set<string>, id: string): void {
  if (set.has(id)) set.delete(id)
  else set.add(id)
}
