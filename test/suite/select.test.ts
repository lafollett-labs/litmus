import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { discoverSuites, loadConfig } from '../../src/suite/load.ts'
import { parseSelector, select } from '../../src/suite/select.ts'

const suites = discoverSuites(loadConfig(join(import.meta.dirname, '../fixtures/project/litmus.config.yaml')).roots)
const ids = (texts: string[]) => select(suites, texts).map(s => s.case.id)

test('each selector form parses to its kind', () => {
  assert.equal(parseSelector('smoke').kind, 'suite')
  assert.equal(parseSelector('smoke/review-me').kind, 'case')
  assert.equal(parseSelector('smoke/*').kind, 'glob')
  assert.equal(parseSelector('tag:review').kind, 'tag')
  assert.equal(parseSelector('smoke/review-me@fake#2').kind, 'trial')
})

test('no selectors selects everything, in discovery order', () => {
  assert.deepEqual(ids([]), ['smoke/always-passes', 'smoke/review-me', 'gate/secret-case'])
})

test('suite, case, glob and tag selectors each select what they name', () => {
  assert.deepEqual(ids(['gate']), ['gate/secret-case'])
  assert.deepEqual(ids(['smoke/review-me']), ['smoke/review-me'])
  assert.deepEqual(ids(['*/*-case']), ['gate/secret-case'])
  assert.deepEqual(ids(['sm*']), ['smoke/always-passes', 'smoke/review-me'])
  assert.deepEqual(ids(['tag:review']), ['smoke/review-me'])
})

test('selectors union, and the result keeps discovery order', () => {
  assert.deepEqual(ids(['gate', 'smoke/always-passes']), ['smoke/always-passes', 'gate/secret-case'])
})

test('a trial selector narrows to that trial, and a broader selector widens it back', () => {
  const one = select(suites, ['smoke/review-me@fake#2'])
  assert.deepEqual(one[0]!.trials, [{ suite: 'smoke', case: 'review-me', config: 'fake', trial: 2 }])
  const two = select(suites, ['smoke/review-me@fake#2', 'smoke/review-me@opus#4'])
  assert.equal(two[0]!.trials?.length, 2)
  const wide = select(suites, ['smoke/review-me@fake#2', 'smoke'])
  assert.equal(wide.find(s => s.case.name === 'review-me')!.trials, undefined)
})

test('a selector that matches nothing is an error, including a trial past the case trial count', () => {
  for (const bad of ['nope', 'smoke/nope', 'nope/*', 'tag:nope', 'smoke/review-me@fake#6']) {
    assert.throws(() => select(suites, [bad]), /matched no cases/, bad)
  }
})
