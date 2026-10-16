import { computed, markRaw, reactive, watch } from 'vue'
import type { Comparison, VerdictKind } from '../../src/core/types.ts'
import { api, follow, type TrialDetail } from './api.ts'
import { apply, buildTree, emptyRun, filterTree, selection, type RunState, type Status, type SuiteView } from './model.ts'

export type View = 'tree' | 'compare'

// A trial's detail belongs to the run it was opened in. `waiting` is a trial
// that has not finished, whose record does not exist yet.
// `note` is a neutral word in place of a record there is not yet.
type Detail = { run: string; key: string; data: TrialDetail | null; error: string | null; note: string | null; waiting: boolean }

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
  detail: null as Detail | null,
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

// Shows a run: its stored events replayed, then live ones while it runs. The
// trial open in the detail pane belonged to the run before, so it closes.
export function watchRun(id: string): void {
  unfollow?.()
  // Reactive from the start: events fold into the same proxy the tree reads.
  const run = reactive(emptyRun(id))
  state.run = run
  state.comparisons = []
  state.detail = null
  unfollow = follow(id, e => apply(run, e), () => void settled(id))
}

// The stream has ended. The stored run is the truth: a stream can end
// without a last event when the run is live in another process (the CLI), or
// when the server itself has gone.
async function settled(id: string): Promise<void> {
  if (state.run?.id !== id) return
  try {
    const [stored, suites] = await Promise.all([api.run(id), api.suites()])
    if (state.run?.id !== id) return
    if (state.run.done === 'running') state.run.done = stored.manifest.status === 'running' ? 'elsewhere' : stored.manifest.status
    state.comparisons = stored.comparisons
    state.suites = suites
    // A trial still waiting will get no trial.finished now: look for its record once.
    const d = state.detail
    if (d?.waiting && d.run === id) void fetchTrial(id, d.key, absentOn(state.run.done))
  } catch (e) {
    if (state.run?.id !== id) return
    if (state.run.done === 'running') state.run.done = 'lost'
    state.message = `lost touch with litmus: ${(e as Error).message}`
    const d = state.detail
    if (d?.waiting && d.run === id) Object.assign(d, { waiting: false, error: LOST })
  }
}

const ELSEWHERE = 'still running in another process; reload to see it when it finishes'
const LOST = 'lost touch with litmus before this trial finished'
const NOT_RUN = 'not run: the run was cancelled before this trial started'

// What to say, in place of a 404, for an unfinished trial of a run that ended
// this way: its record may not exist yet, or (cancelled) never will.
function absentOn(done: RunState['done']): string | undefined {
  if (done === 'elsewhere') return ELSEWHERE
  if (done === 'cancelled') return NOT_RUN
  return undefined
}

async function start(body: Parameters<typeof api.start>[0]): Promise<void> {
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

// Blank uses each case's own count. Anything else must be a whole number
// above zero, and a run is not started on a count that is not one.
function trialCount(): { trials?: number } | undefined {
  const text = state.trials.trim()
  if (!text) return {}
  const n = Number(text)
  if (/^[1-9][0-9]*$/.test(text) && Number.isSafeInteger(n)) return { trials: n }
  state.message = `the trial count must be a whole number above zero, or blank for each case's own; got "${text}"`
  return undefined
}

export function runAll(): Promise<void> {
  state.message = null
  const t = trialCount()
  return t ? start({ select: [], configs: state.chosen, ...t }) : Promise.resolve()
}

export function runSelected(): Promise<void> {
  state.message = null
  const t = trialCount()
  if (!t) return Promise.resolve()
  const s = selection(tree.value, state.checked, state.chosen, t.trials)
  if ('problem' in s) {
    state.message = s.problem
    return Promise.resolve()
  }
  const keyed = s.select.some(x => x.includes('#'))
  return start({ ...s, ...t }).then(() => {
    // The server runs a trial key's own trial, whatever the count says.
    if (keyed && t.trials !== undefined && !state.message) state.message = 'trial and config rows ran the trials they name; the trial count applied only to case and suite rows'
  })
}

export function rerun(only: VerdictKind[]): Promise<void> {
  state.message = null
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

export function openTrial(key: string): void {
  if (!state.run) return
  const run = state.run.id
  const done = state.run.done
  const finished = !['queued', 'running'].includes(state.run.trials[key] ?? '')
  // Once the stream has ended, no trial.finished will come: an unfinished
  // trial is settled now, as settled() settles one already open.
  const waiting = !finished && done === 'running'
  state.detail = { run, key, data: null, error: null, note: null, waiting }
  if (waiting) return
  if (!finished && done === 'lost') state.detail.error = LOST
  else void fetchTrial(run, key, finished ? undefined : absentOn(done))
}

// `absent`: what to say, instead of the server's 404, when the record may
// simply not exist yet. Any other error is shown as it is.
async function fetchTrial(run: string, key: string, absent?: string): Promise<void> {
  const mine = () => state.detail?.run === run && state.detail.key === key
  try {
    // Raw: a transcript can be large, and nothing in it changes once written.
    const data = markRaw(await api.trial(run, key))
    if (mine()) Object.assign(state.detail!, { data, waiting: false })
  } catch (e) {
    const missing = absent !== undefined && (e as { status?: number }).status === 404
    if (mine()) Object.assign(state.detail!, missing ? { note: absent, waiting: false } : { error: (e as Error).message, waiting: false })
  }
}

// A trial opened while it ran is fetched the moment it finishes.
watch(
  () => (state.detail?.waiting && state.run?.id === state.detail.run ? state.run.trials[state.detail.key] : undefined),
  s => {
    const d = state.detail
    if (d?.waiting && s !== undefined && s !== 'queued' && s !== 'running') void fetchTrial(d.run, d.key)
  },
)

export function toggle(set: Set<string>, id: string): void {
  if (set.has(id)) set.delete(id)
  else set.add(id)
}
