import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError } from '../../src/core/errors.ts'
import type { TranscriptEntry } from '../../src/core/types.ts'
import { regex } from '../../src/graders/regex.ts'
import { ctx, spec, trial } from '../helpers/grading.ts'

const session: TranscriptEntry[] = [
  { t: 0, kind: 'message', role: 'system', text: 'You review Go. Look for TOKEN bugs.' },
  { t: 1, kind: 'message', role: 'user', text: 'Review this: func TOKEN() {}' },
  { t: 2, kind: 'tool_call', id: '1', tool: 'Read', input: { file_path: 'auth/token.go' } },
  { t: 3, kind: 'tool_result', id: '1', text: 'package auth // expiry check', is_error: false },
  { t: 4, kind: 'message', role: 'assistant', text: 'Found an expiry bug.' },
]

test('a pattern in an artifact passes at the default of at least one match', async () => {
  const r = await regex(spec({ kind: 'regex', target: 'response.txt', pattern: 'off-by-one' }), trial({ artifacts: { 'response.txt': 'an off-by-one here' } }), ctx())
  assert.equal(r.pass, true)
  assert.equal(r.metrics?.['matches'], 1)
})

test('the match count must land between min and max', async () => {
  const t = trial({ artifacts: { 'response.txt': 'bug bug bug' } })
  assert.equal((await regex(spec({ kind: 'regex', target: 'response.txt', pattern: 'bug', max: 2 }), t, ctx())).pass, false)
  assert.equal((await regex(spec({ kind: 'regex', target: 'response.txt', pattern: 'bug', min: 3, max: 3 }), t, ctx())).pass, true)
  assert.equal((await regex(spec({ kind: 'regex', target: 'response.txt', pattern: 'bug', min: 4 }), t, ctx())).pass, false)
  assert.equal((await regex(spec({ kind: 'regex', target: 'response.txt', pattern: 'nope', min: 0, max: 0 }), t, ctx())).pass, true)
})

test('flags apply, and a pattern that is never found fails', async () => {
  const t = trial({ artifacts: { 'response.txt': 'SQL Injection' } })
  assert.equal((await regex(spec({ kind: 'regex', target: 'response.txt', pattern: 'sql injection' }), t, ctx())).pass, false)
  assert.equal((await regex(spec({ kind: 'regex', target: 'response.txt', pattern: 'sql injection', flags: 'i' }), t, ctx())).pass, true)
})

test('the transcript target covers assistant text and tool calls', async () => {
  const t = trial({ transcript: session })
  for (const pattern of ['expiry bug', 'Read .*token\\.go']) {
    assert.equal((await regex(spec({ kind: 'regex', pattern }), t, ctx())).pass, true, pattern)
  }
})

test('canary: a pattern that appears only in a tool result, the fixture the subject read, does not pass', async () => {
  const r = await regex(spec({ kind: 'regex', pattern: 'expiry check' }), trial({ transcript: session }), ctx())
  assert.equal(r.pass, false)
})

test('canary: a pattern that matches the empty string counts only real matches', async () => {
  const t = trial({ artifacts: { 'response.txt': 'nothing relevant here' } })
  for (const pattern of ['TODO|', 'x*', '(foo)?']) assert.equal((await regex(spec({ kind: 'regex', target: 'response.txt', pattern }), t, ctx())).pass, false, pattern)
  assert.equal((await regex(spec({ kind: 'regex', target: 'response.txt', pattern: 'TODO|here' }), t, ctx())).pass, true)
})

test('canary: a pattern that appears only in the prompt litmus sent does not pass', async () => {
  const r = await regex(spec({ kind: 'regex', pattern: 'TOKEN' }), trial({ transcript: session }), ctx())
  assert.equal(r.pass, false)
})

test('canary: a missing artifact or transcript fails, even when zero matches would be allowed', async () => {
  const none = spec({ kind: 'regex', target: 'response.txt', pattern: 'x', min: 0, max: 0 })
  assert.equal((await regex(none, trial(), ctx())).pass, false)
  const r = await regex(spec({ kind: 'regex', pattern: 'x', min: 0, max: 0 }), trial({ transcript: null }), ctx())
  assert.equal(r.pass, false)
  assert.match(r.rationale ?? '', /transcript is missing/)
})

test('an invalid pattern is a config error, not a failed trial', async () => {
  await assert.rejects(regex({ kind: 'regex', target: 'transcript', pattern: '(', min: 1 }, trial(), ctx()), ConfigError)
})

test('matches are counted, not collected, and counting stops once past max', async () => {
  const t = trial({ artifacts: { 'response.txt': 'a'.repeat(1_000_000) } })
  const r = await regex(spec({ kind: 'regex', target: 'response.txt', pattern: 'a', min: 0, max: 3 }), t, ctx())
  assert.equal(r.pass, false)
  assert.match(r.rationale ?? '', /matched response\.txt more than 3 time\(s\)/)
  assert.equal(r.metrics?.['matches'], null) // a lower bound, not a count
})
