import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ConfigError, InfraError } from '../../src/core/errors.ts'
import { hashJson } from '../../src/core/hash.ts'
import { EXTRACT_PROMPT_VERSION } from '../../src/graders/judges.ts'
import { runExtract } from '../../src/graders/extract.ts'
import { jsonSchema } from '../../src/graders/json-schema.ts'
import type { Provider } from '../../src/providers/index.ts'
import { oneCase } from '../helpers/cases.ts'
import { ctx, judgeOf, spec, stub, trial } from '../helpers/grading.ts'

const EXTRACTING = (extract = '{ from: final_message, to: findings.json, with: default }') =>
  oneCase(`name: c\nexecutor: { kind: model, prompt: hi }\nextract: ${extract}\ngraders: [{ kind: json-schema, artifact: findings.json, schema: litmus:findings }]\n`).c

const findings = { findings: [{ file: 'a.go', line: 41, end_line: 44, severity: 'high', title: 'Expiry off by one', explanation: '>= should be >' }] }
const fenced = (v: unknown) => `Here you go:\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``
const review = 'a.go:41-44 is wrong: the expiry check uses >= where > belongs. High severity.'

function run(provider: Provider, artifacts: Record<string, string>, c = EXTRACTING()) {
  const t = trial({ artifacts })
  return { t, out: runExtract(t, ctx(c, { default: judgeOf(provider) })) }
}

test('the final message becomes findings.json beside the other artifacts, with a pinned hash', async () => {
  const p = stub([fenced(findings)])
  const { t, out } = run(p, { 'final_message.txt': review })
  const { trial: after, extractor_hash } = await out
  const path = after.artifacts['findings.json']!
  assert.equal(dirname(path), dirname(t.artifacts['final_message.txt']!))
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), findings)
  assert.equal(extractor_hash, hashJson({ judge: 'hash-of-default', prompt_version: EXTRACT_PROMPT_VERSION }))
  assert.match(p.calls[0]?.system ?? '', /litmus:findings/)
  assert.match(p.calls[0]?.messages[0]?.content ?? '', /<review source="subject">\na\.go:41-44 is wrong/)
})

test('final_message falls back to response.txt, and from can name any artifact', async () => {
  const model = await run(stub([fenced(findings)]), { 'response.txt': review }).out
  assert.ok(model.trial.artifacts['findings.json'])
  const named = await run(stub([fenced(findings)]), { 'notes/review.md': review }, EXTRACTING('{ from: notes/review.md, to: out/findings.json, with: default }')).out
  const path = named.trial.artifacts['out/findings.json']!
  assert.match(path, /\/artifacts\/out\/findings\.json$/) // artifacts/, not artifacts/notes/
})

test('a case without extract is returned untouched, with no hash and no call', async () => {
  const p = stub([])
  const t = trial({ artifacts: { 'final_message.txt': review } })
  const r = await runExtract(t, ctx(oneCase('name: c\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: regex, pattern: x }]\n').c, { default: judgeOf(p) }))
  assert.equal(r.trial, t)
  assert.equal(r.extractor_hash, undefined)
  assert.equal(p.calls.length, 0)
})

test('canary: an unparseable or invalid extraction writes nothing, and the graders then fail', async () => {
  for (const reply of ['I could not find any structured findings.', fenced({ findings: [{ ...findings.findings[0], severity: 'nit' }] }), fenced([])]) {
    const { t, out } = run(stub([reply]), { 'final_message.txt': review })
    const r = await out
    assert.equal(r.trial.artifacts['findings.json'], undefined, reply)
    assert.equal(existsSync(join(dirname(t.artifacts['final_message.txt']!), 'findings.json')), false)
    assert.ok(r.extractor_hash)
    const g = await jsonSchema(spec({ kind: 'json-schema', artifact: 'findings.json', schema: 'litmus:findings' }), r.trial, ctx())
    assert.equal(g.pass, false)
  }
})

test('canary: a findings.json already there does not stand in for a failed extraction', async () => {
  const r = await run(stub(['no json here']), { 'final_message.txt': review, 'findings.json': JSON.stringify({ findings: [] }) }).out
  assert.equal(r.trial.artifacts['findings.json'], undefined)
  assert.ok(r.trial.artifacts['final_message.txt'])
})

test('with no source to extract from, the model is not called', async () => {
  const p = stub([])
  const r = await run(p, {}).out
  assert.equal(p.calls.length, 0)
  assert.equal(r.trial.artifacts['findings.json'], undefined)
})

test('without an artifact that names its own path, the output goes to artifacts/ beside the transcript', async () => {
  const t = trial()
  const elsewhere = join(dirname(t.transcript), 'msg')
  writeFileSync(elsewhere, review)
  const moved = { ...t, artifacts: { 'final_message.txt': elsewhere } }
  const r = await runExtract(moved, ctx(EXTRACTING(), { default: judgeOf(stub([fenced(findings)])) }))
  assert.equal(r.trial.artifacts['findings.json'], join(dirname(t.transcript), 'artifacts', 'findings.json'))
})

test('a provider failure propagates, and a `to` outside the artifacts dir is a config error', async () => {
  await assert.rejects(run(stub([new InfraError('429')]), { 'final_message.txt': review }).out, InfraError)
  const escaping = EXTRACTING('{ from: final_message, to: ../findings.json, with: default }')
  await assert.rejects(run(stub([fenced(findings)]), { 'final_message.txt': review }, escaping).out, ConfigError)
})

test('canary: a directory the subject planted at `to` fails the extraction with a reason, never the run', async () => {
  const { out } = run(stub([fenced(findings)]), { 'final_message.txt': review, 'findings.json/evil.txt': 'x' })
  const r = await out
  assert.equal(r.trial.artifacts['findings.json'], undefined)
  assert.match(r.error ?? '', /could not write findings\.json: EISDIR/)
})

test('every extraction that yields nothing says why', async () => {
  assert.match((await run(stub(['no json here']), { 'final_message.txt': review }).out).error ?? '', /not litmus:findings: "no json here"/)
  assert.match((await run(stub([]), {}).out).error ?? '', /nothing to extract from: final_message\.txt was not produced/)
  assert.equal((await run(stub([fenced(findings)]), { 'final_message.txt': review }).out).error, undefined)
})
