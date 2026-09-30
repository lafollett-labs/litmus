import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactor, secretValues } from '../../src/core/redact.ts'
import { runHarness } from '../../src/executors/harness.ts'
import { buildWorkdir } from '../../src/sandbox/workdir.ts'
import { oneCase } from '../helpers/cases.ts'
import { tree } from '../helpers/tmp.ts'

// A real Claude Code session on the cheapest model: cents. Skipped unless
// LITMUS_LIVE=1 and ANTHROPIC_API_KEY is set.
const skip = process.env['LITMUS_LIVE'] !== '1' ? 'set LITMUS_LIVE=1 to run' : process.env['ANTHROPIC_API_KEY'] ? false : 'ANTHROPIC_API_KEY is not set'

test('claude-code writes a file in its workdir and nowhere else', { skip, timeout: 180_000 }, async () => {
  const { c, base } = oneCase(
    'name: c\nexecutor:\n  kind: harness\n  harness: claude-code\n  prompt: Create a file named pong.txt containing the word pong. Do nothing else.\n  max_turns: 5\ngraders: [{ kind: regex, pattern: x }]\ntimeout_s: 150\n',
    { 'fixture/README.md': 'empty repo\n' },
  )
  const out = tree({ '.keep': '' })
  const workdir = buildWorkdir(c, { run: '2026-09-24T12-00-00Z-a1b2', key: 's/c@haiku#1', attempt: 1 }, base)
  try {
    const r = await runHarness({
      key: 's/c@haiku#1', case: c, configName: 'haiku', config: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      trial: 1, attempt: 1, workdir, suiteRoots: [], out: { artifacts: join(out, 'a'), transcript: join(out, 't.jsonl') },
      pricing: {}, emit: () => {}, redact: redactor(secretValues([])), signal: new AbortController().signal,
    })
    assert.equal(r.exit, 'ok', r.reason ?? 'no reason')
    assert.match(readFileSync(r.artifacts['pong.txt']!, 'utf8'), /pong/i)
    assert.ok((r.usage.cost_usd ?? 0) > 0)
  } finally {
    workdir.cleanup()
  }
})
