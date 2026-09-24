import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

export type GatePolicy = {
  workdir: string // realpath'd by the caller once
  readRoots: string[] // plugin and subject roots: readable, never writable
  denyRoots: string[] // suite roots: never readable, even inside a read root
  allowShell: boolean
  allowNetwork: boolean
  allowHooks: boolean
}

export type Decision = { allow: true } | { allow: false; reason: string }

const READ: Record<string, string[]> = { Read: ['file_path'], Glob: ['path', 'pattern'], Grep: ['path', 'glob'], LS: ['path'] }
// Tools that descend from their base: a suite root anywhere below the base is
// reached, so it is refused as surely as one named directly.
const RECURSIVE = new Set(['Glob', 'Grep'])
const WRITE: Record<string, string[]> = { Write: ['file_path'], Edit: ['file_path'], MultiEdit: ['file_path'], NotebookEdit: ['notebook_path'] }
// Subagents are allowed because a subject's fan-out is part of what is being
// measured; their own tool calls come back through this same gate.
const ALWAYS = new Set(['Agent', 'Task', 'TodoWrite', 'Skill'])
export const SHELL_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'KillBash']
export const NETWORK_TOOLS = ['WebFetch', 'WebSearch']
const SHELL = new Set(SHELL_TOOLS)
const NETWORK = new Set(NETWORK_TOOLS)

// Default-deny (docs/ARCHITECTURE.md § Executor). A tool this function does
// not name is refused: a new tool Claude Code ships next month has to be
// classified here before a subject can use it.
export function decide(tool: string, input: Record<string, unknown>, p: GatePolicy): Decision {
  if (ALWAYS.has(tool)) return { allow: true }
  if (SHELL.has(tool)) return p.allowShell ? { allow: true } : deny(`${tool} needs allow_shell: true`)
  if (NETWORK.has(tool)) return p.allowNetwork ? { allow: true } : deny(`${tool} needs allow_network: true`)
  if (tool.startsWith('mcp__')) {
    return p.allowNetwork && p.allowHooks ? { allow: true } : deny(`${tool} needs allow_network and allow_hooks`)
  }
  const reads = READ[tool]
  const writes = WRITE[tool]
  if (!reads && !writes) return deny(`${tool} is not a tool litmus allows`)

  const roots = writes ? [p.workdir] : [p.workdir, ...p.readRoots]
  const gitDir = join(p.workdir, '.git')
  // A pattern is relative to the tool's search path, not to the workdir.
  const path = input['path']
  const searchBase = typeof path === 'string' && path !== '' ? resolve(p.workdir, path) : p.workdir
  for (const field of reads ?? writes!) {
    const raw = input[field]
    if (raw === undefined || raw === null || raw === '') continue // tool default: the cwd, which is the workdir
    if (typeof raw !== 'string') return deny(`${tool}.${field} is not a path`)
    // A glob's base is its literal prefix, so ".." after a wildcard
    // ("*/../../etc") would be judged by the prefix alone; and "~" is
    // expanded by the tool, not by resolve(). Both are refused outright.
    if (raw.split(/[\\/]/).includes('..') && /[*?[{]/.test(raw)) return deny(`${tool}.${field} may not climb with .. in a pattern: ${raw}`)
    if (raw.startsWith('~')) return deny(`${tool}.${field} may not start with ~: ${raw}`)
    const target = globBase(raw)
    const from = field === 'path' || field === 'file_path' || field === 'notebook_path' ? p.workdir : searchBase
    const real = realpathOf(isAbsolute(target) ? target : resolve(from, target))
    if (real === undefined) return deny(`${tool}.${field} goes through a dangling symlink: ${raw}`)
    if (!roots.some(r => inside(real, r))) {
      return deny(`${tool} may only ${writes ? 'write inside the workdir' : 'read the workdir or its plugin and subject roots'}: ${raw}`)
    }
    if (p.denyRoots.some(r => inside(real, r) || (RECURSIVE.has(tool) && inside(r, real)))) return deny(`${tool} may not reach a suite root: ${raw}`)
    if (writes && inside(real, gitDir)) return deny(`${tool} may not write under .git: ${raw}`)
  }
  return { allow: true }
}

const inside = (path: string, root: string) => path === root || path.startsWith(root + sep)

const deny = (reason: string): Decision => ({ allow: false, reason })

// A glob's reach is decided by its literal prefix: "/etc/**" reads /etc, and
// "src/**/*.ts" stays inside src.
function globBase(pattern: string): string {
  const i = pattern.search(/[*?[{]/)
  if (i === -1) return pattern
  const prefix = pattern.slice(0, i)
  return prefix.endsWith('/') || prefix === '' ? prefix || '.' : dirname(prefix)
}

// Lexical checks are not enough: workdir/link -> /etc passes a startsWith on
// the path string and reads /etc. The deepest existing ancestor is resolved
// through realpath, so a symlink is judged by where it lands; the part that
// does not exist yet (a file about to be written) is appended as-is. A
// dangling symlink on the way is undefined: writing through it would create
// its target, wherever that is.
export function realpathOf(path: string): string | undefined {
  let head = resolve(path)
  const tail: string[] = []
  while (!existsSync(head)) {
    if (lstatSync(head, { throwIfNoEntry: false })?.isSymbolicLink()) return undefined
    const parent = dirname(head)
    if (parent === head) break
    tail.unshift(basename(head))
    head = parent
  }
  return tail.length ? join(realpathSync(head), ...tail) : realpathSync(head)
}
