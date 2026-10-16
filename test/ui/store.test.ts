import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RunEvent } from '../../src/core/types.ts'

// The store against a stubbed server: fetch answers from `routes`, and each
// EventSource is one the test drives by hand.
class FakeSource {
  static CLOSED = 2
  static all: FakeSource[] = []
  readyState = 1
  onmessage: ((m: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  url: string
  constructor(url: string) {
    this.url = url
    FakeSource.all.push(this)
  }
  close() {
    this.readyState = FakeSource.CLOSED
  }
  send(e: RunEvent) {
    this.onmessage?.({ data: JSON.stringify(e) })
  }
  fail() {
    this.onerror?.()
  }
  // A real EventSource refused outright (a 204, or any error status) is
  // CLOSED before its error fires.
  refused() {
    this.readyState = FakeSource.CLOSED
    this.onerror?.()
  }
}
type Route = (body: unknown) => unknown
let routes: Record<string, Route> = {}
const posts: unknown[] = []
Object.assign(globalThis, {
  EventSource: FakeSource,
  fetch: async (path: string, init?: { method?: string; body?: string }) => {
    const key = `${init?.method ?? 'GET'} ${path}`
    const body = init?.body === undefined ? undefined : JSON.parse(init.body)
    if (init?.method === 'POST') posts.push(body)
    const route = routes[key]
    if (!route) return { ok: false, status: 404, json: async () => ({ error: `no route ${key}` }) }
    try {
      const data = route(body)
      return { ok: true, status: 200, json: async () => data }
    } catch (e) {
      return { ok: false, status: 500, json: async () => ({ error: (e as Error).message }) }
    }
  },
})
const { state, watchRun, openTrial, runSelected, runAll } = await import('../../ui/src/store.ts')
const tick = () => new Promise(r => setTimeout(r, 0))
const suites = [{ name: 's', cases: [{ id: 's/a', name: 'a', executor: 'model', trials: 2, tags: [], expect: 'pass', latest: {} }] }]
const stored = (status: string) => () => ({ manifest: { id: 'r', status }, verdicts: [], comparisons: [] })
const last = () => FakeSource.all.at(-1)!

test('a stream that ends while its stored run is still running shows the run as live elsewhere', async () => {
  routes = { 'GET /api/runs/r': stored('running'), 'GET /api/suites': () => suites }
  watchRun('r')
  last().send({ type: 'trial.started', key: 's/a@fake#1' })
  last().fail()
  await tick()
  assert.equal(state.run?.done, 'elsewhere')
})

test('a stream that ends with the server gone shows the run as lost, and says so, in the detail pane too', async () => {
  routes = {}
  state.message = null
  watchRun('r')
  last().send({ type: 'trial.started', key: 's/a@fake#1' })
  openTrial('s/a@fake#1')
  last().fail()
  await tick()
  assert.equal(state.run?.done, 'lost')
  assert.match(state.message ?? '', /lost touch with litmus/)
  assert.equal(state.detail?.waiting, false)
  assert.match(state.detail?.error ?? '', /lost touch with litmus before this trial finished/)
})

test('a trial waiting on a run that turns out to be live elsewhere is looked up once', async () => {
  let fetched = 0
  routes = { 'GET /api/runs/r5': stored('running'), 'GET /api/suites': () => suites, 'GET /api/runs/r5/trial?key=s%2Fa%40fake%231': () => (fetched++, { record: { status: 'fail' }, transcript: [], artifacts: [] }) }
  watchRun('r5')
  last().send({ type: 'trial.started', key: 's/a@fake#1' })
  openTrial('s/a@fake#1')
  last().fail()
  await tick()
  await tick()
  assert.equal(state.run?.done, 'elsewhere')
  assert.equal(fetched, 1)
  assert.equal(state.detail?.data?.record.status, 'fail')
})

test('a trial still running in another process says so, not the server\'s 404', async () => {
  routes = { 'GET /api/runs/r6': stored('running'), 'GET /api/suites': () => suites }
  watchRun('r6')
  last().send({ type: 'trial.started', key: 's/a@fake#1' })
  openTrial('s/a@fake#1')
  last().fail()
  await tick()
  await tick()
  assert.equal(state.run?.done, 'elsewhere')
  assert.equal(state.detail?.waiting, false)
  assert.equal(state.detail?.error, null)
  assert.match(state.detail?.note ?? '', /still running in another process/)
})

test('a trial a failed run never recorded shows the error, not the live-elsewhere note', async () => {
  routes = { 'GET /api/runs/r7': stored('failed'), 'GET /api/suites': () => suites }
  watchRun('r7')
  last().send({ type: 'trial.started', key: 's/a@fake#1' })
  openTrial('s/a@fake#1')
  last().fail()
  await tick()
  await tick()
  assert.equal(state.run?.done, 'failed')
  assert.equal(state.detail?.note, null)
  assert.match(state.detail?.error ?? '', /no route/)
})

test('a run live elsewhere whose trial read fails for another reason shows that error', async () => {
  routes = { 'GET /api/runs/r8': stored('running'), 'GET /api/suites': () => suites, 'GET /api/runs/r8/trial?key=s%2Fa%40fake%231': () => { throw new Error('EACCES reading trial.json') } }
  watchRun('r8')
  last().send({ type: 'trial.started', key: 's/a@fake#1' })
  openTrial('s/a@fake#1')
  last().fail()
  await tick()
  await tick()
  assert.equal(state.run?.done, 'elsewhere')
  assert.equal(state.detail?.note, null)
  assert.equal(state.detail?.error, 'EACCES reading trial.json')
})

test('a trial opened while it runs waits, is fetched when it finishes, and closes when another run is shown', async () => {
  let fetched = 0
  routes = { 'GET /api/runs/r2/trial?key=s%2Fa%40fake%231': () => (fetched++, { record: { status: 'pass' }, transcript: [], artifacts: [] }) }
  watchRun('r2')
  last().send({ type: 'trial.started', key: 's/a@fake#1' })
  openTrial('s/a@fake#1')
  await tick()
  assert.equal(state.detail?.waiting, true)
  assert.equal(fetched, 0)
  last().send({ type: 'trial.finished', key: 's/a@fake#1', status: 'pass', graders: [] })
  await tick()
  assert.equal(fetched, 1)
  assert.equal(state.detail?.waiting, false)
  assert.equal(state.detail?.data?.record.status, 'pass')
  watchRun('r3')
  assert.equal(state.detail, null)
})

test('a bad trial count or a refused selection starts nothing and says why', async () => {
  routes = { 'GET /api/suites': () => suites }
  state.suites = suites as typeof state.suites
  state.configs = ['fake']
  state.chosen = ['fake']
  posts.length = 0
  state.trials = '2.5'
  await runAll()
  assert.match(state.message ?? '', /whole number above zero/)
  state.trials = ''
  state.checked = new Set()
  await runSelected()
  assert.match(state.message ?? '', /check the rows/)
  assert.equal(posts.length, 0)
})

test('trial keys run with a trial count: the count is said to apply only to case and suite rows', async () => {
  routes = { 'POST /api/runs': () => ({ id: 'r4' }) }
  state.run = null
  state.trials = '3'
  state.checked = new Set(['s/a@fake'])
  await runSelected()
  assert.deepEqual(posts.at(-1), { select: ['s/a@fake#1', 's/a@fake#2'], configs: ['fake'], trials: 3 })
  assert.match(state.message ?? '', /applied only to case and suite rows/)
})

test('a stream refused outright (CLOSED before its error, as a 204 is) still settles the run', async () => {
  routes = { 'GET /api/runs/r9': stored('running'), 'GET /api/suites': () => suites }
  watchRun('r9')
  last().refused()
  await tick()
  await tick()
  assert.equal(state.run?.done, 'elsewhere')
})
