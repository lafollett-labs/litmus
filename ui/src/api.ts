import type { Comparison, RunEvent, TrialRecord, TranscriptEntry, Verdict, VerdictKind } from '../../src/core/types.ts'
import type { RunManifest } from '../../src/store/store.ts'
import type { SuiteView } from './model.ts'

// The server's API (docs/ARCHITECTURE.md § Server), and nothing else: the UI
// never reads a file or talks to a provider. Same origin, so the browser sends
// the Origin the server checks on every request that changes state.

export type Artifact = { name: string; size?: number; text?: string; binary?: true; truncated?: true; missing?: true }
export type TrialDetail = { record: TrialRecord; transcript: TranscriptEntry[]; transcript_truncated?: true; artifacts: Artifact[] }
export type StoredRun = { manifest: RunManifest; verdicts: Verdict[]; comparisons: Comparison[] }
export type StartRun = { select?: string[]; configs?: string[]; trials?: number; rerun?: { run: string; only: VerdictKind[] } }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
  const data = (await res.json()) as T & { error?: string }
  if (!res.ok) throw Object.assign(new Error(data.error ?? `${method} ${path}: ${res.status}`), { status: res.status })
  return data
}

export const api = {
  suites: () => call<SuiteView[]>('GET', '/api/suites'),
  configs: () => call<{ configs: Record<string, { provider: string; model?: string }>; judges: Record<string, unknown> }>('GET', '/api/configs'),
  runs: () => call<RunManifest[]>('GET', '/api/runs'),
  run: (id: string) => call<StoredRun>('GET', `/api/runs/${id}`),
  start: (b: StartRun) => call<{ id: string | null; message?: string }>('POST', '/api/runs', b),
  cancel: (id: string) => call<{ id: string }>('POST', `/api/runs/${id}/cancel`),
  trial: (id: string, key: string) => call<TrialDetail>('GET', `/api/runs/${id}/trial?key=${encodeURIComponent(key)}`),
  compare: (a: string, b: string) => call<Comparison>('GET', `/api/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
}

// The run's events: the backlog, then live ones, until the run ends. The
// stream is closed on the last event, or EventSource would reconnect forever;
// an error closes it too (the server is local: an error means it is gone, or
// the run's record ends without a last event).
// A stream that fails outright (a 204 for a run with nothing left to send,
// or any error status) is CLOSED before its error fires, so the end is
// tracked here, never read back from readyState.
export function follow(id: string, on: (e: RunEvent) => void, end: () => void): () => void {
  const source = new EventSource(`/api/runs/${id}/events`)
  let ended = false
  const stop = () => {
    if (ended) return
    ended = true
    source.close()
    end()
  }
  source.onmessage = m => {
    const e = JSON.parse(m.data as string) as RunEvent
    on(e)
    if (e.type === 'run.finished' || e.type === 'run.cancelled' || e.type === 'run.failed') stop()
  }
  source.onerror = stop
  return stop
}
