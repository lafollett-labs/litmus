import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { resolveSide } from '../cli/address.ts'
import { ConfigError } from '../core/errors.ts'
import { parseTrialKey, RUN_ID } from '../core/ids.ts'
import { redactor, secretValues } from '../core/redact.ts'
import type { RunEvent, TrialRecord, VerdictKind } from '../core/types.ts'
import { planRun } from '../runner/plan.ts'
import { pair, run, type RunOptions } from '../runner/run.ts'
import { readRegular } from '../sandbox/snapshot.ts'
import { latestVerdicts, listRuns, readEvents, readRun, setBaseline } from '../store/store.ts'
import { loadConfig, loadProject } from '../suite/load.ts'

export type ServeOptions = {
  configFile: string
  port: number // 0 picks a free one
  uiDir?: string // the built UI; default ui/dist in this package
  env?: NodeJS.ProcessEnv
  runSeams?: Partial<RunOptions> // tests only: stand-in executors, no backoff
}

export type Litmus = { server: Server; port: number; url: string; close: () => Promise<void> }

// A run started here: its events so far (the backlog a late subscriber gets
// first), the streams listening, and the switch that cancels it.
type Live = { ctl: AbortController; backlog: RunEvent[]; subscribers: Set<ServerResponse>; done: boolean; settled: Promise<unknown> }

const TERMINAL = new Set<RunEvent['type']>(['run.finished', 'run.cancelled', 'run.failed'])
const KINDS = ['PASS', 'FAIL', 'FLAKY', 'ERROR', 'INCONCLUSIVE'] as const satisfies readonly VerdictKind[]
const MAX_BODY = 1 << 20

const StartRun = z.strictObject({
  select: z.array(z.string().min(1)).default([]),
  configs: z.array(z.string().min(1)).optional(),
  trials: z.int().min(1).optional(),
  baseline: z.string().min(1).optional(),
  rerun: z.strictObject({ run: z.string().regex(RUN_ID), only: z.array(z.enum(KINDS)).min(1) }).optional(),
})
const SetBaseline = z.strictObject({ run: z.string().regex(RUN_ID) })

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// docs/ARCHITECTURE.md § Server. Bound to 127.0.0.1 only, and every request
// must name this server exactly in Host, so another site in the operator's
// browser can neither rebind a name onto it nor, lacking an Origin of its own,
// start a run that spends the operator's money. No CORS header is ever sent.
export async function serve(o: ServeOptions): Promise<Litmus> {
  const env = o.env ?? process.env
  const uiDir = resolve(o.uiDir ?? join(import.meta.dirname, '../../ui/dist'))
  const live = new Map<string, Live>()
  let hosts = new Set<string>()
  let origins = new Set<string>()

  const server = createServer((req, res) => {
    handle(req, res).catch(e => {
      const status = e instanceof HttpError ? e.status : e instanceof ConfigError || e instanceof z.ZodError ? 400 : 500
      if (status === 500) process.stderr.write(`litmus serve: ${(e as Error).stack ?? String(e)}\n`)
      if (res.headersSent) return void res.end()
      const message = e instanceof z.ZodError ? e.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') : (e as Error).message
      json(res, status, { error: status === 500 ? 'internal error' : message })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hosts.has(req.headers.host ?? '')) throw new HttpError(403, 'Host must be this server')
    const method = req.method ?? 'GET'
    if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
      if (!origins.has(req.headers.origin ?? '')) throw new HttpError(403, 'Origin must be this server')
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return staticFile(req, res, url.pathname)
    // /api/<resource>[/<id>[/<action>]]: the id (a run id or a baseline name)
    // is checked where it is used.
    const [resource, id = '', action, ...extra] = url.pathname.split('/').slice(2)
    const route = extra.length ? '' : `${method} /${resource}${id ? '/:id' : ''}${action === undefined ? '' : `/${action}`}`
    switch (route) {
      case 'GET /suites':
        return json(res, 200, suites())
      case 'GET /configs': {
        const config = loadConfig(o.configFile, env)
        return json(res, 200, redactor(secretValues(config.redact, env)).json({ configs: config.configs, judges: config.judges }))
      }
      case 'GET /runs':
        return json(res, 200, listRuns(loadConfig(o.configFile, env).resultsDir))
      case 'POST /runs':
        return json(res, 202, await start(StartRun.parse(await body(req))))
      case 'GET /runs/:id':
        return json(res, 200, stored(id))
      case 'GET /runs/:id/events':
        return events(req, res, id)
      case 'POST /runs/:id/cancel': {
        stored(id)
        const r = live.get(id)
        if (!r || r.done) throw new HttpError(409, `run ${id} is not running`)
        r.ctl.abort(new Error('cancelled from the API'))
        return json(res, 202, { id })
      }
      case 'GET /runs/:id/trial':
        return json(res, 200, trial(id, url.searchParams.get('key')))
      case 'GET /compare':
        return json(res, 200, compare(url.searchParams.get('a'), url.searchParams.get('b')))
      case 'PUT /baselines/:id': {
        const { run: runId } = SetBaseline.parse(await body(req))
        setBaseline(loadConfig(o.configFile, env).resultsDir, id, runId)
        return json(res, 200, { name: id, run: runId })
      }
      default:
        throw new HttpError(404, `no route ${method} ${url.pathname}`)
    }
  }

  function suites() {
    const { config, suites } = loadProject(o.configFile, env)
    const latest = latestVerdicts(config.resultsDir)
    return suites.map(s => ({
      name: s.name,
      cases: s.cases.map(c => ({
        id: c.id,
        name: c.name,
        executor: c.spec.executor.kind,
        trials: c.settings.trials,
        tags: c.settings.tags,
        expect: c.spec.expect,
        latest: Object.fromEntries(latest.get(c.id) ?? []),
      })),
    }))
  }

  // Answers with the run id once the run has one, or with the reason it never
  // started. The run itself goes on after the response.
  async function start(b: z.infer<typeof StartRun>): Promise<{ id: string | null; message?: string }> {
    const plan = planRun(o.configFile, {
      selectors: b.select,
      ...(b.configs === undefined ? {} : { configs: b.configs }),
      ...(b.trials === undefined ? {} : { trials: b.trials }),
      ...(b.baseline === undefined ? {} : { baseline: b.baseline }),
      ...(b.rerun === undefined ? {} : { rerun: b.rerun }),
    }, { configs: 'configs' }, env)
    if (plan.kind === 'nothing') return { id: null, message: plan.message }
    const ctl = new AbortController()
    const entry: Live = { ctl, backlog: [], subscribers: new Set(), done: false, settled: Promise.resolve() }
    let id: string | undefined
    const started = Promise.withResolvers<string>()
    entry.settled = run({
      ...plan.options,
      env,
      ...o.runSeams,
      signal: ctl.signal,
      listener: e => {
        if (e.type === 'run.started') {
          id = e.run
          live.set(id, entry)
          started.resolve(id)
        }
        const n = entry.backlog.push(e) - 1
        for (const res of entry.subscribers) send(res, n, e)
        if (TERMINAL.has(e.type)) {
          entry.done = true
          for (const res of entry.subscribers) res.end()
          entry.subscribers.clear()
        }
      },
    })
      .catch(e => {
        if (id === undefined) started.reject(e)
        else process.stderr.write(`litmus serve: run ${id} failed: ${(e as Error).message}\n`)
      })
      .finally(() => {
        entry.done = true
        for (const res of entry.subscribers) res.end()
        entry.subscribers.clear()
        if (id !== undefined) live.delete(id)
      })
    return { id: await started.promise }
  }

  function stored(id: string) {
    if (!RUN_ID.test(id)) throw new HttpError(400, `"${id}" is not a run id`)
    const resultsDir = loadConfig(o.configFile, env).resultsDir
    if (!existsSync(join(resultsDir, id, 'run.json'))) throw new HttpError(404, `no run ${id}`)
    return readRun(resultsDir, id)
  }

  // Server-sent events: the backlog first, then the live stream, ending with
  // the run. A run no longer live replays events.jsonl and ends. Each event's
  // id is its place in the stream, so a client that reconnects with
  // Last-Event-ID picks up where it left off.
  function events(req: IncomingMessage, res: ServerResponse, id: string): void {
    stored(id)
    const last = Number(req.headers['last-event-id'])
    const from = Number.isSafeInteger(last) && last >= 0 ? last + 1 : 0
    res.writeHead(200, { ...SECURITY, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
    const r = live.get(id)
    if (r && !r.done) {
      r.backlog.forEach((e, n) => n >= from && send(res, n, e))
      r.subscribers.add(res)
      req.on('close', () => r.subscribers.delete(res))
      return
    }
    readEvents(loadConfig(o.configFile, env).resultsDir, id).forEach((e, n) => n >= from && send(res, n, e))
    res.end()
  }

  // The record, the transcript, and each artifact: as text when it is UTF-8,
  // otherwise only its size. Every file is read without following a link.
  function trial(id: string, key: string | null) {
    const ref = key === null ? undefined : parseTrialKey(key)
    if (!ref) throw new HttpError(400, `key must be a trial key, percent-encoded (got ${JSON.stringify(key)})`)
    stored(id)
    const dir = join(loadConfig(o.configFile, env).resultsDir, id, 'trials', ref.suite, ref.case, ref.config, String(ref.trial))
    const record = readRegular(join(dir, 'trial.json'))
    if (!record) throw new HttpError(404, `run ${id} has no trial ${key}`)
    const parsed = JSON.parse(record.toString('utf8')) as TrialRecord
    const transcript = (readRegular(join(dir, 'transcript.jsonl'), 64 << 20)?.toString('utf8') ?? '').split('\n').flatMap(line => {
      if (!line) return []
      try {
        return [JSON.parse(line) as unknown]
      } catch {
        return [] // a torn line
      }
    })
    const root = join(dir, 'artifacts')
    const artifacts = parsed.artifacts.map(name => {
      const path = resolve(root, name)
      if (!path.startsWith(root + sep)) return { name, missing: true }
      const data = readRegular(path, ARTIFACT_MAX)
      if (!data) return { name, missing: true }
      const text = utf8(data)
      return text === undefined ? { name, size: data.length, binary: true } : { name, size: data.length, text }
    })
    return { record: parsed, transcript, artifacts }
  }

  function compare(a: string | null, b: string | null) {
    if (!a || !b) throw new HttpError(400, 'compare needs a and b')
    const config = loadConfig(o.configFile, env)
    const sa = resolveSide(config.resultsDir, a)
    const sb = resolveSide(config.resultsDir, b)
    return pair(sa.side, sa.config, sb.side, sb.config, { tolerance: config.compare.tolerance, warnRatio: config.compare.warn_ratio })
  }

  // The built UI, and index.html for any path that is not a file, so the
  // UI's own routes survive a reload. Only GET, only regular files inside it.
  function staticFile(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'the UI is read-only')
    let rel: string
    try {
      rel = decodeURIComponent(pathname)
    } catch {
      throw new HttpError(400, 'bad path')
    }
    if (rel.includes('\0') || rel.split('/').includes('..')) throw new HttpError(400, 'bad path')
    const path = resolve(uiDir, `.${rel}`)
    const asked = path.startsWith(uiDir + sep) ? readRegular(path) : undefined
    const content = asked ?? readRegular(join(uiDir, 'index.html')) ?? Buffer.from(NOT_BUILT)
    const type = asked ? (TYPES[extname(path)] ?? 'application/octet-stream') : 'text/html; charset=utf-8'
    res.writeHead(200, { ...SECURITY, 'content-type': type, 'content-length': content.length })
    res.end(req.method === 'HEAD' ? undefined : content)
  }

  async function body(req: IncomingMessage): Promise<unknown> {
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'send application/json')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY) throw new HttpError(413, 'body too large')
      chunks.push(chunk as Buffer)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new HttpError(400, 'body is not JSON')
    }
  }

  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(o.port, '127.0.0.1', () => ok())
  })
  const port = (server.address() as { port: number }).port
  hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])

  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    // Cancels every live run and waits for each to be written, then stops.
    async close() {
      for (const r of live.values()) r.ctl.abort(new Error('the server is shutting down'))
      await Promise.all([...live.values()].map(r => r.settled))
      await new Promise<void>(ok => server.close(() => ok()))
      server.closeAllConnections()
    },
  }
}

const ARTIFACT_MAX = 8 << 20

// Frames and sniffing are how another page could borrow this one's clicks or
// reinterpret its bytes; nothing here is meant to be cached or referred.
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

const NOT_BUILT = '<!doctype html><title>litmus</title><p>The UI is not built. Run <code>npm run ui:build</code>, or use the API under <code>/api</code>.</p>\n'

function json(res: ServerResponse, status: number, value: unknown): void {
  const text = `${JSON.stringify(value)}\n`
  res.writeHead(status, { ...SECURITY, 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function send(res: ServerResponse, n: number, e: RunEvent): void {
  res.write(`id: ${n}\ndata: ${JSON.stringify(e)}\n\n`)
}

const decoder = new TextDecoder('utf-8', { fatal: true })
function utf8(data: Buffer): string | undefined {
  if (data.includes(0)) return undefined
  try {
    return decoder.decode(data)
  } catch {
    return undefined
  }
}
