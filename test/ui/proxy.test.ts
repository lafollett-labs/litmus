import { test } from 'node:test'
import assert from 'node:assert/strict'
import config, { ownPage, SERVER } from '../../vite.config.ts'

// `npm run ui:dev`'s proxy: the dev page's own requests reach the server with
// the server's Origin, and nothing else does; and no CORS, as the server sends none.
test('only the dev page on a loopback host gets the server\'s Origin', () => {
  assert.equal(ownPage('http://localhost:5173', 'localhost:5173'), true)
  assert.equal(ownPage('http://127.0.0.1:5173', '127.0.0.1:5173'), true)
  assert.equal(ownPage('http://localhost:3000', 'localhost:5173'), false) // another local page
  assert.equal(ownPage('http://192.168.1.50:5173', '192.168.1.50:5173'), false) // a LAN peer under --host
  assert.equal(ownPage(undefined, 'localhost:5173'), false)
})

test('the proxy rewrites the Origin of the dev page\'s requests only, and CORS is off', () => {
  const proxyConfig = (config.server!.proxy as Record<string, { configure: (p: unknown) => void }>)['/api']!
  let handler: ((out: { setHeader: (k: string, v: string) => void }, req: { headers: Record<string, string> }) => void) | undefined
  proxyConfig.configure({ on: (_event: string, h: typeof handler) => (handler = h) })
  const sent = (headers: Record<string, string>) => {
    const set: Record<string, string> = {}
    handler!({ setHeader: (k, v) => (set[k] = v) }, { headers })
    return set
  }
  assert.deepEqual(sent({ origin: 'http://localhost:5173', host: 'localhost:5173' }), { origin: SERVER })
  assert.deepEqual(sent({ origin: 'http://localhost:3000', host: 'localhost:5173' }), {})
  assert.equal(config.server!.cors, false)
  assert.equal(config.preview!.cors, false)
})
