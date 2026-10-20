import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { COMPONENT_DIRS, PROCESS_FILES } from '../../src/executors/harness.ts'

// The plugin scan must know every place the pinned Claude Code loads a plugin
// from, or a store inside a new one goes unscanned and still loads. The
// loader's own lists sit together in the binary, right after its marketplace
// file name: the default component directories, then the default files.
const binary = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
const at = (() => {
  try {
    return join(dirname(createRequire(import.meta.url).resolve(`${binary}/package.json`)), 'claude')
  } catch {
    return undefined
  }
})()
// In CI a missing binary is a failure, never a quiet skip.
const skip = at === undefined && !process.env['CI'] ? `${binary} is not installed` : false

function loaderLists(): { dirs: string[]; files: string[] } {
  const bin = readFileSync(at!)
  const anchor = bin.indexOf('"marketplace.json"),')
  assert.ok(anchor >= 0, 'the anchor moved: find the plugin loader\'s lists in the binary by hand and update this test')
  const text = bin.subarray(anchor, anchor + 1024).toString('latin1')
  const m = /^"marketplace\.json"\),[\w$]+=(\[[^\]]*\]),[\w$]+=(\[[^\]]*\])/.exec(text)
  assert.ok(m, `the loader's lists changed shape after the anchor: ${text.slice(0, 200)}`)
  return { dirs: JSON.parse(m[1]!) as string[], files: JSON.parse(m[2]!) as string[] }
}

test('the plugin scan knows every directory and default file the pinned Claude Code loads from a plugin', { skip }, () => {
  const { dirs, files } = loaderLists()
  assert.ok(dirs.length > 0 && files.length > 0, 'the loader\'s lists came back empty')
  // hooks/ and monitors/ hold fixed-name process files, checked by name.
  assert.deepEqual([...dirs].sort(), [...COMPONENT_DIRS, 'hooks', 'monitors'].sort())
  for (const d of ['hooks', 'monitors']) assert.ok(PROCESS_FILES.some(f => f.startsWith(`${d}/`)), `${d}/ has no process file`)
  // A root SKILL.md is a component the walk reads; every other default file starts a process.
  assert.deepEqual(files.filter(f => f !== 'SKILL.md').filter(f => !PROCESS_FILES.includes(f)), [])
})
