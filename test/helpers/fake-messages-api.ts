import { createServer, type Server } from 'node:http'

// A local stand-in for the Messages API that Claude Code talks to: it plays a
// scripted model and records every request body. $0, and it never leaves
// 127.0.0.1. A turn is the content blocks of one assistant reply; once the
// script runs out, the model says "done".
export type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }
export type Script = { main: Block[][]; sub?: Block[][]; isSub?: (body: Record<string, unknown>) => boolean }

export async function fakeMessagesApi(script: Script): Promise<{ url: string; bodies: Record<string, unknown>[]; auths: string[]; close: () => Promise<void> }> {
  const bodies: Record<string, unknown>[] = []
  // Each request's path and how it authenticated: `/v1/messages bearer <token>`, `... key <key>` or `... none`.
  const auths: string[] = []
  const at = { main: 0, sub: 0 }
  const server: Server = createServer((req, res) => {
    let data = ''
    req.on('data', c => (data += c))
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(data) as Record<string, unknown>
      } catch {
        // a request with no body is still answered
      }
      bodies.push(body)
      const bearer = req.headers['authorization']
      const key = req.headers['x-api-key']
      const how = typeof bearer === 'string' ? `bearer ${bearer.replace(/^Bearer /, '')}` : typeof key === 'string' ? `key ${key}` : 'none'
      auths.push(`${String(req.url).split('?')[0]} ${how}`)
      if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ input_tokens: 10 }))
      }
      // Side requests (titles, summaries) carry no tools; only the agent loop is scripted.
      const loop = Array.isArray(body['tools']) && (body['tools'] as unknown[]).length > 0
      const sub = loop && script.isSub?.(body) === true
      const turns = sub ? (script.sub ?? []) : script.main
      const i = !loop ? Infinity : sub ? at.sub++ : at.main++
      const blocks: Block[] = turns[i] ?? [{ type: 'text', text: 'done' }]
      const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
      const usage = { input_tokens: 10, output_tokens: 5 }
      if (!body['stream']) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ id: 'msg_fake', type: 'message', role: 'assistant', model: body['model'], content: blocks, stop_reason: stop, stop_sequence: null, usage }))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const ev = (type: string, d: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`)
      ev('message_start', { message: { id: `msg_${bodies.length}`, type: 'message', role: 'assistant', model: body['model'], content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
      blocks.forEach((b, index) => {
        if (b.type === 'text') {
          ev('content_block_start', { index, content_block: { type: 'text', text: '' } })
          ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } })
        } else {
          ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
          ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })
        }
        ev('content_block_stop', { index })
      })
      ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } })
      ev('message_stop', {})
      res.end()
    })
  })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, bodies, auths, close: () => new Promise(ok => server.close(() => ok())) }
}
