import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, parse, resolve, sep } from 'node:path'
import { ConfigError, InfraError } from '../core/errors.ts'
import { sha256 } from '../core/hash.ts'
import { RUN_ID } from '../core/ids.ts'
import type { LoadedCase } from '../suite/load.ts'
import { snapshot, symlinksUnder, type Snapshot } from './snapshot.ts'

export type Workdir = {
  root: string // everything for this attempt; removed by cleanup()
  dir: string // what the subject works in
  home: string // HOME for child processes
  claudeConfig: string // CLAUDE_CONFIG_DIR for the harness
  before: Snapshot
  cleanup(): void
}

// Git runs only here, while the workdir is built and before the subject has
// touched it. After the subject runs, litmus never invokes git in the workdir
// again, so a .git/config or hook the subject writes (core.fsmonitor,
// core.hooksPath) has nothing to fire on.
const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
const GIT_ARGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=litmus', '-c', 'user.email=litmus@localhost']

// `avoid` is every directory a workdir must never sit inside: the results
// store and the suite roots. The runner passes them.
export function buildWorkdir(c: LoadedCase, where: { run: string; key: string; attempt: number }, base: string = tmpdir(), avoid: string[] = []): Workdir {
  // root is removed recursively below, so every part of its path is checked
  // first: a run id or attempt that is not what the grammar says never reaches rmSync.
  if (!RUN_ID.test(where.run)) throw new Error(`not a run id: ${where.run}`)
  if (!Number.isSafeInteger(where.attempt) || where.attempt < 1) throw new Error(`not an attempt number: ${where.attempt}`)
  // The slug alone is not one-to-one (a/b_c@x#1 and a_b/c@x#1 both read
  // a_b_c_x_1), and the rmSync below would then delete a live sibling. The
  // key's hash makes the name unique.
  const root = join(resolve(base), 'litmus', where.run, `${slug(where.key)}-${sha256(where.key).slice(0, 12)}-${where.attempt}`)
  const under = avoid.map(a => resolve(a)).find(a => root === a || root.startsWith(a + sep))
  if (under) throw new InfraError(`workdir ${root} would sit inside ${under}; point TMPDIR outside the results store and every suite root`, { retryable: false })
  rmSync(root, { recursive: true, force: true }) // fresh on every attempt, never reused
  const dir = join(root, 'work')
  const home = join(root, 'home')
  const claudeConfig = join(root, 'claude')
  for (const d of [dir, home, claudeConfig]) mkdirSync(d, { recursive: true })
  const cleanup = () => rmSync(root, { recursive: true, force: true })

  try {
    // Claude Code loads CLAUDE.md, CLAUDE.local.md and AGENTS.md from every
    // ancestor of its cwd, so a workdir under a repo would hand that repo's
    // instructions to the subject.
    const leak = instructionFileAbove(dir)
    if (leak) throw new InfraError(`workdir ${dir} sits under ${leak}; point TMPDIR somewhere outside any repo`, { retryable: false })

    if (c.fixtureDir) copyTree(c.fixtureDir, dir, c.id)
    git(dir, ['init', '-q', '-b', 'main'])
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '--allow-empty', '-m', 'fixture'])
    if (c.changePatch) {
      git(dir, ['checkout', '-q', '-b', 'litmus/change'])
      git(dir, ['apply', '--index', c.changePatch], `${c.id}: change.patch does not apply to the fixture`)
      git(dir, ['commit', '-q', '--allow-empty', '-m', 'change'])
    }
    // A patch can create a symlink too, and an absolute one can point straight
    // back at this case's truth.yaml. The post-change tree is checked again.
    const links = symlinksUnder(dir).filter(p => !p.startsWith('.git/'))
    if (links.length) throw new ConfigError(`${c.id}: change.patch creates symlinks (${links.join(', ')}); a fixture may not contain links`)
    return { root, dir, home, claudeConfig, before: snapshot(dir), cleanup }
  } catch (e) {
    cleanup()
    throw e
  }
}

// Only regular files and directories are copied, and anything else is refused.
// A symlink could resolve to ground truth (or anywhere) outside the workdir; a
// .git directory would bring its own config and hooks into the one git step
// litmus does run; a FIFO or socket would hang or reach out when read.
function copyTree(from: string, to: string, caseId: string): void {
  for (const name of readdirSync(from).sort()) {
    const src = join(from, name)
    const dst = join(to, name)
    const st = lstatSync(src)
    if (st.isSymbolicLink()) throw new ConfigError(`${caseId}: fixture contains a symlink at ${src}`)
    if (name === '.git') throw new ConfigError(`${caseId}: fixture contains a .git directory at ${src}`)
    if (st.isDirectory()) {
      mkdirSync(dst, { recursive: true })
      copyTree(src, dst, caseId)
    } else if (st.isFile()) {
      copyFileSync(src, dst)
      chmodSync(dst, st.mode & 0o777)
    } else {
      throw new ConfigError(`${caseId}: fixture contains ${src}, which is neither a regular file nor a directory`)
    }
  }
}

function git(cwd: string, args: string[], failure?: string): void {
  const r = spawnSync('git', [...GIT_ARGS, ...args], {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', HOME: cwd, ...GIT_ENV },
    encoding: 'utf8',
  })
  if (r.error) throw new InfraError(`git is not available: ${r.error.message}`, { retryable: false })
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout).trim()
    throw failure ? new ConfigError(`${failure}: ${detail}`) : new InfraError(`git ${args[0]} failed: ${detail}`, { retryable: false })
  }
}

const INSTRUCTION_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude/CLAUDE.md', '.claude/rules']

function instructionFileAbove(dir: string): string | undefined {
  let d = dirname(dir)
  const { root } = parse(d)
  while (true) {
    for (const f of INSTRUCTION_FILES) if (existsSync(join(d, f))) return join(d, f)
    if (d === root) return undefined
    d = dirname(d)
  }
}

const slug = (key: string) => key.replace(/[^a-z0-9._-]+/gi, '_')
