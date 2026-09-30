import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
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
  assert.deepEqual(existsSync(join(base, 'litmus')) ? readdirSync(join(base, 'litmus')) : [], [], 'every copy, and the run\'s directory, is removed')
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
  // Any link in a case is refused when a run hashes the case, so validate reports that and checks no further.
  assert.deepEqual(only(ps, 's/linked'), [`error: ${join(configFile, '../suites/s/cases/linked/fixture/escape')} is a symlink; a hashed tree must hold only files and directories; a run that selects this case is refused`])
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
  // The plugin holds the whole project, suites and all: one fault, one error.
  const configFile = project({ h: harness('../../../..') }, { '.claude-plugin/plugin.json': '{"name":"p"}' })
  const held = only(await check(configFile), 's/h')
  assert.equal(held.length, 1, held.join('\n'))
  assert.match(held[0]!, /contains .*, which the plugin loader could read before the gate runs/)
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

test('a bad proof/ tree is an error for its case alone, reported even with proofs: false', async () => {
  const configFile = project({
    linked: seeded('linked', {}, { 'proof/ok.sh': 'true\n' }),
    plain: seeded('plain', {}, { proof: 'not a directory\n' }),
    dangling: seeded('dangling'),
    dotgit: seeded('dotgit', {}, { 'proof/.git/HEAD': 'ref: refs/heads/main\n' }),
    through: seeded('through', {}, { 'proof/a.txt/x': 'y\n' }),
    rooted: seeded('rooted'),
    fine: seeded('fine'),
  })
  const cases = join(configFile, '../suites/s/cases')
  symlinkSync('/etc/hosts', join(cases, 'linked/proof/hosts'))
  symlinkSync(join(cases, 'fine/fix'), join(cases, 'rooted/proof'))
  symlinkSync('/nonexistent/litmus-proof', join(cases, 'dangling/proof'))
  for (const o of [{}, { proofs: false }]) {
    const ps = await check(configFile, o)
    assert.deepEqual(only(ps, 's/linked'), [`error: ${join(cases, 'linked/proof/hosts')} is a symlink; a hashed tree must hold only files and directories; a run that selects this case is refused`])
    assert.deepEqual(only(ps, 's/through'), ['error: proof/a.txt/x runs through a.txt, a file in the fixture (after change.patch); a proof may only add files'])
    assert.deepEqual(only(ps, 's/rooted'), [`error: ${join(cases, 'rooted/proof')} is a symlink; a hashed tree must hold only files and directories; a run that selects this case is refused`])
    assert.deepEqual(only(ps, 's/dangling'), [`error: ${join(cases, 'dangling/proof')} is a symlink; a hashed tree must hold only files and directories; a run that selects this case is refused`])
    assert.deepEqual(only(ps, 's/plain'), ['error: proof is not a directory; a proof is a tree of files laid over the fixture'])
    assert.match(only(ps, 's/dotgit').join('\n'), /^error: s\/dotgit: proof\/ contains a \.git directory at /)
    assert.deepEqual(only(ps, 's/fine'), [])
  }
})

test('ground truth must name a file in the post-change tree, and lines inside it, even with proofs: false', async () => {
  const truth = (bug: string, decoy = '') => `kind: seeded\nbugs:\n  - { id: b1, ${bug}, severity: high, category: correctness, summary: s, proof: "grep -qx fixed a.txt", fix: fix/b1.patch }\n${decoy}`
  const configFile = project({
    missing: seeded('missing', {}, { 'truth.yaml': truth('file: a.go, lines: [1, 1]') }),
    past: seeded('past', {}, { 'truth.yaml': truth('file: a.txt, lines: [1, 2]') }),
    dir: seeded('dir', {}, { 'fixture/d/x': 'x\n', 'truth.yaml': truth('file: d, lines: [1, 1]') }),
    escapes: seeded('escapes', {}, { 'truth.yaml': truth('file: ../../../../../../../../../../../../../../../../../../../../etc/hosts, lines: [1, 1]') }),
    decoy: seeded('decoy', {}, { 'truth.yaml': truth('file: a.txt, lines: [1, 1]', 'decoys:\n  - { id: d1, file: a.txt, lines: [480, 500], summary: s }\n') }),
    added: seeded('added', {}, {
      'change.patch': 'diff --git a/b.txt b/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n',
      'truth.yaml': truth('file: a.txt, lines: [1, 1]', 'decoys:\n  - { id: d1, file: b.txt, lines: [2, 2] }\n'.replace(' }', ', summary: s }')),
    }),
    slash: seeded('slash', {}, { 'truth.yaml': truth('file: a.txt/, lines: [1, 1]') }),
    through: seeded('through', {}, { 'truth.yaml': truth('file: a.txt/x, lines: [1, 1]') }),
    upper: seeded('upper', {}, { 'truth.yaml': truth('file: A.TXT, lines: [1, 1]') }),
    git: seeded('git', {}, { 'truth.yaml': truth('file: .git/HEAD, lines: [1, 1]') }),
    empty: seeded('empty', {}, { 'fixture/e.txt': '', 'truth.yaml': truth('file: a.txt, lines: [1, 1]', 'decoys:\n  - { id: d1, file: e.txt, lines: [1, 1], summary: s }\n') }),
    dotted: seeded('dotted', {}, { 'truth.yaml': truth('file: ./a.txt, lines: [1, 1]') }),
    fine: seeded('fine'),
  })
  for (const o of [{}, { proofs: false }]) {
    const ps = await check(configFile, o)
    for (const [c, file] of [['slash', 'a.txt/'], ['through', 'a.txt/x'], ['upper', 'A.TXT'], ['git', '.git/HEAD']] as const) {
      assert.deepEqual(only(ps, `s/${c}`), [`error: bug b1: ${file} is not a file in the fixture (after change.patch)`], c)
    }
    assert.deepEqual(only(ps, 's/empty'), ['error: decoy d1: lines [1, 1] run past the end of e.txt, which has 0 lines (after change.patch)'])
    assert.deepEqual(only(ps, 's/dotted'), [])
    assert.deepEqual(only(ps, 's/missing'), ['error: bug b1: a.go is not a file in the fixture (after change.patch)'])
    assert.deepEqual(only(ps, 's/past'), ['error: bug b1: lines [1, 2] run past the end of a.txt, which has 1 lines (after change.patch)'])
    assert.deepEqual(only(ps, 's/dir'), ['error: bug b1: d is not a file in the fixture (after change.patch)'])
    assert.deepEqual(only(ps, 's/escapes'), ['error: bug b1: ../../../../../../../../../../../../../../../../../../../../etc/hosts is not a file in the fixture (after change.patch)'])
    assert.deepEqual(only(ps, 's/decoy'), ['error: decoy d1: lines [480, 500] run past the end of a.txt, which has 1 lines (after change.patch)'])
    assert.deepEqual(only(ps, 's/added'), [], 'a file the change adds is in the post-change tree')
    assert.deepEqual(only(ps, 's/fine'), [])
  }
})

test('a fix that edits the proof, rather than the bug, is an error', async () => {
  const cheat = 'diff --git a/check.sh b/check.sh\n--- a/check.sh\n+++ b/check.sh\n@@ -1 +1 @@\n-grep -qx fixed a.txt\n+true\n'
  const chmod = 'diff --git a/check.sh b/check.sh\nold mode 100644\nnew mode 100755\n'
  const both = `${FIX}${cheat}`
  const ps = await check(
    project({
      cheat: seeded('cheat', { proof: 'sh check.sh' }, { 'proof/check.sh': 'grep -qx fixed a.txt\n', 'fix/b1.patch': cheat }),
      mode: seeded('mode', { proof: 'sh check.sh' }, { 'proof/check.sh': 'grep -qx fixed a.txt\n', 'fix/b1.patch': `${FIX}${chmod}` }),
      both: seeded('both', { proof: 'sh check.sh' }, { 'proof/check.sh': 'grep -qx fixed a.txt\n', 'fix/b1.patch': both }),
      fine: seeded('fine', { proof: 'sh check.sh' }, { 'proof/check.sh': 'grep -qx fixed a.txt\n' }),
    }),
  )
  for (const c of ['cheat', 'mode', 'both']) assert.deepEqual(only(ps, `s/${c}`), ["error: bug b1: fix fix/b1.patch changes proof/check.sh; a fix may change only the subject's tree, never its proof"], c)
  assert.deepEqual(only(ps, 's/fine'), [])
})

test('a proof that changes its own files during its first run does not blame an honest fix', async () => {
  const ps = await check(
    project({
      chmods: seeded('chmods', { proof: 'chmod +x run.sh && ./run.sh' }, { 'proof/run.sh': 'grep -qx fixed a.txt\n' }),
      logs: seeded('logs', { proof: 'sh run.sh' }, { 'proof/run.sh': 'echo ran >> log.txt\ngrep -qx fixed a.txt\n', 'proof/log.txt': '' }),
    }),
  )
  assert.deepEqual(ps, [])
})

test('a fix that adds to a directory only the proof made changes the proof; one that leaves the bug\'s file alone is warned of', async () => {
  const skip = 'diff --git a/t/00-skip.sh b/t/00-skip.sh\nnew file mode 100644\n--- /dev/null\n+++ b/t/00-skip.sh\n@@ -0,0 +1 @@\n+exit 0\n'
  const elsewhere = FIX.replaceAll('a.txt', 'b.txt')
  const dirToFile = 'diff --git a/t/check.sh b/t/check.sh\ndeleted file mode 100644\n--- a/t/check.sh\n+++ /dev/null\n@@ -1 +0,0 @@\n-grep -qx fixed a.txt\ndiff --git a/t b/t\nnew file mode 100644\n--- /dev/null\n+++ b/t\n@@ -0,0 +1 @@\n+x\n'
  const ps = await check(
    project({
      adds: seeded('adds', { proof: 'sh t/run.sh' }, { 'proof/t/run.sh': 'for f in t/0*.sh; do [ -f "$f" ] && . "./$f"; done\ngrep -qx fixed a.txt\n', 'fix/b1.patch': skip }),
      elsewhere: seeded('elsewhere', { proof: 'grep -qx fixed b.txt' }, { 'fixture/b.txt': 'broken\n', 'fix/b1.patch': elsewhere }),
      todir: seeded('todir', { proof: 'test -f t || sh t/check.sh' }, { 'proof/t/check.sh': 'grep -qx fixed a.txt\n', 'fix/b1.patch': `${FIX}${dirToFile}` }),
      fine: seeded('fine'),
    }),
  )
  assert.deepEqual(only(ps, 's/todir'), ["error: bug b1: fix fix/b1.patch changes proof/t; a fix may change only the subject's tree, never its proof"])
  assert.deepEqual(only(ps, 's/fine'), [])
  assert.deepEqual(only(ps, 's/adds'), [
    "error: bug b1: fix fix/b1.patch changes proof/t/00-skip.sh; a fix may change only the subject's tree, never its proof",
  ])
  assert.deepEqual(only(ps, 's/elsewhere'), ["warn: bug b1: its fix leaves a.txt unchanged; a proof cured without touching the bug's file may be cured some other way"])
})

test('an unreadable proof/ directory is an error for its case alone', { skip: process.getuid?.() === 0 && 'root reads anything' }, async () => {
  const configFile = project({ locked: seeded('locked', {}, { 'proof/sub/x': 'x\n' }), fine: seeded('fine') })
  const sub = join(configFile, '../suites/s/cases/locked/proof/sub')
  chmodSync(sub, 0o000)
  try {
    const ps = await check(configFile)
    assert.match(only(ps, 's/locked').join('\n'), /^error: EACCES: permission denied, scandir '.*proof\/sub'$/)
    assert.deepEqual(only(ps, 's/fine'), [])
  } finally {
    chmodSync(sub, 0o755)
  }
})

test('a harness case\'s proof/ may add what a harness would refuse in a fixture: the harness never sees proof/', async () => {
  const harness = (extra: Record<string, string>) => ({
    ...seeded('hp', {}, extra),
    'case.yaml': `name: hp\nexecutor:\n  kind: harness\n  harness: claude-code\n  prompt: /review\n  setting_sources: [project]\ngraders: [{ kind: review-match, pass: { min_recall: 1 } }]\n`,
  })
  assert.deepEqual(await check(project({ hp: harness({ 'proof/.mcp.json': '{}', 'proof/.claude/settings.json': '{"permissions":{}}' }) }), { proofs: false }), [])
  // The same files in the fixture are refused.
  const refused = only(await check(project({ hp: harness({ 'fixture/.mcp.json': '{}' }) }), { proofs: false }), 's/hp')
  assert.match(refused.join('\n'), /the fixture has \.mcp\.json/)
})

test('a fix/ that links out of the case is refused as a link in the case', async () => {
  const configFile = project({ out: seeded('out') }, { 'elsewhere/b1.patch': FIX })
  const fixDir = join(configFile, '../suites/s/cases/out/fix')
  rmSync(join(fixDir, 'b1.patch'))
  rmSync(join(fixDir), { recursive: true })
  symlinkSync(join(configFile, '../elsewhere'), fixDir)
  assert.deepEqual(only(await check(configFile), 's/out'), [`error: ${fixDir} is a symlink; a hashed tree must hold only files and directories; a run that selects this case is refused`])
})

test('a model case\'s subject file may sit anywhere, even above the suites: nothing reads its folder', async () => {
  const configFile = project({ m: { 'case.yaml': 'name: m\nsubject: ../../../../SYSTEM.md\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: regex, target: response.txt, pattern: x }]\n' } }, { 'SYSTEM.md': 'be terse\n' })
  assert.deepEqual(await check(configFile), [])
})

test('an aborted validate kills the running proof\'s process group and leaves no copy', async () => {
  const marks = realpathSync(tree({ '.keep': '' }))
  const late = join(marks, 'late')
  // After the abort, a later case is not checked at all: its warning never comes.
  const configFile = project({
    slow: seeded('slow', { proof: `sleep 2 && touch ${late}; exit 1` }),
    zlater: { 'case.yaml': 'name: zlater\ntrials: 2\npolicy: rate\nthreshold: 0.9\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: regex, target: response.txt, pattern: x }]\n' },
  })
  const ctl = new AbortController()
  setTimeout(() => ctl.abort(), 300)
  const started = Date.now()
  assert.deepEqual(await check(configFile, { signal: ctl.signal }), [])
  assert.ok(Date.now() - started < 1_500, 'returns on the abort, not when the proof ends')
  await new Promise(r => setTimeout(r, 2_500))
  assert.equal(existsSync(late), false, 'the proof was killed, not orphaned')
})

test('litmus validate: SIGTERM cancels with 143 and kills the proof; a suite that will not load exits 1', async () => {
  const MAIN = join(import.meta.dirname, '../../src/cli/main.ts')
  const marks = realpathSync(tree({ '.keep': '' }))
  const [begun, late] = [join(marks, 'begun'), join(marks, 'late')]
  const configFile = project({ slow: seeded('slow', { proof: `touch ${begun}; sleep 2 && touch ${late}; exit 1` }) })
  const child = spawn(process.execPath, [MAIN, 'validate', '--config-file', configFile], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', d => (stderr += d))
  const exited = new Promise<number | null>(r => child.on('exit', code => r(code)))
  for (let i = 0; i < 100 && !existsSync(begun); i++) await new Promise(r => setTimeout(r, 50))
  assert.ok(existsSync(begun), 'the proof started')
  child.kill('SIGTERM')
  assert.equal(await exited, 143)
  assert.match(stderr, /validate cancelled before every case was checked/)
  await new Promise(r => setTimeout(r, 2_500))
  assert.equal(existsSync(late), false, 'the proof was killed, not orphaned')

  const broken = project({ bad: { 'case.yaml': 'name: bad\nexecutor: { kind: nope }\n' } })
  const r = spawnSync(process.execPath, [MAIN, 'validate', '--config-file', broken], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
  assert.equal(r.status, 1, r.stderr)
  assert.match(r.stdout, /invalid: the suites do not load\n$/)

  // A YAML error quotes its line: a secret there is redacted.
  const secret = 'sk-litmus-probe-7'
  const leaky = project({ bad: { 'case.yaml': `name: bad\nexecutor: { kind: model, prompt: "use ${secret} here }\n` } })
  const q = spawnSync(process.execPath, [MAIN, 'validate', '--config-file', leaky], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', LITMUS_TEST_SECRET: secret } })
  assert.equal(q.status, 1, q.stderr)
  assert.ok(!q.stdout.includes(secret), q.stdout)
  assert.match(q.stdout, /\[REDACTED\]/)
})
