import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { planRun } from '../../src/runner/plan.ts'
import { run } from '../../src/runner/run.ts'
import { tree } from '../helpers/tmp.ts'

// planRun refuses before the run what every trial of a (case, config) pair
// would fail on, and only that: a run that can start must still be planned.
const CONFIG = `suites: [./suites]
results: ./.litmus/runs
configs:
  fake: { provider: fake }
  anth: { provider: anthropic, model: claude-sonnet-5 }
  br: { provider: bedrock, model: anthropic.claude-sonnet-5 }
  br-here: { provider: bedrock, model: anthropic.claude-sonnet-5, region: us-east-1 }
judges:
  jb: { provider: bedrock, model: anthropic.claude-sonnet-5 }
`
const GRADE = 'graders: [{ kind: regex, target: response.txt, pattern: x }]\ntrials: 1\n'
const root = tree({
  'litmus.config.yaml': CONFIG,
  'suites/s/suite.yaml': 'name: s\n',
  'suites/s/cases/m/case.yaml': `name: m\nexecutor: { kind: model, prompt: hi }\n${GRADE}`,
  'suites/s/cases/m/fake.yaml': 'responses: [{ text: nope }]\n',
  'suites/s/cases/h/case.yaml': `name: h\nexecutor: { kind: harness, harness: claude-code, prompt: go }\n${GRADE}`,
  'suites/s/cases/h/fixture/a.txt': 'x\n',
  'suites/s/cases/judged/case.yaml': 'name: judged\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: judge, judge: jb, question: "Is it good?", target: response.txt }]\ntrials: 1\n',
})
const file = join(root, 'litmus.config.yaml')
const plan = (selectors: string[], configs: string[], env: NodeJS.ProcessEnv = {}) => planRun(file, { selectors, configs }, undefined, env).kind
const refused = (selectors: string[], configs: string[], env: NodeJS.ProcessEnv, why: RegExp) => assert.throws(() => planRun(file, { selectors, configs }, undefined, env), why)

test('a bedrock config runs with a region from the config, AWS_REGION or AWS_DEFAULT_REGION, and is refused with none', () => {
  assert.equal(plan(['s/m'], ['br-here']), 'run')
  assert.equal(plan(['s/m'], ['br'], { AWS_REGION: 'us-east-1' }), 'run')
  assert.equal(plan(['s/m'], ['br'], { AWS_DEFAULT_REGION: 'us-east-1' }), 'run')
  assert.equal(plan(['s/m'], ['br'], { AWS_REGION: '', AWS_DEFAULT_REGION: 'us-east-1' }), 'run')
  refused(['s/m'], ['br'], { AWS_REGION: '' }, /config "br" is on bedrock with no region/)
})

test('a harness case runs on anthropic or bedrock, and is refused on any other provider', () => {
  assert.equal(plan(['s/h'], ['anth']), 'run')
  assert.equal(plan(['s/h'], ['br-here']), 'run')
  refused(['s/h'], ['fake'], {}, /s\/h is a harness case, which cannot run on config "fake" \(provider fake\)/)
})

test('only the pairs the run would run are checked: a trial key pins its own config', () => {
  // The harness case runs only on anth, and the regionless br only by name.
  assert.equal(plan(['s/h@anth#1', 's/m@fake#1'], ['anth', 'fake', 'br']), 'run')
  refused(['s/h@anth#1', 's/h@fake#1'], ['anth', 'fake'], {}, /cannot run on config "fake"/)
  refused(['s/m@br#1'], ['br', 'fake'], {}, /config "br" is on bedrock with no region/)
  // A key on a config the run does not use says that, not what is wrong with the config.
  refused(['s/m@br#1'], ['fake'], {}, /trial s\/m@br#1 names config "br", which this run does not use/)
  refused(['s/h@fake#1'], ['anth'], {}, /trial s\/h@fake#1 names config "fake", which this run does not use/)
})

test('a rerun is checked on the pairs it reruns: a regionless config it only named does not stop it', async () => {
  const first = planRun(file, { selectors: ['s/m'], configs: ['fake'] }, undefined, {})
  assert.equal(first.kind, 'run')
  const r = await run({ ...(first as Extract<typeof first, { kind: 'run' }>).options, env: {}, backoffMs: () => 0, workBase: join(root, 'wd') })
  // As if the stored run had also used the regionless br: its only FAIL is on fake.
  const manifest = join(root, '.litmus/runs', r.id, 'run.json')
  const json = JSON.parse(readFileSync(manifest, 'utf8'))
  json.configs.br = { provider: 'bedrock', model: 'anthropic.claude-sonnet-5' }
  writeFileSync(manifest, JSON.stringify(json))
  assert.deepEqual(r.verdicts.map(v => [v.case, v.config, v.verdict]), [['s/m', 'fake', 'FAIL']])
  assert.equal(planRun(file, { selectors: [], rerun: { run: r.id, only: ['FAIL'] } }, undefined, {}).kind, 'run')
})

test('a bedrock judge a selected case calls needs a region too; one no selected case calls does not', () => {
  refused(['s/judged'], ['fake'], {}, /judge "jb" is on bedrock with no region/)
  assert.equal(plan(['s/judged'], ['fake'], { AWS_REGION: 'us-east-1' }), 'run')
  assert.equal(plan(['s/m'], ['fake']), 'run')
})
