import { defineConfig, devices } from '@playwright/test'

// `npm run test:ui`: the built UI against `litmus serve` over the fake suites
// in test/ui/e2e/project. One worker, in order: the tests share one server
// and its run history.
const port = 4318

export default defineConfig({
  testDir: 'test/ui/e2e',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure', ...devices['Desktop Chrome'], viewport: { width: 1400, height: 860 } },
  webServer: {
    command: 'npm run ui:build && node test/ui/e2e/serve.ts',
    url: `http://127.0.0.1:${port}/api/configs`,
    env: { LITMUS_UI_PORT: String(port) },
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
