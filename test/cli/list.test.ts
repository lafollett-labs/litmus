import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const MAIN = join(import.meta.dirname, '../../src/cli/main.ts')
const CONFIG = join(import.meta.dirname, '../fixtures/project/litmus.config.yaml')
const litmus = (...args: string[]) => spawnSync(process.execPath, [MAIN, ...args], { encoding: 'utf8' })

test('list prints every suite with its cases, executor, trials and tags', () => {
  const r = litmus('list', '--config-file', CONFIG)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.stdout.trimEnd().split('\n'), [
    'smoke  (2 cases)',
    '  always-passes  model    3 trials  [smoke]',
    '  review-me      model    5 trials  [smoke, review, ts]',
    'gate  (1 case)',
    '  secret-case    harness  3 trials  expect fail',
  ])
})

test('list narrows to its selectors', () => {
  const r = litmus('list', '--config-file', CONFIG, 'smoke/review-me@fake#2')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.stdout.trimEnd().split('\n'), ['smoke  (1 case)', '  review-me  model    @fake#2  [smoke, review, ts]'])
})

test('a bad selector, a missing config, a bad flag and an unknown command exit 2 with a message', () => {
  for (const args of [
    ['list', '--config-file', CONFIG, 'nope'],
    ['list', '--config-file', '/no/such.yaml'],
    ['list', '--config', CONFIG],
    ['list', '--config-file', CONFIG, 'smoke/review-me@nope#2'],
    ['list', '--bogus'],
    ['frobnicate'],
  ]) {
    const r = litmus(...args)
    assert.equal(r.status, 2, args.join(' '))
    assert.ok(r.stderr.length > 0, args.join(' '))
  }
})

test('help exits 0 with usage on stdout; no command at all exits 2 with usage on stderr', () => {
  for (const args of [['--help'], ['list', '--help'], ['list', '-h']]) {
    const r = litmus(...args)
    assert.equal(r.status, 0, args.join(' '))
    assert.match(r.stdout, /usage: litmus/, args.join(' '))
  }
  const none = litmus()
  assert.equal(none.status, 2)
  assert.equal(none.stdout, '')
  assert.match(none.stderr, /usage: litmus/)
})

test('the same trial named twice is listed once', () => {
  const r = litmus('list', '--config-file', CONFIG, 'smoke/review-me@fake#2', 'smoke/review-me@fake#2')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, / @fake#2 {2}\[/)
})
