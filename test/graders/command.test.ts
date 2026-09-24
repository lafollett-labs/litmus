import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { command } from '../../src/graders/command.ts'
import { ctx, spec, trial } from '../helpers/grading.ts'

const saved = { ...process.env }
before(() => {
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-must-not-leak'
  process.env['AWS_SECRET_ACCESS_KEY'] = 'aws-must-not-leak'
})
after(() => {
  process.env = saved
})

test('exit 0 in the workdir passes, and the output tail is the rationale', async () => {
  const t = trial({ workdir: { 'go.mod': 'module x\n' } })
  const r = await command(spec({ kind: 'command', run: 'test -f go.mod && echo "tests ok"' }), t, ctx())
  assert.equal(r.pass, true)
  assert.match(r.rationale ?? '', /tests ok/)
})

test('a non-zero exit fails, with stderr in the rationale', async () => {
  const r = await command(spec({ kind: 'command', run: 'echo "FAIL TestExpiry" >&2; exit 3' }), trial(), ctx())
  assert.equal(r.pass, false)
  assert.match(r.rationale ?? '', /^exit 3\nFAIL TestExpiry$/)
})

test('the command sees no credentials, and HOME is the trial home', async () => {
  const t = trial()
  const run = `[ -z "$ANTHROPIC_API_KEY" ] && [ -z "$AWS_SECRET_ACCESS_KEY" ] && [ "$HOME" = "${t.home}" ] || { env; exit 1; }`
  const r = await command(spec({ kind: 'command', run }), t, ctx())
  assert.equal(r.pass, true, r.rationale ?? '')
})

test('the rationale keeps only the tail of a long output', async () => {
  const r = await command(spec({ kind: 'command', run: 'i=0; while [ $i -lt 2000 ]; do echo "line $i"; i=$((i+1)); done; exit 1' }), trial(), ctx())
  assert.equal(r.pass, false)
  assert.match(r.rationale ?? '', /line 1999$/)
  assert.doesNotMatch(r.rationale ?? '', /line 0\n/)
  assert.ok((r.rationale ?? '').length < 4100)
})

test('canary: a command that times out fails, and its background children do not hold grading open', async () => {
  const started = Date.now()
  const r = await command(spec({ kind: 'command', run: 'sleep 30 & sleep 30', timeout_s: 1 }), trial(), ctx())
  assert.equal(r.pass, false)
  assert.match(r.rationale ?? '', /^timeout after 1s/)
  assert.ok(Date.now() - started < 5000)
})

test('a cancel stops the command and never passes', async () => {
  const ctl = new AbortController()
  setTimeout(() => ctl.abort(), 50)
  const r = await command(spec({ kind: 'command', run: 'sleep 30' }), trial(), ctx(undefined, {}, ctl.signal))
  assert.equal(r.pass, false)
  assert.equal(r.rationale, 'cancelled')
})

test('a workdir that is gone fails the grade instead of throwing', async () => {
  const t = { ...trial(), workdir: '/nonexistent/litmus-workdir' }
  const r = await command(spec({ kind: 'command', run: 'true' }), t, ctx())
  assert.equal(r.pass, false)
  assert.match(r.rationale ?? '', /could not run/)
})
