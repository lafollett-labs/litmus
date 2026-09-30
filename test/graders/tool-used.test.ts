import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TranscriptEntry } from '../../src/core/types.ts'
import { toolUsed } from '../../src/graders/tool-used.ts'
import { ctx, spec, trial } from '../helpers/grading.ts'

const call = (tool: string, id: string): TranscriptEntry => ({ t: 0, kind: 'tool_call', id, tool, input: {} })
const fanOut = [call('Agent', '1'), call('Read', '2'), call('Agent', '3'), call('Agent', '4'), { t: 1, kind: 'denied', tool: 'Agent', reason: 'x' } as TranscriptEntry]

test('a tool called at least once passes by default', async () => {
  const r = await toolUsed(spec({ kind: 'tool-used', tool: 'Read' }), trial({ transcript: fanOut }), ctx())
  assert.equal(r.pass, true)
  assert.equal(r.metrics?.['calls'], 1)
})

test('only tool_call entries count, and max caps the fan-out', async () => {
  const t = trial({ transcript: fanOut })
  const capped = await toolUsed(spec({ kind: 'tool-used', tool: 'Agent', min: 0, max: 2 }), t, ctx())
  assert.equal(capped.pass, false)
  assert.equal(capped.metrics?.['calls'], 3) // the denied entry is not a second count of a call
  assert.equal((await toolUsed(spec({ kind: 'tool-used', tool: 'Agent', max: 3 }), t, ctx())).pass, true)
})

test('a tool never called fails the default bound, and names the exact tool', async () => {
  const r = await toolUsed(spec({ kind: 'tool-used', tool: 'Write' }), trial({ transcript: fanOut }), ctx())
  assert.equal(r.pass, false)
  assert.match(r.rationale ?? '', /Write was called 0 time/)
})

test('canary: a missing transcript fails even under a bound that allows zero calls', async () => {
  const r = await toolUsed(spec({ kind: 'tool-used', tool: 'Agent', min: 0, max: 5 }), trial({ transcript: null }), ctx())
  assert.equal(r.pass, false)
})
