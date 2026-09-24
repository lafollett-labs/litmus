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

test('compare gets its documented defaults, and out-of-range values are refused', () => {
  const base = { suites: ['./s'], configs: { fake: { provider: 'fake' } } }
  const c = ConfigFile.parse(base)
  assert.deepEqual(c.compare, { tolerance: 0.05, resamples: 2000, seed: 1, warn_ratio: 1.5 })
  assert.deepEqual(c.redact, [])
  assert.equal(ConfigFile.parse({ ...base, compare: { tolerance: 0 } }).compare.tolerance, 0)
  const bad = [{ tolerance: 1 }, { tolerance: -0.1 }, { resamples: 99 }, { resamples: 150.5 }, { seed: 1.5 }, { warn_ratio: 1 }, { tolerence: 0.1 }]
  for (const compare of bad) assert.equal(ConfigFile.safeParse({ ...base, compare }).success, false, JSON.stringify(compare))
  assert.equal(ConfigFile.safeParse({ ...base, redact: ['not a var'] }).success, false)
})

test('a judge is held to the same per-provider shape as a config', () => {
  const judge = (j: Record<string, unknown>) => ConfigFile.safeParse({ suites: ['./s'], configs: { f: { provider: 'fake' } }, judges: { j } }).success
  assert.equal(judge({ provider: 'anthropic', model: 'claude-haiku-4-5' }), true)
  assert.equal(judge({ provider: 'bedrock', model: 'm', region: 'us-east-1' }), true)
  assert.equal(judge({ provider: 'anthropic', model: 'm', region: 'us-east-1' }), false)
  assert.equal(judge({ provider: 'fake', effort: 'max' }), false)
  assert.equal(judge({ provider: 'anthropic' }), false)
})

test('findings from a model may carry extra keys, but not miss or mistype required ones', () => {
  const f = { file: 'a.go', line: 3, severity: 'high', title: 't', explanation: 'e' }
  assert.equal(Findings.safeParse({ summary: 'two issues', findings: [{ ...f, confidence: 0.9 }] }).success, true)
  assert.equal(Findings.safeParse({ findings: [{ ...f, severity: 'urgent' }] }).success, false)
  const { title: _, ...untitled } = f
  assert.equal(Findings.safeParse({ findings: [untitled] }).success, false)
})

test('effort accepts xhigh', () => {
  const c = ConfigFile.parse({ suites: ['./s'], configs: { a: { provider: 'anthropic', model: 'm', effort: 'xhigh' } } })
  assert.equal(c.configs.a?.provider === 'anthropic' && c.configs.a.effort, 'xhigh')
})

test('a rate threshold is inside (0, 1): 1 could never pass a Wilson lower bound', () => {
  for (const threshold of [0, 1, 1.2]) assert.equal(SuiteFile.safeParse({ name: 's', defaults: { threshold } }).success, false, String(threshold))
  assert.equal(SuiteFile.parse({ name: 's', defaults: { threshold: 0.95 } }).defaults.threshold, 0.95)
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
  assert.equal(c.executor.allow_hooks, false)
  assert.deepEqual(c.executor.setting_sources, [])
  assert.deepEqual(c.executor.plugins, [])
})

test('a harness may load the fixture project settings, but never the operator user or local settings', () => {
  const harness = (setting_sources: string[]) =>
    CaseFile.safeParse({ ...modelCase, executor: { kind: 'harness', harness: 'claude-code', prompt: '/review', setting_sources } }).success
  assert.equal(harness(['project']), true)
  assert.equal(harness(['user']), false)
  assert.equal(harness(['local']), false)
  assert.equal(harness(['project', 'user']), false)
})

test('a case with no graders, an unknown grader kind, or an unknown harness is rejected', () => {
  assert.equal(CaseFile.safeParse({ ...modelCase, graders: [] }).success, false)
  assert.equal(CaseFile.safeParse({ ...modelCase, graders: [{ kind: 'vibes' }] }).success, false)
  assert.equal(
    CaseFile.safeParse({ ...modelCase, executor: { kind: 'harness', harness: 'codex', prompt: 'x' } }).success,
    false,
  )
})

test('extract defaults to the final message into findings.json, and needs a named extractor', () => {
  const c = CaseFile.parse({ ...modelCase, extract: { with: 'default' } })
  assert.deepEqual(c.extract, { from: 'final_message', to: 'findings.json', with: 'default' })
  assert.equal(CaseFile.safeParse({ ...modelCase, extract: {} }).success, false)
  assert.equal(CaseFile.safeParse({ ...modelCase, extract: { with: 'default', into: 'x.json' } }).success, false)
})

test('a count bound that can never pass, or a regex that does not compile, is refused at load', () => {
  const ok = (g: Record<string, unknown>) => CaseFile.safeParse({ ...modelCase, graders: [g] }).success
  assert.equal(ok({ kind: 'tool-used', tool: 'Agent', max: 0 }), false) // min defaults to 1
  assert.equal(ok({ kind: 'tool-used', tool: 'Agent', min: 0, max: 0 }), true)
  assert.equal(ok({ kind: 'regex', pattern: 'x', min: 3, max: 2 }), false)
  assert.equal(ok({ kind: 'regex', pattern: '(' }), false)
  assert.equal(ok({ kind: 'regex', pattern: 'x', flags: 'q' }), false)
})

test('review-match accepts every documented pass bound, and min_claims_correct only with a confirming judge', () => {
  const pass = { min_recall: 1, max_false_positives: 1, max_decoy_hits: 0, max_duplicates: 0, max_nits: 5, max_findings: 20, min_claims_correct: 0.8 }
  assert.equal(CaseFile.safeParse({ ...modelCase, graders: [{ kind: 'review-match', pass, confirm: 'default' }] }).success, true)
  assert.equal(CaseFile.safeParse({ ...modelCase, graders: [{ kind: 'review-match', pass }] }).success, false)
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
