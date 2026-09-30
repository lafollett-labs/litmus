import { spawnSync } from 'node:child_process'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { redactor } from '../../src/core/redact.ts'
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

test('output is redacted before it is cut, so no fragment of a key survives at the boundary', async () => {
  const key = 'sk-ant-SPLIT-ACROSS-THE-CUT-0123456789'
  // The key ends 3990 bytes from the end, so a raw 4000-byte cut lands inside it.
  const run = `printf '%s' '${key}'; head -c 3990 /dev/zero | tr '\\0' x; exit 1`
  const r = await command(spec({ kind: 'command', run }), trial(), { ...ctx(), redact: redactor([key]) })
  assert.equal(r.pass, false)
  for (let n = 6; n <= key.length; n++) assert.ok(!(r.rationale ?? '').includes(key.slice(-n)), `tail ${n}`)
})

test('a process that escaped the group with setsid does not hold the grade to its timeout', { skip: spawnSync('perl', ['-v']).status === 0 ? false : 'perl is not installed' }, async () => {
  const t0 = Date.now()
  const r = await command(spec({ kind: 'command', run: `perl -MPOSIX -e 'POSIX::setsid(); sleep 20' & sleep 1; echo started; exit 0`, timeout_s: 15 }), trial(), ctx())
  assert.equal(r.pass, true)
  assert.match(r.rationale ?? '', /started/)
  assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0}ms`)
})

test('a cancelled grade leaves no grace timer holding the process', async () => {
  const ctl = new AbortController()
  const pending = command(spec({ kind: 'command', run: 'sleep 5' }), trial(), { ...ctx(), signal: ctl.signal })
  setTimeout(() => ctl.abort(), 50)
  assert.equal((await pending).rationale, 'cancelled')
  await new Promise(ok => setTimeout(ok, 100)) // the SIGKILLed shell's exit arrives
  assert.equal(process.getActiveResourcesInfo().filter(r => r === 'Timeout').length, 0)
})
