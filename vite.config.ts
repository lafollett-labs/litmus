import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const SERVER = 'http://127.0.0.1:4317'

// The UI is a static client of `litmus serve`: built into ui/dist, which the
// server serves, and in development proxied to a server on its default port.
// The server takes a POST only from its own origin, so a request from the dev
// UI's own page has its Origin rewritten to the server's; any other Origin is
// passed on as it came, and refused. Nothing is inlined as a data: URL, which
// the server's Content-Security-Policy would block.
export default defineConfig({
  root: 'ui',
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
  server: {
    proxy: {
      '/api': {
        target: SERVER,
        changeOrigin: true,
        configure: proxy =>
          proxy.on('proxyReq', (out, req) => {
            if (req.headers.origin !== undefined && req.headers.origin === `http://${req.headers.host}`) out.setHeader('origin', SERVER)
          }),
      },
    },
  },
})
