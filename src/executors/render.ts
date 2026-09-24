import { readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { walk } from '../sandbox/snapshot.ts'

// {{fixture}}, {{diff}} and {{file:<path>}} (docs/ARCHITECTURE.md § Executor).
// Line numbers are part of the render because findings cite lines: a model
// that has to count lines itself gets them wrong, and review-match then
// scores a correct finding as a miss.
export function renderPrompt(template: string, workdir: string, changePatch?: string): string {
  return template.replace(/\{\{\s*(fixture|diff|file:([^}]+?))\s*\}\}/g, (_all, what: string, path?: string) => {
    if (what === 'fixture') return [...walk(workdir)].map(f => numbered(relative(workdir, f).split(sep).join('/'), f)).join('\n')
    if (what === 'diff') return changePatch ? readFileSync(changePatch, 'utf8') : ''
    const abs = resolve(workdir, path!.trim())
    // A template may only name files inside the workdir; "../truth.yaml" is
    // exactly the leak the sandbox exists to prevent.
    if (abs !== workdir && !abs.startsWith(workdir + sep)) throw new Error(`{{file:${path}}} points outside the workdir`)
    return numbered(path!.trim(), abs)
  })
}

function numbered(name: string, path: string): string {
  const data = readFileSync(path)
  if (data.includes(0)) return `=== ${name} === (binary, ${data.length} bytes)\n`
  const lines = data.toString('utf8').replace(/\n$/, '').split('\n')
  const width = String(lines.length).length
  return `=== ${name} ===\n${lines.map((l, i) => `${String(i + 1).padStart(width)} | ${l}`).join('\n')}\n`
}

// The last ```json fence wins, because models reason first and answer last;
// failing that, the whole response if it is one JSON object. Anything else is
// no object at all, and the graders decide what that means.
export function extractJson(text: string): Record<string, unknown> | undefined {
  const fences = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)]
  const candidates = fences.length ? [fences[fences.length - 1]![1]!] : [text.trim()]
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c)
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch {
      // not JSON: fall through to undefined
    }
  }
  return undefined
}
