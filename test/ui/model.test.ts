import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RunEvent, Verdict } from '../../src/core/types.ts'
import { apply, buildTree, emptyRun, filterTree, selection, type Node, type SuiteView } from '../../ui/src/model.ts'

const suites: SuiteView[] = [
  {
    name: 's',
    cases: [
      { id: 's/a', name: 'a', executor: 'model', trials: 2, tags: [], expect: 'pass', latest: { fake: 'PASS' } },
      { id: 's/b', name: 'b', executor: 'model', trials: 2, tags: [], expect: 'pass', latest: { fake: 'FAIL', other: 'FLAKY' } },
    ],
  },
]
const verdict = (c: string, config: string, v: Verdict['verdict']) => ({ case: c, config, verdict: v }) as Verdict
const find = (nodes: Node[], id: string): Node | undefined => {
  for (const n of nodes) {
    if (n.id === id) return n
    const hit = find(n.children, id)
    if (hit) return hit
  }
  return undefined
}

test('with no run, config rows show the latest verdicts and parents count them', () => {
  const tree = buildTree(suites, ['fake', 'other'], null)
  assert.equal(find(tree, 's/a@fake')!.status, 'pass')
  assert.equal(find(tree, 's/a@other'), undefined) // never run with other
  assert.equal(find(tree, 's/b')!.status, 'fail') // the worst beneath it
  assert.deepEqual(tree[0]!.counts, { pass: 1, fail: 1, flaky: 1, error: 0, inconclusive: 0 })
})

test('a run folds its events into trial rows, and a live trial outranks every verdict', () => {
  const run = emptyRun('r')
  const events: RunEvent[] = [
    { type: 'run.started', run: 'r', jobs: 2 },
    { type: 'trial.queued', key: 's/a@fake#1' },
    { type: 'trial.queued', key: 's/a@fake#2' },
    { type: 'trial.started', key: 's/a@fake#1' },
  ]
  events.forEach(e => apply(run, e))
  let tree = buildTree(suites, ['fake'], run)
  assert.deepEqual(find(tree, 's/a@fake')!.children.map(t => [t.label, t.status]), [['#1', 'running'], ['#2', 'queued']])
  assert.equal(tree[0]!.status, 'running')
  apply(run, { type: 'trial.finished', key: 's/a@fake#1', status: 'pass', graders: [] })
  apply(run, { type: 'trial.finished', key: 's/a@fake#2', status: 'fail', graders: [] })
  apply(run, { type: 'case.settled', case: 's/a', config: 'fake', verdict: verdict('s/a', 'fake', 'FLAKY') })
  apply(run, { type: 'run.finished', run: 'r', summary: { PASS: 0, FAIL: 0, FLAKY: 1, ERROR: 0, INCONCLUSIVE: 0 } })
  tree = buildTree(suites, ['fake'], run)
  assert.equal(find(tree, 's/a@fake')!.status, 'flaky')
  assert.equal(run.done, 'finished')
})

test('a cancelled run leaves its unsettled config showing its trials, never an old verdict', () => {
  const run = emptyRun('r')
  apply(run, { type: 'trial.queued', key: 's/a@fake#1' })
  apply(run, { type: 'trial.finished', key: 's/a@fake#1', status: 'cancelled', graders: [] })
  assert.equal(find(buildTree(suites, ['fake'], run), 's/a@fake')!.status, 'cancelled')
})

test('the filter keeps matching rows with their ancestors; chips keep config rows of that status', () => {
  const tree = buildTree(suites, ['fake', 'other'], null)
  assert.deepEqual(filterTree(tree, 'b@oth', new Set()).map(s => s.children.map(c => c.children.map(r => r.id))), [[['s/b@other']]])
  assert.deepEqual(filterTree(tree, '', new Set(['fail'])).map(s => s.children.map(c => c.children.map(r => r.id))), [[['s/b@fake']]])
  assert.deepEqual(filterTree(tree, 'nothing', new Set()), [])
})

test('checked rows become selectors, and a checked config or trial brings its config', () => {
  const run = emptyRun('r')
  apply(run, { type: 'trial.queued', key: 's/b@other#1' })
  const tree = buildTree(suites, ['fake', 'other'], run)
  assert.deepEqual(selection(tree, new Set(['s']), ['fake']), { select: ['s'], configs: ['fake'] })
  assert.deepEqual(selection(tree, new Set(['s/a', 's/b@other#1']), ['fake']), { select: ['s/a', 's/b@other#1'], configs: ['fake', 'other'] })
  assert.deepEqual(selection(tree, new Set(['s/b@other']), []), { select: ['s/b@other#1'], configs: ['other'] })
})
