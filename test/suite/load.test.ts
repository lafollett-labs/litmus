import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { ConfigError } from '../../src/core/errors.ts'
import { sha256 } from '../../src/core/hash.ts'
import { discoverSuites, loadConfig } from '../../src/suite/load.ts'
import { tree } from '../helpers/tmp.ts'

const FIXTURE = join(import.meta.dirname, '../fixtures/project/litmus.config.yaml')

test('suites are discovered across every root, in root order', () => {
  const config = loadConfig(FIXTURE)
  const suites = discoverSuites(config.roots)
  assert.deepEqual(suites.map(s => s.name), ['smoke', 'gate'])
  assert.deepEqual(suites[0]!.cases.map(c => c.id), ['smoke/always-passes', 'smoke/review-me'])
})

test('case settings layer case over suite defaults over built-ins, and tags merge', () => {
  const [smoke, gate] = discoverSuites(loadConfig(FIXTURE).roots)
  const passes = smoke!.cases[0]!
  const review = smoke!.cases[1]!
  assert.equal(passes.settings.trials, 3)
  assert.equal(review.settings.trials, 5)
  assert.deepEqual(review.settings.tags, ['smoke', 'review', 'ts'])
  assert.equal(gate!.cases[0]!.settings.trials, 3)
  assert.equal(gate!.cases[0]!.settings.policy, 'all')
})

test('prompt_file is read, truth and fixture are found, and config paths resolve from the config file', () => {
  const config = loadConfig(FIXTURE)
  const review = discoverSuites(config.roots)[0]!.cases[1]!
  assert.match(review.prompt, /\{\{fixture\}\}/)
  assert.equal(review.truth?.bugs[0]?.id, 'off-by-one')
  assert.ok(review.fixtureDir?.endsWith('review-me/fixture'))
  assert.ok(config.resultsDir.endsWith('project/.litmus/runs'))
})

const suite = (name: string) => ({
  [`${name}/suite.yaml`]: `name: ${name}\n`,
  [`${name}/cases/c/case.yaml`]: 'name: c\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: regex, pattern: x }]\n',
})

test('a suite name defined under two roots is an error, not a shadow', () => {
  const a = tree(suite('dup'))
  const b = tree(suite('dup'))
  assert.throws(() => discoverSuites([a, b]), (e: Error) => e instanceof ConfigError && /defined twice/.test(e.message))
})

test('a directory whose name differs from its suite or case name is an error', () => {
  const root = tree({ 'dir/suite.yaml': 'name: other\n' })
  assert.throws(() => discoverSuites([root]), /must be named "other"/)
})

test('a suite with no cases, or a missing root, is an error rather than an empty run', () => {
  assert.throws(() => discoverSuites([tree({ 'empty/suite.yaml': 'name: empty\n' })]), /has no cases/)
  assert.throws(() => discoverSuites(['/no/such/root']), /is not a directory/)
})

test('a schema error names the file and the field', () => {
  const root = tree({ ...suite('s'), 's/cases/c/case.yaml': 'name: c\nexecutor: { kind: model, prompt: hi }\ngraders: []\n' })
  assert.throws(() => discoverSuites([root]), (e: Error) => /case\.yaml/.test(e.message) && /graders/.test(e.message))
})

test('review-match without truth.yaml, a missing fix patch, and a missing prompt_file are errors', () => {
  const noTruth = tree({
    ...suite('s'),
    's/cases/c/case.yaml': 'name: c\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: review-match }]\n',
  })
  assert.throws(() => discoverSuites([noTruth]), /needs a truth\.yaml/)

  const noFix = tree({
    ...suite('s'),
    's/cases/c/truth.yaml':
      'kind: seeded\nbugs: [{ id: b, file: a, lines: [1, 1], severity: low, category: x, summary: s, proof: p, fix: fix/b.patch }]\n',
  })
  assert.throws(() => discoverSuites([noFix]), /fix for bug "b" not found/)

  const noPrompt = tree({ ...suite('s'), 's/cases/c/case.yaml': 'name: c\nexecutor: { kind: model, prompt_file: p.md }\ngraders: [{ kind: regex, pattern: x }]\n' })
  assert.throws(() => discoverSuites([noPrompt]), /prompt_file not found/)
})

test('min_trials above trials is an error', () => {
  const root = tree({ ...suite('s'), 's/cases/c/case.yaml': 'name: c\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: regex, pattern: x }]\ntrials: 2\nmin_trials: 3\n' })
  assert.throws(() => discoverSuites([root]), /min_trials \(3\) exceeds trials \(2\)/)
})

test('a subject is hashed by content, so a changed skill is a new subject version', () => {
  const root = tree({
    ...suite('s'),
    's/skill.md': 'Review carefully.',
    's/cases/c/case.yaml': 'name: c\nsubject: ../../skill.md\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: regex, pattern: x }]\n',
  })
  const c = discoverSuites([root])[0]!.cases[0]!
  assert.equal(c.subject?.hash, sha256('Review carefully.'))
})

test('invalid YAML and a missing config are config errors', () => {
  assert.throws(() => loadConfig('/no/such/litmus.config.yaml'), ConfigError)
  const root = tree({ 'litmus.config.yaml': 'suites: [\n' })
  assert.throws(() => loadConfig(join(root, 'litmus.config.yaml')), /not valid YAML/)
})
