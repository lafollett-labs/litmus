import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { request, type IncomingHttpHeaders } from 'node:http'
import { connect } from 'node:net'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RunEvent } from '../../src/core/types.ts'
import type { Executor } from '../../src/executors/types.ts'
import { serve } from '../../src/server/server.ts'
import { tree } from '../helpers/tmp.ts'

// docs/ARCHITECTURE.md § Server, over real HTTP on 127.0.0.1 with the fake
// provider: runs started and cancelled, events in order, and every request a
// page on another site could make refused.

const KEY = 'sk-ant-planted-0123456789abcdef'
const TOKEN = 'tok-planted-9a8b7c6d'

function project(): string {
  const files: Record<string, string> = {
    'litmus.config.yaml': `suites: [./suites]\nresults: ./.litmus/runs\nconcurrency: 2\nretries: 0\nredact: [MY_TOKEN]\nconfigs:\n  fake: { provider: fake }\n  fake-b: { provider: fake, model: "m-${TOKEN}" }\n`,
    'suites/e2e/suite.yaml': 'name: e2e\ndefaults: { trials: 2 }\n',
    'ui/index.html': '<!doctype html><title>ui</title>',
    'ui/app.js': 'console.log(1)',
  }
  const add = (name: string, fake: string) => {
    files[`suites/e2e/cases/${name}/case.yaml`] = `name: ${name}\nexecutor: { kind: model, prompt: "Review {{fixture}}" }\ngraders: [{ kind: regex, target: response.txt, pattern: LGTM }]\n`
    files[`suites/e2e/cases/${name}/fake.yaml`] = `responses: ${fake}\n`
    files[`suites/e2e/cases/${name}/fixture/a.txt`] = 'hello\n'
  }
  add('passes', `[{ text: "LGTM ${KEY}" }]`)
  add('fails', '[{ text: nope }]')
  add('slow', '[{ text: LGTM, delay_ms: 20000 }]')
  return tree(files)
}

const ROOT = project()
const litmus = await serve({ configFile: join(ROOT, 'litmus.config.yaml'), port: 0, uiDir: join(ROOT, 'ui'), env: { ANTHROPIC_API_KEY: KEY, MY_TOKEN: TOKEN }, runSeams: { backoffMs: () => 0 } })
after(() => litmus.close())
const HOST = `127.0.0.1:${litmus.port}`
const ORIGIN = `http://${HOST}`

type Reply = { status: number; headers: IncomingHttpHeaders; text: string; json: () => any }
function call(method: string, path: string, o: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  return new Promise((ok, fail) => {
    const body = o.body === undefined ? undefined : JSON.stringify(o.body)
    const headers: Record<string, string> = { host: HOST, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...o.headers }
    // A stream that never ends fails the test instead of hanging the suite.
    const req = request({ host: '127.0.0.1', port: litmus.port, method, path, headers, setHost: false, signal: AbortSignal.timeout(10_000) }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', d => (text += d))
      res.on('end', () => ok({ status: res.statusCode!, headers: res.headers, text, json: () => JSON.parse(text) }))
    })
    req.on('error', fail)
    req.end(body)
  })
}
const post = (path: string, body?: unknown, origin = ORIGIN) => call('POST', path, { headers: { origin }, ...(body === undefined ? {} : { body }) })
const parse = (text: string) => text.split('\n\n').filter(Boolean).map(block => ({ id: Number(/^id: (\d+)$/m.exec(block)![1]), event: JSON.parse(/^data: (.*)$/m.exec(block)![1]!) as RunEvent }))
const events = (id: string, headers: Record<string, string> = {}) => call('GET', `/api/runs/${id}/events`, { headers }).then(r => parse(r.text))
// The stream as it arrives: `first` fires on the first chunk.
function subscribe(id: string, first: () => void, headers: Record<string, string> = {}): Promise<ReturnType<typeof parse>> {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port: litmus.port, path: `/api/runs/${id}/events`, headers: { host: HOST, ...headers }, setHost: false, signal: AbortSignal.timeout(10_000) }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', d => {
        text += d
        first()
      })
      res.on('end', () => ok(parse(text)))
    })
    req.on('error', fail)
    req.end()
  })
}

test('a run started over the API streams its events in order, and its verdicts can be read', async () => {
  const started = await post('/api/runs', { select: ['e2e/passes', 'e2e/fails'], configs: ['fake'] })
  assert.equal(started.status, 202, started.text)
  const { id } = started.json()
  const stream = await events(id)
  const types = stream.map(s => s.event.type)
  assert.equal(types[0], 'run.started')
  assert.equal(types.at(-1), 'run.finished')
  assert.equal(types.filter(t => t === 'trial.finished').length, 4)
  assert.deepEqual(stream.map(s => s.id), stream.map((_, i) => i))
  // Every trial of a case finishes before that case settles.
  for (const s of stream) {
    if (s.event.type !== 'case.settled') continue
    const at = stream.indexOf(s)
    const c = s.event.case
    assert.equal(stream.slice(0, at).filter(x => x.event.type === 'trial.finished' && x.event.key.startsWith(`${c}@`)).length, 2)
  }
  const run = await call('GET', `/api/runs/${id}`)
  assert.deepEqual(run.json().verdicts.map((v: { case: string; verdict: string }) => [v.case, v.verdict]), [['e2e/fails', 'FAIL'], ['e2e/passes', 'PASS']])
  // A client that reconnects with Last-Event-ID gets only what it missed.
  const rest = await events(id, { 'last-event-id': String(stream.length - 2) })
  assert.deepEqual(rest.map(s => s.id), [stream.length - 1])
})

test('a live subscriber gets the backlog first, and a cancel ends the run cancelled', async () => {
  const { id } = (await post('/api/runs', { select: ['e2e/slow'], configs: ['fake'] })).json()
  const first = Promise.withResolvers<void>()
  const streaming = subscribe(id, first.resolve)
  await first.promise // subscribed, and the backlog has arrived: this is the live path
  assert.equal(litmus.stats().subscribers, 1)
  const cancel = await post(`/api/runs/${id}/cancel`)
  assert.equal(cancel.status, 202, cancel.text)
  const stream = await streaming
  assert.equal(stream[0]!.event.type, 'run.started')
  assert.equal(stream.at(-1)!.event.type, 'run.cancelled')
  assert.equal((await call('GET', `/api/runs/${id}`)).json().manifest.status, 'cancelled')
  assert.equal((await post(`/api/runs/${id}/cancel`)).status, 409)
})

test('a bad Host is refused on every route, whatever the method', async () => {
  for (const host of ['evil.example', `evil.example:${litmus.port}`, '127.0.0.1', `127.0.0.1:${litmus.port + 1}`, '']) {
    for (const [method, path] of [['GET', '/api/runs'], ['GET', '/'], ['POST', '/api/runs']] as const) {
      const r = await call(method, path, { headers: { host, origin: ORIGIN }, ...(method === 'POST' ? { body: { select: ['e2e/passes'], configs: ['fake'] } } : {}) })
      assert.equal(r.status, 403, `${method} ${path} Host ${JSON.stringify(host)}`)
    }
  }
  assert.equal((await call('GET', '/api/runs', { headers: { host: `localhost:${litmus.port}` } })).status, 200)
})

test('a request that changes state needs this server as its Origin', async () => {
  const body = { select: ['e2e/passes'], configs: ['fake'] }
  for (const origin of [undefined, 'http://evil.example', `https://${HOST}`, 'null', `http://127.0.0.1:${litmus.port + 1}`]) {
    const headers: Record<string, string> = origin === undefined ? {} : { origin }
    assert.equal((await call('POST', '/api/runs', { headers, body })).status, 403, `POST Origin ${origin}`)
    assert.equal((await call('PUT', '/api/baselines/main', { headers, body: { run: '2026-01-01T00-00-00Z-ffff' } })).status, 403, `PUT Origin ${origin}`)
  }
  assert.equal((await post('/api/runs', body, `http://localhost:${litmus.port}`)).status, 202)
})

test('no response carries a CORS header, and every one says nosniff', async () => {
  for (const r of [await call('GET', '/api/runs', { headers: { origin: 'http://evil.example' } }), await call('GET', '/'), await call('GET', '/api/nope'), await call('GET', '/api/runs', { headers: { host: 'evil.example' } })]) {
    assert.deepEqual(Object.keys(r.headers).filter(h => h.startsWith('access-control-')), [])
    assert.equal(r.headers['x-content-type-options'], 'nosniff')
  }
})

test('a trial is read by its percent-encoded key, with its transcript and artifacts, redacted', async () => {
  const { id } = (await post('/api/runs', { select: ['e2e/passes'], configs: ['fake'] })).json()
  await events(id)
  const key = 'e2e/passes@fake#1'
  const r = await call('GET', `/api/runs/${id}/trial?key=${encodeURIComponent(key)}`)
  assert.equal(r.status, 200, r.text)
  const t = r.json()
  assert.equal(t.record.key, key)
  assert.ok(t.transcript.length > 0)
  assert.deepEqual(t.artifacts.map((a: { name: string }) => a.name), ['response.txt'])
  assert.ok(!r.text.includes(KEY))
  assert.match(t.artifacts[0].text, /LGTM \[REDACTED\]/)
  // Unencoded, the '#' starts a fragment and the key never arrives whole.
  assert.equal((await call('GET', `/api/runs/${id}/trial?key=${key}`)).status, 400)
  assert.equal((await call('GET', `/api/runs/${id}/trial?key=${encodeURIComponent('e2e/passes@fake#9')}`)).status, 404)
  assert.equal((await call('GET', `/api/runs/not-a-run/trial?key=${encodeURIComponent(key)}`)).status, 400)
})

test('compare, baselines, suites and configs answer as the CLI would', async () => {
  const a = (await post('/api/runs', { select: ['e2e/passes'], configs: ['fake'] })).json().id
  await events(a)
  const b = (await post('/api/runs', { select: ['e2e/passes'], configs: ['fake'] })).json().id
  await events(b)
  const cmp = await call('GET', `/api/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(`${b}:fake`)}`)
  assert.equal(cmp.status, 200, cmp.text)
  assert.equal(cmp.json().cases, 1)
  assert.equal((await call('GET', '/api/compare?a=nope')).status, 400)

  assert.equal((await call('PUT', '/api/baselines/main', { headers: { origin: ORIGIN }, body: { run: a } })).status, 200)
  assert.equal((await call('GET', `/api/compare?a=baseline:main&b=${b}`)).status, 200)
  assert.equal((await call('PUT', '/api/baselines/Bad:Name', { headers: { origin: ORIGIN }, body: { run: a } })).status, 400)

  const suites = (await call('GET', '/api/suites')).json()
  assert.deepEqual(suites[0].cases.find((c: { id: string }) => c.id === 'e2e/passes').latest, { fake: 'PASS' })
  const configs = await call('GET', '/api/configs')
  assert.deepEqual(Object.keys(configs.json().configs), ['fake', 'fake-b'])
  assert.equal(configs.json().configs['fake-b'].model, 'm-[REDACTED]')
  assert.ok(!configs.text.includes(KEY) && !configs.text.includes(TOKEN))
})

test('a bad request body is a 400 or 415, and a rerun with nothing to do says so', async () => {
  assert.equal((await post('/api/runs', { select: ['e2e/nope'], configs: ['fake'] })).status, 400)
  assert.equal((await post('/api/runs', { select: ['e2e/passes'] })).status, 400) // two configs, none named
  assert.equal((await post('/api/runs', { select: 'e2e/passes', configs: ['fake'] })).status, 400)
  assert.equal((await post('/api/runs', { select: [], configs: ['fake'], extra: 1 })).status, 400)
  assert.equal((await call('POST', '/api/runs', { headers: { origin: ORIGIN, 'content-type': 'text/plain' } })).status, 415)
  const { id } = (await post('/api/runs', { select: ['e2e/passes'], configs: ['fake'] })).json()
  await events(id)
  const nothing = await post('/api/runs', { rerun: { run: id, only: ['FAIL'] } })
  assert.deepEqual([nothing.status, nothing.json()], [202, { id: null, message: `nothing to rerun: run ${id} has no FAIL verdict` }])
})

test('the UI is served from its directory, any other path gets index.html, and nothing outside it is reachable', async () => {
  const js = await call('GET', '/app.js')
  assert.deepEqual([js.status, js.headers['content-type'], js.text], [200, 'text/javascript; charset=utf-8', 'console.log(1)'])
  const route = await call('GET', '/runs/some-run')
  assert.deepEqual([route.status, route.text], [200, '<!doctype html><title>ui</title>'])
  // Refused outright, or normalized by the URL parser into a path inside the
  // UI (index.html): never the file two levels up.
  for (const path of ['/..%2f..%2flitmus.config.yaml', '/%2e%2e/litmus.config.yaml', '/%2e%2e%2f%2e%2e%2flitmus.config.yaml', '/a%00b', '/../../litmus.config.yaml']) {
    const r = await call('GET', path)
    assert.ok(r.status === 400 || r.text === '<!doctype html><title>ui</title>', `${path}: ${r.status} ${r.text}`)
  }
  assert.equal((await call('GET', '/..%2f..%2flitmus.config.yaml')).status, 400)
  assert.equal((await post('/index.html')).status, 405)
  assert.match((await call('GET', '/')).headers['content-security-policy'] as string, /frame-ancestors 'none'/)
})

test('a finished run\'s stream answers 204 once nothing is left, so an EventSource stops reconnecting', async () => {
  const { id } = (await post('/api/runs', { select: ['e2e/passes'], configs: ['fake'] })).json()
  const all = await events(id)
  const again = await call('GET', `/api/runs/${id}/events`, { headers: { 'last-event-id': String(all.length - 1) } })
  assert.equal(again.status, 204)
  // A Last-Event-ID that is not a plain number is ignored, never read as one.
  for (const bad of ['', ' ', '0x2', '1e1', '-1']) assert.equal((await events(id, { 'last-event-id': bad })).length, all.length, JSON.stringify(bad))
})

test('a client that goes away is dropped from its run\'s stream', async () => {
  const { id } = (await post('/api/runs', { select: ['e2e/slow'], configs: ['fake'] })).json()
  await new Promise<void>((ok, fail) => {
    const req = request({ host: '127.0.0.1', port: litmus.port, path: `/api/runs/${id}/events`, headers: { host: HOST }, setHost: false, signal: AbortSignal.timeout(10_000) }, res => {
      res.once('data', () => {
        req.destroy()
        ok()
      })
      res.once('end', () => fail(new Error('the stream ended before sending anything')))
    })
    req.on('error', e => (e as NodeJS.ErrnoException).code === 'ECONNRESET' || fail(e))
    req.end()
  })
  for (let i = 0; i < 50 && litmus.stats().subscribers > 0; i++) await new Promise(r => setTimeout(r, 10))
  assert.equal(litmus.stats().subscribers, 0)
  assert.equal((await post(`/api/runs/${id}/cancel`)).status, 202)
  assert.equal((await events(id)).at(-1)!.event.type, 'run.cancelled')
})

test('an artifact outside the trial, even through a linked directory, is missing; one too big is only its size', async () => {
  const { id } = (await post('/api/runs', { select: ['e2e/passes'], configs: ['fake'] })).json()
  await events(id)
  const key = 'e2e/passes@fake#1'
  const dir = join(ROOT, '.litmus/runs', id, 'trials/e2e/passes/fake/1')
  mkdirSync(join(ROOT, 'elsewhere'), { recursive: true })
  writeFileSync(join(ROOT, 'elsewhere/leak.txt'), 'OUTSIDE')
  symlinkSync(join(ROOT, 'elsewhere'), join(dir, 'artifacts/sub'))
  writeFileSync(join(dir, 'artifacts/big.bin'), Buffer.alloc(9 << 20))
  const record = JSON.parse(readFileSync(join(dir, 'trial.json'), 'utf8'))
  writeFileSync(join(dir, 'trial.json'), JSON.stringify({ ...record, artifacts: [...record.artifacts, '../trial.json', 'sub/leak.txt', 'big.bin'] }))
  const r = await call('GET', `/api/runs/${id}/trial?key=${encodeURIComponent(key)}`)
  const by = Object.fromEntries(r.json().artifacts.map((a: { name: string }) => [a.name, a]))
  assert.deepEqual(by['../trial.json'], { name: '../trial.json', missing: true })
  assert.deepEqual(by['sub/leak.txt'], { name: 'sub/leak.txt', missing: true })
  assert.deepEqual(by['big.bin'], { name: 'big.bin', size: 9 << 20, truncated: true })
  assert.ok(!r.text.includes('OUTSIDE'))
})

test('close() returns even with a client stuck mid-request', async () => {
  const other = await serve({ configFile: join(ROOT, 'litmus.config.yaml'), port: 0, uiDir: join(ROOT, 'ui'), env: {} })
  const req = request({ host: '127.0.0.1', port: other.port, method: 'POST', path: '/api/runs', headers: { host: `127.0.0.1:${other.port}`, origin: `http://127.0.0.1:${other.port}`, 'content-type': 'application/json', 'content-length': '200000' }, setHost: false })
  req.on('error', () => undefined) // the server drops it: that is the point
  req.write(Buffer.alloc(100_000, 0x20)) // half the body it promised, then nothing
  await new Promise(r => setTimeout(r, 100))
  try {
    await Promise.race([other.close(), new Promise((_, no) => setTimeout(() => no(new Error('close() hung on a stuck client')), 3000))])
  } finally {
    req.destroy()
  }
})

test('a pipelined request behind a live stream still gets its answer when the stream ends', async () => {
  const { id } = (await post('/api/runs', { select: ['e2e/slow'], configs: ['fake'] })).json()
  const socket = connect(litmus.port, '127.0.0.1')
  socket.setTimeout(10_000, () => socket.destroy(new Error('no answer to the queued request')))
  let text = ''
  const got404 = new Promise<void>((ok, fail) => {
    socket.on('data', d => {
      text += d
      if (/HTTP\/1\.1 404/.test(text)) ok()
    })
    socket.on('error', fail)
  })
  socket.write(`GET /api/runs/${id}/events HTTP/1.1\r\nHost: ${HOST}\r\n\r\nGET /api/nope HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`)
  await new Promise(r => setTimeout(r, 100))
  await post(`/api/runs/${id}/cancel`)
  await got404
  socket.destroy()
})

test('a body over the limit is a 413 that closes its connection', async () => {
  // One byte past the limit, then silence: a client still writing races the
  // close (EPIPE, or a reset that can drop the 413), so nothing is left unsent.
  const socket = connect(litmus.port, '127.0.0.1')
  socket.setTimeout(10_000, () => socket.destroy(new Error('no 413, or the connection stayed open')))
  const reply = new Promise<string>((ok, fail) => {
    let text = ''
    socket.on('data', d => (text += d))
    socket.on('end', () => ok(text))
    socket.on('error', fail)
  })
  socket.write(`POST /api/runs HTTP/1.1\r\nHost: ${HOST}\r\nOrigin: ${ORIGIN}\r\nContent-Type: application/json\r\nContent-Length: ${(1 << 20) + 2}\r\n\r\n`)
  socket.write(Buffer.alloc((1 << 20) + 1, 0x20))
  const text = await reply
  socket.destroy()
  assert.match(text, /^HTTP\/1\.1 413 /)
  assert.match(text, /\r\nconnection: close\r\n/i)
})

test('a transcript over 64 MiB comes back empty and says so', async () => {
  const { id } = (await post('/api/runs', { select: ['e2e/passes'], configs: ['fake'] })).json()
  await events(id)
  writeFileSync(join(ROOT, '.litmus/runs', id, 'trials/e2e/passes/fake/1/transcript.jsonl'), Buffer.alloc((64 << 20) + 1, 0x61))
  const t = (await call('GET', `/api/runs/${id}/trial?key=${encodeURIComponent('e2e/passes@fake#1')}`)).json()
  assert.deepEqual([t.transcript, t.transcript_truncated], [[], true])
})

test('a run is planned against the server\'s environment, so its credential check sees the server\'s keys', async () => {
  const secret = 'sk-ant-only-in-the-server-env-1234'
  const root = tree({
    // Only the real config holds the value; the run itself would use fake.
    'litmus.config.yaml': `suites: [./suites]\nresults: ./.litmus/runs\nconfigs:\n  fake: { provider: fake }\n  real: { provider: anthropic, model: m, params: { note: "${secret}" } }\n`,
    'suites/e2e/suite.yaml': 'name: e2e\n',
    'suites/e2e/cases/c/case.yaml': 'name: c\nexecutor: { kind: model, prompt: hi }\ngraders: [{ kind: regex, target: response.txt, pattern: x }]\n',
    'suites/e2e/cases/c/fake.yaml': 'responses: [{ text: x }]\n',
  })
  const other = await serve({ configFile: join(root, 'litmus.config.yaml'), port: 0, env: { ANTHROPIC_API_KEY: secret } })
  try {
    const r = await fetch(`${other.url}/api/runs`, { method: 'POST', headers: { origin: other.url, 'content-type': 'application/json' }, body: JSON.stringify({ select: [], configs: ['fake'] }), signal: AbortSignal.timeout(10_000) })
    assert.equal(r.status, 400)
    assert.match(((await r.json()) as { error: string }).error, /real\.params\.note holds the value of a credential variable/)
  } finally {
    await other.close()
  }
})

test('a live subscriber that reconnects with Last-Event-ID gets only what it missed', async () => {
  const { id } = (await post('/api/runs', { select: ['e2e/slow'], configs: ['fake'] })).json()
  const first = Promise.withResolvers<void>()
  const all = subscribe(id, first.resolve)
  await first.promise
  const again = Promise.withResolvers<void>()
  const rest = subscribe(id, again.resolve, { 'last-event-id': '0' })
  await again.promise
  await post(`/api/runs/${id}/cancel`)
  const [full, missed] = await Promise.all([all, rest])
  assert.equal(full[0]!.id, 0)
  assert.equal(missed[0]!.id, 1)
  assert.deepEqual(missed.map(e => e.id), full.slice(1).map(e => e.id))
})

test('close() cancels a live run and waits for it to be written', async () => {
  // An executor slow to honour the cancel: close() must wait for the record anyway.
  const slow: Executor = job => new Promise(ok => job.signal.addEventListener('abort', () => setTimeout(() => {
    mkdirSync(dirname(job.out.transcript), { recursive: true })
    writeFileSync(job.out.transcript, '')
    ok({ exit: 'cancelled', artifacts: {}, transcript: job.out.transcript, usage: { input_tokens: 0, output_tokens: 0 }, wall_clock_ms: 1 })
  }, 300)))
  const other = await serve({ configFile: join(ROOT, 'litmus.config.yaml'), port: 0, uiDir: join(ROOT, 'ui'), env: {}, runSeams: { backoffMs: () => 0, executors: { model: slow } } })
  const r = await fetch(`${other.url}/api/runs`, { method: 'POST', headers: { origin: other.url, 'content-type': 'application/json' }, body: JSON.stringify({ select: ['e2e/slow'], configs: ['fake'] }), signal: AbortSignal.timeout(10_000) })
  const { id } = (await r.json()) as { id: string }
  await Promise.race([other.close(), new Promise((_, no) => setTimeout(() => no(new Error('close() never cancelled the live run')), 5000))])
  const dir = join(ROOT, '.litmus/runs', id)
  assert.equal(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).status, 'cancelled')
  assert.equal(JSON.parse(readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').at(-1)!).type, 'run.cancelled')
})

test('one response inlines at most 32 MiB of artifact text; the rest are only their size', async () => {
  const { id } = (await post('/api/runs', { select: ['e2e/passes'], configs: ['fake'] })).json()
  await events(id)
  const dir = join(ROOT, '.litmus/runs', id, 'trials/e2e/passes/fake/1')
  const names = ['a1.txt', 'a2.txt', 'a3.txt', 'a4.txt', 'a5.txt']
  for (const n of names) writeFileSync(join(dir, 'artifacts', n), Buffer.alloc((8 << 20) - 1, 0x61))
  const record = JSON.parse(readFileSync(join(dir, 'trial.json'), 'utf8'))
  writeFileSync(join(dir, 'trial.json'), JSON.stringify({ ...record, artifacts: names }))
  const r = await call('GET', `/api/runs/${id}/trial?key=${encodeURIComponent('e2e/passes@fake#1')}`)
  assert.equal(r.status, 200)
  const got = r.json().artifacts as { name: string; text?: string; truncated?: true }[]
  assert.deepEqual(got.map(a => [a.name, a.text?.length, a.truncated]), [...names.slice(0, 4).map(n => [n, (8 << 20) - 1, undefined]), ['a5.txt', undefined, true]])
})

test('an error the server reports is redacted, even a YAML error quoting a key', async () => {
  const root = tree({
    'litmus.config.yaml': 'suites: [./suites]\nresults: ./.litmus/runs\nconfigs:\n  fake: { provider: fake }\n',
    'suites/e2e/suite.yaml': 'name: e2e\n',
  })
  const other = await serve({ configFile: join(root, 'litmus.config.yaml'), port: 0, uiDir: join(ROOT, 'ui'), env: { ANTHROPIC_API_KEY: KEY } })
  try {
    writeFileSync(join(root, 'litmus.config.yaml'), `suites: [./suites]\nresults: ./.litmus/runs\nconfigs:\n  fake: { provider: fake, model: "${KEY}" : bad }\n`)
    const r = await fetch(`${other.url}/api/suites`, { signal: AbortSignal.timeout(10_000) })
    const text = await r.text()
    assert.equal(r.status, 400)
    assert.ok(text.includes('[REDACTED]') && !text.includes(KEY), text)
  } finally {
    await other.close()
  }
})

test('the artifact budget counts what text costs in the response, where a control byte is six characters', async () => {
  const { id } = (await post('/api/runs', { select: ['e2e/passes'], configs: ['fake'] })).json()
  await events(id)
  const dir = join(ROOT, '.litmus/runs', id, 'trials/e2e/passes/fake/1')
  // 6 MiB of control bytes is 36 MiB in JSON: past the budget on its own.
  writeFileSync(join(dir, 'artifacts', 'ctl.txt'), Buffer.alloc(6 << 20, 0x01))
  writeFileSync(join(dir, 'artifacts', 'next.txt'), 'small')
  const record = JSON.parse(readFileSync(join(dir, 'trial.json'), 'utf8'))
  writeFileSync(join(dir, 'trial.json'), JSON.stringify({ ...record, artifacts: ['ctl.txt', 'next.txt'] }))
  const r = await call('GET', `/api/runs/${id}/trial?key=${encodeURIComponent('e2e/passes@fake#1')}`)
  const got = r.json().artifacts as { name: string; text?: string; truncated?: true }[]
  assert.deepEqual(got.map(a => [a.name, a.text?.length, a.truncated]), [['ctl.txt', 6 << 20, undefined], ['next.txt', undefined, true]])
})

test('an error quotes a redact value redacted even after the config broke while the server ran', async () => {
  const root = tree({
    'litmus.config.yaml': 'suites: [./suites]\nresults: ./.litmus/runs\nredact: [MY_TOKEN]\nconfigs:\n  fake: { provider: fake }\n',
    'suites/e2e/suite.yaml': 'name: e2e\n',
  })
  const other = await serve({ configFile: join(root, 'litmus.config.yaml'), port: 0, uiDir: join(ROOT, 'ui'), env: { MY_TOKEN: TOKEN } })
  try {
    writeFileSync(join(root, 'litmus.config.yaml'), `suites: [./suites]\nresults: ./.litmus/runs\nredact: [MY_TOKEN]\nconfigs:\n  fake: { provider: fake, model: "${TOKEN}" : bad }\n`)
    const r = await fetch(`${other.url}/api/configs`, { signal: AbortSignal.timeout(10_000) })
    const text = await r.text()
    assert.equal(r.status, 400)
    assert.ok(text.includes('[REDACTED]') && !text.includes(TOKEN), text)
  } finally {
    await other.close()
  }
})
