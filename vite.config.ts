import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// The UI is a static client of `litmus serve`: built into ui/dist, which the
// server serves, and in development proxied to a server on its default port.
export default defineConfig({
  root: 'ui',
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': { target: 'http://127.0.0.1:4317', changeOrigin: true } } },
})
