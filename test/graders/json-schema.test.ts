import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError } from '../../src/core/errors.ts'
import { jsonSchema } from '../../src/graders/json-schema.ts'
import { oneCase } from '../helpers/cases.ts'
import { CASE, ctx, spec, trial } from '../helpers/grading.ts'

const finding = { file: 'a.go', line: 3, severity: 'high', title: 't', explanation: 'e' }
const findings = (f: unknown[]) => JSON.stringify({ findings: f })

test('findings that match litmus:findings pass, including an empty list', async () => {
  const s = spec({ kind: 'json-schema', artifact: 'findings.json', schema: 'litmus:findings' })
  assert.equal((await jsonSchema(s, trial({ artifacts: { 'findings.json': findings([finding]) } }), ctx())).pass, true)
  assert.equal((await jsonSchema(s, trial({ artifacts: { 'findings.json': findings([]) } }), ctx())).pass, true)
})

test('findings with a bad severity or a missing field fail, and say where', async () => {
  const s = spec({ kind: 'json-schema', artifact: 'findings.json', schema: 'litmus:findings' })
  const r = await jsonSchema(s, trial({ artifacts: { 'findings.json': findings([{ ...finding, severity: 'nit' }, { file: 'a.go', line: 1 }]) } }), ctx())
  assert.equal(r.pass, false)
  assert.match(r.rationale ?? '', /findings\.0\.severity/)
  assert.match(r.rationale ?? '', /findings\.1\.title/)
})

test('canary: a missing artifact, or one that is not JSON, fails and never throws', async () => {
  const s = spec({ kind: 'json-schema', artifact: 'findings.json', schema: 'litmus:findings' })
  const missing = await jsonSchema(s, trial(), ctx())
  assert.equal(missing.pass, false)
  assert.match(missing.rationale ?? '', /not produced/)
  const prose = await jsonSchema(s, trial({ artifacts: { 'findings.json': 'Looks good to me!' } }), ctx())
  assert.equal(prose.pass, false)
  assert.match(prose.rationale ?? '', /not JSON/)
})

test('a JSON Schema file is resolved from the case directory, in 2020-12 or draft-07', async () => {
  const schema = (draft: string) => JSON.stringify({ $schema: draft, type: 'object', required: ['ok'], properties: { ok: { const: true } } })
  const { c } = oneCase(CASE, {
    'schemas/new.json': schema('https://json-schema.org/draft/2020-12/schema'),
    'schemas/old.json': schema('http://json-schema.org/draft-07/schema#'),
  })
  for (const file of ['schemas/new.json', 'schemas/old.json']) {
    const s = spec({ kind: 'json-schema', artifact: 'out.json', schema: file })
    assert.equal((await jsonSchema(s, trial({ artifacts: { 'out.json': '{"ok": true}' } }), ctx(c))).pass, true, file)
    const bad = await jsonSchema(s, trial({ artifacts: { 'out.json': '{"ok": false}' } }), ctx(c))
    assert.equal(bad.pass, false, file)
    assert.match(bad.rationale ?? '', /\/ok/)
  }
})

test('a missing schema file, an unknown built-in, or an unknown format is a config error', async () => {
  const { c } = oneCase(CASE, { 'fmt.json': JSON.stringify({ type: 'string', format: 'no-such-format' }) })
  const t = trial({ artifacts: { 'out.json': '"x"' } })
  await assert.rejects(jsonSchema(spec({ kind: 'json-schema', artifact: 'out.json', schema: 'nope.json' }), t, ctx(c)), ConfigError)
  await assert.rejects(jsonSchema(spec({ kind: 'json-schema', artifact: 'out.json', schema: 'litmus:verdicts' }), t, ctx(c)), ConfigError)
  await assert.rejects(jsonSchema(spec({ kind: 'json-schema', artifact: 'out.json', schema: 'fmt.json' }), t, ctx(c)), ConfigError)
})
