import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigError } from '../../src/core/errors.ts'
import { sha256 } from '../../src/core/hash.ts'
import { discoverSuites, effectiveMinTrials, loadConfig, loadProject } from '../../src/suite/load.ts'
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

test('an unset min_trials is half the trials requested, rounded up; a set one is capped by them', () => {
  const [smoke] = discoverSuites(loadConfig(FIXTURE).roots)
  const [three, five] = [smoke!.cases[0]!.settings, smoke!.cases[1]!.settings]
  assert.equal(three.min_trials, undefined)
  assert.equal(effectiveMinTrials(three), 2) // 3 trials
  assert.equal(effectiveMinTrials(five), 3) // 5 trials
  assert.equal(effectiveMinTrials(five, 4), 2) // --trials 4: half of what ran, not of what the case says
  assert.equal(effectiveMinTrials({ ...five, min_trials: 4 }), 4)
  assert.equal(effectiveMinTrials({ ...five, min_trials: 4 }, 2), 2)
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

const withParams = (params: string) =>
  join(tree({ 'litmus.config.yaml': `suites: [./s]\nconfigs:\n  a:\n    provider: anthropic\n    model: m\n    params: ${params}\n` }), 'litmus.config.yaml')

test('params pass through when they only shape model behaviour', () => {
  const c = loadConfig(withParams('{ temperature: 0, thinking: { type: adaptive }, stop: [END] }'), {})
  assert.deepEqual(c.configs.a && 'params' in c.configs.a && c.configs.a.params, { temperature: 0, thinking: { type: 'adaptive' }, stop: ['END'] })
})

test('params refuse a credential-shaped key or headers at any depth', () => {
  for (const params of ['{ api_key: x }', '{ extra: { Authorization: x } }', '{ list: [{ session_id: x }] }', '{ headers: {} }', '{ Headers: {} }']) {
    assert.throws(() => loadConfig(withParams(params), {}), /is not allowed; params is for model behaviour/, params)
  }
})

test('params refuse a value equal to a live credential, including one named in redact', () => {
  const key = 'sk-ant-test-0123456789'
  assert.throws(() => loadConfig(withParams(`{ note: [${key}] }`), { ANTHROPIC_API_KEY: key }), /holds the value of a credential variable/)
  const root = tree({
    'litmus.config.yaml': `suites: [./s]\nredact: [MY_GATEWAY_TOKEN]\njudges:\n  j:\n    provider: anthropic\n    model: m\n    params: { user: gw-secret-value }\nconfigs:\n  a: { provider: fake }\n`,
  })
  assert.throws(() => loadConfig(join(root, 'litmus.config.yaml'), { MY_GATEWAY_TOKEN: 'gw-secret-value' }), /judges\.j\.params\.user holds/)
  assert.doesNotThrow(() => loadConfig(join(root, 'litmus.config.yaml'), { ANTHROPIC_API_KEY: '' }))
})

const CASE = (extra = '') => `name: c\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: regex, pattern: x }]\n${extra}`
const configError = (re: RegExp) => (e: Error) => e instanceof ConfigError && re.test(e.message)

test('a filesystem surprise on an authored path is a config error, never a crash', () => {
  const dirPrompt = tree({ ...suite('s'), 's/cases/c/case.yaml': 'name: c\nexecutor: { kind: model, prompt_file: p }\ngraders: [{ kind: regex, pattern: x }]\n', 's/cases/c/p/x': '' })
  assert.throws(() => discoverSuites([dirPrompt]), configError(/prompt_file at .* is not a file/))

  const dirFix = tree({
    ...suite('s'),
    's/cases/c/truth.yaml': 'kind: seeded\nbugs: [{ id: b, file: a, lines: [1, 1], severity: low, category: x, summary: s, proof: p, fix: fix }]\n',
    's/cases/c/fix/b.patch': '',
  })
  assert.throws(() => discoverSuites([dirFix]), configError(/fix for bug "b" at .* is not a file/))

  const dangling = tree(suite('s'))
  symlinkSync(join(dangling, 'nowhere'), join(dangling, 'gone'))
  assert.throws(() => discoverSuites([dangling]), configError(/gone is a broken symlink/))

  if (process.getuid?.() !== 0) {
    const locked = tree({ ...suite('s'), 's/cases/c/case.yaml': 'name: c\nexecutor: { kind: model, prompt_file: p.md }\ngraders: [{ kind: regex, pattern: x }]\n', 's/cases/c/p.md': 'hi' })
    chmodSync(join(locked, 's/cases/c/p.md'), 0o000)
    assert.throws(() => discoverSuites([locked]), configError(/cannot read .*p\.md/))
    chmodSync(join(locked, 's/cases/c/p.md'), 0o644)
  }
})

test('a root with no suites, or a root one level too deep, is an error rather than an empty run', () => {
  assert.throws(() => discoverSuites([tree({ 'notes.md': '' })]), /holds no suite/)
  const deep = tree(suite('s'))
  assert.throws(() => discoverSuites([join(deep, 's')]), /looks like a suite but has no suite\.yaml|holds no suite/)
  assert.throws(() => discoverSuites([tree({ 'x/suite.yml': 'name: x\n' })]), /x looks like a suite but has no suite\.yaml/)
})

test('every directory under cases/ is a case, except the _ and . ones', () => {
  const typo = tree({ ...suite('s'), 's/cases/d/case.yml': CASE() })
  assert.throws(() => discoverSuites([typo]), /cases\/d has no case\.yaml/)
  const shared = tree({ ...suite('s'), 's/cases/_shared/diff.patch': '', 's/cases/.cache/x': '', 's/cases/README.md': '' })
  assert.deepEqual(discoverSuites([shared])[0]!.cases.map(c => c.name), ['c'])
})

test('a case directory must be named for its case, and suite and case names follow the NAME grammar', () => {
  assert.throws(() => discoverSuites([tree({ ...suite('s'), 's/cases/c/case.yaml': CASE().replace('name: c', 'name: other') })]), /case "other" lives in .*must be named "other"/)
  assert.throws(() => discoverSuites([tree({ 'Bad/suite.yaml': 'name: Bad\n' })]), /name: must be lowercase/)
})

test('a directory subject is hashed by its tree, and only a harness may have one', () => {
  const harness = 'name: c\nsubject: ../../plugin\nexecutor: { kind: harness, harness: claude-code, prompt: /review }\ngraders: [{ kind: regex, pattern: x }]\n'
  const make = (files: Record<string, string>) => tree({ ...suite('s'), 's/cases/c/case.yaml': harness, ...files })
  const one = discoverSuites([make({ 's/plugin/a.md': 'A', 's/plugin/sub/b.md': 'B' })])[0]!.cases[0]!.subject
  const same = discoverSuites([make({ 's/plugin/sub/b.md': 'B', 's/plugin/a.md': 'A', 's/plugin/.git/HEAD': 'x' })])[0]!.cases[0]!.subject
  const edited = discoverSuites([make({ 's/plugin/a.md': 'A!', 's/plugin/sub/b.md': 'B' })])[0]!.cases[0]!.subject
  const renamed = discoverSuites([make({ 's/plugin/a2.md': 'A', 's/plugin/sub/b.md': 'B' })])[0]!.cases[0]!.subject
  assert.equal(one?.kind, 'dir')
  assert.equal(one?.hash, same?.hash)
  assert.notEqual(one?.hash, edited?.hash)
  assert.notEqual(one?.hash, renamed?.hash)

  const linked = make({ 's/plugin/a.md': 'A' })
  symlinkSync('/etc/hosts', join(linked, 's/plugin/hosts'))
  assert.throws(() => discoverSuites([linked]), configError(/hosts is a symlink/))

  const model = tree({ ...suite('s'), 's/plugin/a.md': 'A', 's/cases/c/case.yaml': CASE('subject: ../../plugin\n') })
  assert.throws(() => discoverSuites([model]), /a model case's subject is its system prompt, so it must be a file/)
  assert.throws(() => discoverSuites([tree({ ...suite('s'), 's/cases/c/case.yaml': CASE('subject: ../../nope.md\n') })]), /subject not found/)
})

test('a file subject is hashed by its bytes, not by decoded text', () => {
  const root = tree({ ...suite('s'), 's/cases/c/case.yaml': CASE('subject: s.bin\n') })
  writeFileSync(join(root, 's/cases/c/s.bin'), Buffer.from([0xff, 0x41]))
  const a = discoverSuites([root])[0]!.cases[0]!.subject?.hash
  writeFileSync(join(root, 's/cases/c/s.bin'), Buffer.from([0xfe, 0x41]))
  const b = discoverSuites([root])[0]!.cases[0]!.subject?.hash
  assert.notEqual(a, b) // both decode to U+FFFD A
})

test('a prompt_file or subject that points at a case\'s answers is refused', () => {
  const answers = {
    ...suite('s'),
    's/cases/c/truth.yaml': 'kind: clean\n',
    's/cases/c/fake.yaml': 'responses: []\n',
    's/cases/c/fix/b.patch': '',
    's/cases/c/proof/t.sh': '',
  }
  for (const target of ['truth.yaml', 'fake.yaml', 'fix/b.patch', 'proof/t.sh']) {
    const viaPrompt = tree({ ...answers, 's/cases/d/case.yaml': `name: d\nexecutor: { kind: model, prompt_file: ../c/${target} }\ngraders: [{ kind: regex, pattern: x }]\n` })
    assert.throws(() => discoverSuites([viaPrompt]), /prompt_file .* is a case's ground truth/, target)
    const viaSubject = tree({ ...answers, 's/cases/d/case.yaml': `name: d\nsubject: ../c/${target}\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: regex, pattern: x }]\n` })
    assert.throws(() => discoverSuites([viaSubject]), /subject .* is a case's ground truth/, target)
  }
  const fine = tree({ ...suite('s'), 's/docs/fix/notes.md': 'not a case', 's/cases/c/case.yaml': CASE('subject: ../../docs/fix/notes.md\n') })
  assert.equal(discoverSuites([fine])[0]!.cases[0]!.subject?.kind, 'file')
})

test('a recursive YAML alias is a config error, not a stack overflow', () => {
  assert.throws(() => loadConfig(withParams('&p { self: *p }'), {}), configError(/a YAML alias refers to itself/))
  const shared = loadConfig(withParams('{ a: &x { temperature: 0 }, b: *x }'), {})
  assert.ok(shared.configs.a)
})

test('harness plugins and json-schema files are resolved and checked at load', () => {
  const harness = (plugins: string) => `name: c\nexecutor: { kind: harness, harness: claude-code, prompt: /review, plugins: [${plugins}] }\ngraders: [{ kind: regex, pattern: x }]\n`
  const ok = tree({ ...suite('s'), 's/plugins/p/x.md': '', 's/cases/c/case.yaml': harness('../../plugins/p') })
  const c = discoverSuites([ok])[0]!.cases[0]!
  assert.deepEqual(c.plugins, [join(ok, 's/plugins/p')])
  assert.throws(() => discoverSuites([tree({ ...suite('s'), 's/cases/c/case.yaml': harness('../../plugins/nope') })]), /plugin \.\.\/\.\.\/plugins\/nope is not a directory/)

  const schema = (s: string) => `name: c\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: json-schema, artifact: out.json, schema: ${s} }]\n`
  assert.throws(() => discoverSuites([tree({ ...suite('s'), 's/cases/c/case.yaml': schema('out.schema.json') })]), /schema out\.schema\.json not found/)
  assert.doesNotThrow(() => discoverSuites([tree({ ...suite('s'), 's/cases/c/case.yaml': schema('litmus:findings') })]))
  assert.deepEqual(discoverSuites([tree(suite('s'))])[0]!.cases[0]!.plugins, [])
})

test('a case part that is present but broken is an error, not an absence', () => {
  const dangling = tree(suite('s'))
  symlinkSync('../_shared/renamed', join(dangling, 's/cases/c/fixture'))
  assert.throws(() => discoverSuites([dangling]), configError(/fixture is not a directory/))
  const wrongType: Record<string, string>[] = [
    { 's/cases/c/fixture': 'a file, not a tree' },
    { 's/cases/c/change.patch/x': '' },
    { 's/cases/c/fake.yaml/x': '' },
    { 's/cases/c/truth.yaml/x': '' },
  ]
  for (const files of wrongType) assert.throws(() => discoverSuites([tree({ ...suite('s'), ...files })]), ConfigError, Object.keys(files)[0])
  const gone = tree(suite('s'))
  symlinkSync('nowhere.yaml', join(gone, 's/cases/c/truth.yaml'))
  assert.throws(() => discoverSuites([gone]), configError(/truth\.yaml at .* not found|truth\.yaml not found/))
})

test('. and _ entries are skipped before they are stat-ed, so a dangling lock link never blocks a run', () => {
  const root = tree(suite('s'))
  symlinkSync(join(root, 'user@host.123'), join(root, '.#README.md'))
  symlinkSync(join(root, 'gone'), join(root, 's/cases/_old'))
  assert.deepEqual(discoverSuites([root]).map(x => x.name), ['s'])
})

test('a prompt_file or subject reaching the answers through a symlink, a case variant or another case.yaml is refused', () => {
  const answers = { ...suite('s'), 's/cases/c/truth.yaml': 'kind: clean\n', 's/cases/c/fix/b.patch': 'ANSWER' }
  const viaLink = tree({ ...answers, 's/cases/d/case.yaml': 'name: d\nexecutor: { kind: model, prompt_file: p.md }\ngraders: [{ kind: regex, pattern: x }]\n' })
  symlinkSync('../c/truth.yaml', join(viaLink, 's/cases/d/p.md'))
  assert.throws(() => discoverSuites([viaLink]), /is a case's ground truth/)

  const viaDirLink = tree({ ...answers, 's/cases/d/case.yaml': 'name: d\nexecutor: { kind: model, prompt_file: answers/b.patch }\ngraders: [{ kind: regex, pattern: x }]\n' })
  symlinkSync('../c/fix', join(viaDirLink, 's/cases/d/answers'))
  assert.throws(() => discoverSuites([viaDirLink]), /is a case's ground truth/)

  // On a case-insensitive filesystem the real path carries the on-disk case; elsewhere the variant simply does not exist.
  const variant = tree({ ...answers, 's/cases/d/case.yaml': 'name: d\nexecutor: { kind: model, prompt_file: ../c/TRUTH.yaml }\ngraders: [{ kind: regex, pattern: x }]\n' })
  assert.throws(() => discoverSuites([variant]), configError(/is a case's ground truth|not found/))

  const graders = tree({ ...answers, 's/cases/d/case.yaml': 'name: d\nsubject: ../c/case.yaml\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: regex, pattern: x }]\n' })
  assert.throws(() => discoverSuites([graders]), /subject .*case\.yaml is a case's ground truth/)
})

test('a directory hash ignores .git in either form and .DS_Store, and sees the executable bit', () => {
  const harness = 'name: c\nsubject: ../../plugin\nexecutor: { kind: harness, harness: claude-code, prompt: /review }\ngraders: [{ kind: regex, pattern: x }]\n'
  const hashOf = (files: Record<string, string>, after?: (root: string) => void) => {
    const root = tree({ ...suite('s'), 's/cases/c/case.yaml': harness, ...files })
    after?.(root)
    return discoverSuites([root])[0]!.cases[0]!.subject?.hash
  }
  const base = hashOf({ 's/plugin/hook.sh': 'echo hi' })
  assert.equal(hashOf({ 's/plugin/hook.sh': 'echo hi', 's/plugin/.git': 'gitdir: /somewhere/.git/worktrees/a' }), base)
  assert.equal(hashOf({ 's/plugin/hook.sh': 'echo hi', 's/plugin/.DS_Store': 'finder' }), base)
  assert.notEqual(hashOf({ 's/plugin/hook.sh': 'echo hi' }, r => chmodSync(join(r, 's/plugin/hook.sh'), 0o755)), base)
})

test('an unknown built-in schema or judge name is refused at load, before any trial is paid for', () => {
  const schema = tree({ ...suite('s'), 's/cases/c/case.yaml': 'name: c\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: json-schema, artifact: out.json, schema: "litmus:finding" }]\n' })
  assert.throws(() => discoverSuites([schema]), /unknown built-in schema "litmus:finding" \(known: litmus:findings\)/)

  const project = (graders: string, extra = '') => {
    const root = tree({
      'litmus.config.yaml': 'suites: [./suites]\nconfigs: { f: { provider: fake } }\njudges: { default: { provider: fake } }\n',
      'suites/s/suite.yaml': 'name: s\n',
      'suites/s/cases/c/case.yaml': `name: c\nexecutor: { kind: model, prompt: hi }\ngraders: [${graders}]\n${extra}`,
      'suites/s/cases/c/truth.yaml': 'kind: clean\n',
    })
    return join(root, 'litmus.config.yaml')
  }
  assert.doesNotThrow(() => loadProject(project('{ kind: judge, judge: default, question: q }', 'extract: { with: default }\n'), {}))
  for (const [graders, extra] of [
    ['{ kind: judge, judge: nope, question: q }', ''],
    ['{ kind: review-match, confirm: nope }', ''],
    ['{ kind: regex, pattern: x }', 'extract: { with: nope }\n'],
  ] as const) {
    assert.throws(() => loadProject(project(graders, extra), {}), configError(/judge "nope" is not defined .* \(defined: default\)/), graders + extra)
  }
})
