import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export const SERVER = 'http://127.0.0.1:4317'

// The server takes a POST only from its own origin, so a request from the dev
// UI's own page, on a loopback host, has its Origin rewritten to the
// server's. Any other Origin (another local page, or a LAN peer under
// `vite --host`) is passed on as it came, and refused.
export function ownPage(origin: string | undefined, host: string | undefined): boolean {
  return origin !== undefined && host !== undefined && origin === `http://${host}` && /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host)
}

// The UI is a static client of `litmus serve`: built into ui/dist, which the
// server serves, and in development proxied to a server on its default port.
// No CORS, as the server sends none: Vite's default would let any localhost
// page read run history through the proxy. Nothing is inlined as a data: URL,
// which the server's Content-Security-Policy would block.
export default defineConfig({
  root: 'ui',
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
  server: {
    cors: false,
    proxy: {
      '/api': {
        target: SERVER,
        changeOrigin: true,
        configure: proxy =>
          proxy.on('proxyReq', (out, req) => {
            if (ownPage(req.headers.origin, req.headers.host)) out.setHeader('origin', SERVER)
          }),
      },
    },
  },
  preview: { cors: false },
})
