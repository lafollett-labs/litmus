import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type GatePolicy = {
  workdir: string // realpath'd by the caller once
  readRoots: string[] // plugin and subject roots: readable, never writable
  denyRoots: string[] // suite roots: never readable, even inside a read root
  protect?: string[] // workdir-relative names never written, beside .git (final_message.txt, .mcp.json)
  protectSegments?: string[] // names that may not appear at any depth of a written path (.claude under project settings)
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
// Bookkeeping tools that take no path and start nothing.
const ALWAYS = new Set(['TodoWrite', 'Skill'])
// Subagents are allowed because a subject's fan-out is part of what is being
// measured, and their tool calls come back through this same gate. That holds
// only in this session, so `isolation` (a git worktree mid-session, or a remote
// agent outside the local gate) is refused.
const SUBAGENT = new Set(['Agent', 'Task'])
export const SHELL_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'KillBash']
export const NETWORK_TOOLS = ['WebFetch', 'WebSearch']
const SHELL = new Set(SHELL_TOOLS)
const NETWORK = new Set(NETWORK_TOOLS)

// Default-deny (docs/ARCHITECTURE.md § Executor). A tool this function does
// not name is refused: a new tool Claude Code ships next month has to be
// classified here before a subject can use it.
// A gate that throws has not decided, so any failure to judge is a denial
// with the error as its reason: an unreadable path never becomes an allowed one.
export function decide(tool: string, input: Record<string, unknown>, p: GatePolicy): Decision {
  try {
    return judge(tool, input, p)
  } catch (e) {
    return deny(`${tool}: the gate could not judge this call (${(e as Error).message})`)
  }
}

function judge(tool: string, input: Record<string, unknown>, p: GatePolicy): Decision {
  if (ALWAYS.has(tool)) return { allow: true }
  if (SUBAGENT.has(tool)) {
    return input['isolation'] === undefined || input['isolation'] === null ? { allow: true } : deny(`${tool} with isolation "${String(input['isolation'])}" runs outside this session's gate`)
  }
  if (SHELL.has(tool)) return p.allowShell ? { allow: true } : deny(`${tool} needs allow_shell: true`)
  if (NETWORK.has(tool)) return p.allowNetwork ? { allow: true } : deny(`${tool} needs allow_network: true`)
  if (tool.startsWith('mcp__')) {
    return p.allowNetwork && p.allowHooks ? { allow: true } : deny(`${tool} needs allow_network and allow_hooks`)
  }
  const reads = READ[tool]
  const writes = WRITE[tool]
  if (!reads && !writes) return deny(`${tool} is not a tool litmus allows`)

  const roots = writes ? [p.workdir] : [p.workdir, ...p.readRoots]
  const protectedPaths = ['.git', ...(p.protect ?? [])].map(n => join(p.workdir, n))
  // A pattern is relative to the tool's search path, not to the workdir.
  const path = input['path']
  const searchBase = typeof path === 'string' && path !== '' ? resolve(p.workdir, path) : p.workdir
  for (const field of reads ?? writes!) {
    const raw = input[field]
    if (raw === undefined || raw === null || raw === '') continue // tool default: the cwd, which is the workdir
    if (typeof raw !== 'string') return deny(`${tool}.${field} is not a path`)
    if (raw.startsWith('~')) return deny(`${tool}.${field} may not start with ~: ${raw}`)
    // A pattern's reach is judged by its literal prefix, so anything that lets
    // the tool's own glob grammar reach further is refused rather than parsed
    // here: .. or ~ anywhere, or a brace or class holding a / (an absolute or
    // climbing alternative).
    if (/[*?[{]/.test(raw) && (raw.includes('..') || raw.includes('~') || /\{[^}]*\/|\[[^\]]*\//.test(raw))) {
      return deny(`${tool}.${field} is a pattern that could reach outside its base: ${raw}`)
    }
    const target = globBase(raw)
    const from = field === 'path' || field === 'file_path' || field === 'notebook_path' ? p.workdir : searchBase
    const real = realpathOf(isAbsolute(target) ? target : resolve(from, target))
    if (real === undefined) return deny(`${tool}.${field} goes through a dangling symlink: ${raw}`)
    if (!roots.some(r => inside(real, r))) {
      return deny(`${tool} may only ${writes ? 'write inside the workdir' : 'read the workdir or its plugin and subject roots'}: ${raw}`)
    }
    if (p.denyRoots.some(r => inside(real, r) || (RECURSIVE.has(tool) && inside(r, real)))) return deny(`${tool} may not reach a suite root: ${raw}`)
    // Folded: a protected name may not exist yet, so realpath cannot supply its
    // on-disk case, and on a case-insensitive volume .CLAUDE is .claude.
    const guarded = writes ? protectedPaths.find(g => inside(fold(real), fold(g))) : undefined
    if (guarded) return deny(`${tool} may not write ${relative(p.workdir, guarded)}: ${raw}`)
    // Claude Code discovers .claude/skills, agents and commands in every
    // directory between a touched file and the cwd, so a nested one written
    // mid-session would load as the session's own config.
    const segments = writes ? relative(p.workdir, real).split(sep).map(fold) : []
    const nested = (p.protectSegments ?? []).find(name => segments.includes(fold(name)))
    if (nested) return deny(`${tool} may not write under a ${nested} directory at any depth: ${raw}`)
  }
  return { allow: true }
}

export const inside = (path: string, root: string) => path === root || path.startsWith(root + sep)
// Upper then lower: a real case fold for what APFS treats as one name
// (ſ and S, the Kelvin sign and k), which toLowerCase alone misses.
export const fold = (path: string) => path.normalize('NFC').toUpperCase().toLowerCase()

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
  // .native returns the on-disk case and normalization. The JS realpath keeps
  // the case as typed, and on a case-insensitive volume ".GIT/hooks" opens
  // .git/hooks while failing a startsWith against ".git".
  return tail.length ? join(realpathSync.native(head), ...tail) : realpathSync.native(head)
}
