import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CaseFile, ConfigFile, Findings, SuiteFile, TruthFile } from '../../src/suite/schema.ts'

const modelCase = {
  name: 'c',
  executor: { kind: 'model', prompt: 'hi' },
  graders: [{ kind: 'regex', pattern: 'x' }],
}

test('a minimal config gets its documented defaults', () => {
  const c = ConfigFile.parse({ suites: ['./s'], configs: { fake: { provider: 'fake' } } })
  assert.equal(c.results, './.litmus/runs')
  assert.equal(c.concurrency, 4)
  assert.equal(c.retries, 2)
  assert.deepEqual(c.judges, {})
})

test('a config is rejected for a missing model, an unknown provider, a typo, or no configs', () => {
  const bad = [
    { suites: ['./s'], configs: { a: { provider: 'anthropic' } } },
    { suites: ['./s'], configs: { a: { provider: 'openai', model: 'x' } } },
    { suites: ['./s'], configs: { a: { provider: 'fake' } }, concurency: 2 },
    { suites: ['./s'], configs: {} },
    { suites: [], configs: { a: { provider: 'fake' } } },
    { suites: ['./s'], configs: { 'Bad Name': { provider: 'fake' } } },
  ]
  for (const b of bad) assert.equal(ConfigFile.safeParse(b).success, false, JSON.stringify(b))
})

test('suite defaults are optional and strict', () => {
  assert.deepEqual(SuiteFile.parse({ name: 's' }).defaults, {})
  assert.equal(SuiteFile.safeParse({ name: 's', defaults: { trails: 5 } }).success, false)
})

test('a case needs exactly one of prompt and prompt_file', () => {
  assert.equal(CaseFile.safeParse(modelCase).success, true)
  const both = { ...modelCase, executor: { kind: 'model', prompt: 'a', prompt_file: 'p.md' } }
  const neither = { ...modelCase, executor: { kind: 'model' } }
  assert.equal(CaseFile.safeParse(both).success, false)
  assert.equal(CaseFile.safeParse(neither).success, false)
})

test('a harness case defaults to no shell, no network, and no settings', () => {
  const c = CaseFile.parse({ ...modelCase, executor: { kind: 'harness', harness: 'claude-code', prompt: '/review' } })
  assert.equal(c.executor.kind, 'harness')
  if (c.executor.kind !== 'harness') return
  assert.equal(c.executor.allow_shell, false)
  assert.equal(c.executor.allow_network, false)
  assert.deepEqual(c.executor.setting_sources, [])
  assert.deepEqual(c.executor.plugins, [])
})

test('a case with no graders, an unknown grader kind, or an unknown harness is rejected', () => {
  assert.equal(CaseFile.safeParse({ ...modelCase, graders: [] }).success, false)
  assert.equal(CaseFile.safeParse({ ...modelCase, graders: [{ kind: 'vibes' }] }).success, false)
  assert.equal(
    CaseFile.safeParse({ ...modelCase, executor: { kind: 'harness', harness: 'codex', prompt: 'x' } }).success,
    false,
  )
})

test('review-match gets its window and artifact defaults', () => {
  const c = CaseFile.parse({ ...modelCase, graders: [{ kind: 'review-match' }] })
  assert.deepEqual(c.graders[0], { kind: 'review-match', artifact: 'findings.json', window: 5, pass: {} })
})

const bug = {
  id: 'b',
  file: 'a.go',
  lines: [3, 4],
  severity: 'high',
  category: 'correctness',
  summary: 's',
  proof: 'go test',
  fix: 'fix/b.patch',
}

test('a seeded truth needs a bug and a clean truth must have none', () => {
  assert.equal(TruthFile.safeParse({ kind: 'seeded', bugs: [bug] }).success, true)
  assert.equal(TruthFile.safeParse({ kind: 'seeded' }).success, false)
  assert.equal(TruthFile.safeParse({ kind: 'clean' }).success, true)
  assert.equal(TruthFile.safeParse({ kind: 'clean', bugs: [bug] }).success, false)
})

test('truth rejects inverted line ranges and duplicate ids across bugs and decoys', () => {
  assert.equal(TruthFile.safeParse({ kind: 'seeded', bugs: [{ ...bug, lines: [5, 4] }] }).success, false)
  const decoy = { id: 'b', file: 'a.go', lines: [1, 1], summary: 'fine' }
  assert.equal(TruthFile.safeParse({ kind: 'seeded', bugs: [bug], decoys: [decoy] }).success, false)
})

test('findings accept a line or a range, and reject an unknown severity or an inverted range', () => {
  const f = { file: 'a.go', line: 3, severity: 'high', title: 't', explanation: 'e' }
  assert.equal(Findings.safeParse({ findings: [f, { ...f, end_line: 9 }] }).success, true)
  assert.equal(Findings.safeParse({ findings: [{ ...f, severity: 'urgent' }] }).success, false)
  assert.equal(Findings.safeParse({ findings: [{ ...f, end_line: 2 }] }).success, false)
  assert.equal(Findings.safeParse({ findings: [] }).success, true)
})
