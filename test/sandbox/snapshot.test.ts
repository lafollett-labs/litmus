import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readRegular, snapshot } from '../../src/sandbox/snapshot.ts'
import { tree } from '../helpers/tmp.ts'

test('a regular file is read; a link or a FIFO is not followed, and a FIFO never blocks', () => {
  const dir = tree({ 'a.txt': 'x', 'outside.txt': 'secret' })
  symlinkSync(join(dir, 'outside.txt'), join(dir, 'link'))
  spawnSync('mkfifo', [join(dir, 'pipe')])
  assert.equal(readRegular(join(dir, 'a.txt'))?.toString(), 'x')
  assert.equal(readRegular(join(dir, 'link')), undefined)
  assert.equal(readRegular(join(dir, 'pipe')), undefined)
  assert.equal(readRegular(join(dir, 'gone')), undefined)
})

test('the snapshot holds regular files only', () => {
  const dir = tree({ 'a.txt': 'x' })
  spawnSync('mkfifo', [join(dir, 'pipe')])
  writeFileSync(join(dir, 'b.txt'), 'y')
  assert.deepEqual([...snapshot(dir).keys()], ['a.txt', 'b.txt'])
})
