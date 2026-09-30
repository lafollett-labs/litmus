import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { loadProject } from '../../src/suite/load.ts'
import { validate, type Problem } from '../../src/validate/validate.ts'
import { tree } from '../helpers/tmp.ts'

// One project on disk: a config, suite s, and the given cases by name. Each
// case is a map of case-relative files.
function project(cases: Record<string, Record<string, string>>, extra: Record<string, string> = {}): string {
  const files: Record<string, string> = {
    'litmus.config.yaml': 'suites: [./suites]\nredact: [LITMUS_TEST_SECRET]\nconfigs: { fake: { provider: fake } }\n',
    'suites/s/suite.yaml': 'name: s\n',
    ...extra,
  }
  for (const [name, fs] of Object.entries(cases)) for (const [k, v] of Object.entries(fs)) files[`suites/s/cases/${name}/${k}`] = v
  return join(tree(files), 'litmus.config.yaml')
}

async function check(configFile: string, o: Parameters<typeof validate>[2] = {}): Promise<Problem[]> {
  const { config, suites } = loadProject(configFile, {})
  const base = join(realpathSync(tree({ '.keep': '' })), 'wd')
  mkdirSync(base)
  const problems = await validate(config, suites.flatMap(s => s.cases), { env: {}, workBase: base, ...o })
  assert.deepEqual(readdirSync(join(base, 'litmus')), [], 'every copy, and the run\'s directory, is removed')
  return problems
}

const REVIEW = 'executor: { kind: model, prompt: hi }\ngraders: [{ kind: review-match, pass: { min_recall: 1 } }]\n'
const FIX = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-broken\n+fixed\n'
// A seeded case whose one bug is "a.txt says broken": the proof greps for the fix.
function seeded(name: string, bug: { proof?: string; fix?: string } = {}, files: Record<string, string> = {}): Record<string, string> {
  const proof = bug.proof ?? 'grep -qx fixed a.txt'
  return {
    'case.yaml': `name: ${name}\n${REVIEW}`,
    'fixture/a.txt': 'broken\n',
    'truth.yaml': `kind: seeded\nbugs:\n  - { id: b1, file: a.txt, lines: [1, 1], severity: high, category: correctness, summary: s, proof: ${JSON.stringify(proof)}, fix: ${bug.fix ?? 'fix/b1.patch'} }\n`,
    'fix/b1.patch': FIX,
    ...files,
  }
}
const only = (ps: Problem[], c: string) => ps.filter(p => p.case === c).map(p => `${p.level}: ${p.message}`)

test('a proof that fails on the change and passes with the fix is valid, with proof/ overlaid on the copy', async () => {
  const ps = await check(project({ plain: seeded('plain'), overlaid: seeded('overlaid', { proof: 'sh check.sh' }, { 'proof/check.sh': 'grep -qx fixed a.txt\n' }) }))
  assert.deepEqual(ps, [])
})

test('a proof that proves nothing, one the fix does not cure, and a fix that does not apply are each an error', async () => {
  const ps = await check(
    project({
      nothing: seeded('nothing', { proof: 'true' }),
      uncured: seeded('uncured', { proof: 'grep -qx other a.txt' }),
      unapplied: seeded('unapplied', {}, { 'fix/b1.patch': FIX.replace('-broken', '-something else') }),
    }),
  )
  assert.match(only(ps, 's/nothing').join('\n'), /^error: bug b1: its proof passes before the fix, so it proves nothing: true$/)
  assert.match(only(ps, 's/uncured').join('\n'), /^error: bug b1: its proof still fails with the fix applied: grep -qx other a\.txt/)
  assert.match(only(ps, 's/unapplied').join('\n'), /^error: bug b1: .*fix fix\/b1\.patch does not apply after change\.patch/)
})

test('a fix outside the case, a proof file that shadows the fixture, and a proof that hangs are errors', async () => {
  const ps = await check(
    project(
      {
        outside: seeded('outside', { fix: '../../shared.patch' }),
        shadow: seeded('shadow', {}, { 'proof/a.txt': 'fixed\n' }),
        hangs: seeded('hangs', { proof: 'sleep 30' }),
      },
      { 'suites/s/shared.patch': FIX },
    ),
    { proofTimeoutS: 1 },
  )
  assert.match(only(ps, 's/outside').join('\n'), /fix \.\.\/\.\.\/shared\.patch lies outside the case/)
  assert.match(only(ps, 's/shadow').join('\n'), /proof\/a\.txt also exists in the fixture \(after change\.patch\); a proof may only add files/)
  assert.match(only(ps, 's/hangs').join('\n'), /its proof timed out before the fix \(1s\): sleep 30/)
})

test('a proof\'s output is redacted before it is reported', async () => {
  process.env['LITMUS_TEST_SECRET'] = 'sk-validate-secret-9'
  try {
    const { config, suites } = loadProject(project({ leaks: seeded('leaks', { proof: 'echo sk-validate-secret-9; exit 1' }) }), process.env)
    const base = join(realpathSync(tree({ '.keep': '' })), 'wd')
    mkdirSync(base)
    const ps = await validate(config, suites.flatMap(s => s.cases), { workBase: base })
    const text = only(ps, 's/leaks').join('\n')
    assert.match(text, /still fails with the fix applied/)
    assert.doesNotMatch(text, /sk-validate-secret-9/)
    assert.match(text, /\[REDACTED\]/)
  } finally {
    delete process.env['LITMUS_TEST_SECRET']
  }
})

test('a symlink in the fixture is an error, and warnings name a rate policy that cannot pass and a bound a clean case never defines', async () => {
  const configFile = project({
    rate: { 'case.yaml': 'name: rate\ntrials: 2\npolicy: rate\nthreshold: 0.9\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: regex, target: response.txt, pattern: x }]\n' },
    clean: { 'case.yaml': 'name: clean\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: review-match, pass: { min_recall: 0.5, max_false_positives: 0 } }]\n', 'truth.yaml': 'kind: clean\n', 'fixture/a.txt': 'x\n' },
    linked: { 'case.yaml': 'name: linked\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: regex, target: response.txt, pattern: x }]\n', 'fixture/a.txt': 'x\n' },
  })
  const linked = join(configFile, '../suites/s/cases/linked/fixture/escape')
  const r = spawnSync('ln', ['-s', '/etc/hosts', linked])
  assert.equal(r.status, 0)
  const ps = await check(configFile)
  assert.match(only(ps, 's/rate').join('\n'), /^warn: policy rate with threshold 0\.9 needs at least \d+ unbroken passes to return PASS; the case runs 2 trials/)
  assert.deepEqual(only(ps, 's/clean'), ['warn: review-match sets min_recall, which is never defined on a clean case (it has no bugs), so it never applies'])
  assert.match(only(ps, 's/linked').join('\n'), /^error: .*fixture contains a symlink/)
})

test('a harness case gets the checks a run makes before the SDK loads: hooks need allow_hooks, and a suite may not sit inside a plugin', async () => {
  const harness = (plugin: string, extra = '') => ({
    'case.yaml': `name: h\nexecutor:\n  kind: harness\n  harness: claude-code\n  prompt: /review\n  plugins: [${plugin}]\n${extra}graders: [{ kind: regex, target: response.txt, pattern: x }]\n`,
    'fixture/a.txt': 'x\n',
  })
  const outside = tree({ 'hooks/hooks.json': '{}', '.claude-plugin/plugin.json': '{"name":"p"}' })
  const hooked = await check(project({ h: harness(outside) }))
  assert.match(only(hooked, 's/h').join('\n'), /^error: .*has hooks\/hooks\.json; set allow_hooks: true/)
  assert.deepEqual(await check(project({ h: harness(outside, '  allow_hooks: true\n') })), [])
  // The plugin holds the whole project, suites and all.
  const configFile = project({ h: harness('../../../..') }, { '.claude-plugin/plugin.json': '{"name":"p"}' })
  assert.match(only(await check(configFile), 's/h').join('\n'), /contains .*, which the plugin loader could read before the gate runs/)
  // A subject directory that holds the suites: the harness may read its subject, and so every case's truth.
  const subject = project({ h: { ...harness(outside, '  allow_hooks: true\n'), 'case.yaml': harness(outside, '  allow_hooks: true\n')['case.yaml'].replace('graders:', 'subject: ../../../..\ngraders:') } })
  assert.match(only(await check(subject), 's/h').join('\n'), /suite root .* lies inside .*, which the harness may read; move one out of the other/)
})

test('validate never writes to the suite, and proofs: false skips the proof runs', async () => {
  const configFile = project({ plain: seeded('plain'), nothing: seeded('nothing', { proof: 'true' }) })
  const suite = join(configFile, '../suites')
  const snapshot = () => {
    const out: string[] = []
    const walk = (d: string) => {
      for (const n of readdirSync(d).sort()) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) walk(p)
        else out.push(`${relative(suite, p)} ${statSync(p).mode} ${readFileSync(p, 'utf8')}`)
      }
    }
    walk(suite)
    return out
  }
  const before = snapshot()
  assert.equal((await check(configFile)).length, 1)
  assert.deepEqual(snapshot(), before)
  assert.deepEqual(await check(configFile, { proofs: false }), [])
})

test('litmus validate prints each case, exits 1 when any is invalid and 0 when only warnings remain', () => {
  const MAIN = join(import.meta.dirname, '../../src/cli/main.ts')
  const run = (configFile: string) => spawnSync(process.execPath, [MAIN, 'validate', '--config-file', configFile], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
  const bad = run(project({ plain: seeded('plain'), nothing: seeded('nothing', { proof: 'true' }) }))
  assert.equal(bad.status, 1, bad.stderr)
  assert.match(bad.stdout, /✗ s\/nothing\n    error  bug b1: its proof passes before the fix/)
  assert.match(bad.stdout, /✓ s\/plain\s+ok/)
  assert.match(bad.stdout, /2 cases: 1 invalid, 0 warnings\n$/)
  const warned = run(project({ rate: { 'case.yaml': 'name: rate\ntrials: 2\npolicy: rate\nthreshold: 0.9\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: regex, target: response.txt, pattern: x }]\n' } }))
  assert.equal(warned.status, 0, warned.stderr)
  assert.match(warned.stdout, /1 case: 0 invalid, 1 warning\n$/)
})
