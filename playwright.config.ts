import { defineConfig } from '@playwright/test'

// Ports are injected by tests/e2e.test.ts as TEST_VITE_PORT / TEST_WS_PORT.
// Each bun test run allocates unique OS-assigned ports so concurrent runs
// (e.g. two coding agents) never collide.  Fallbacks let you run
// `playwright test` directly for one-off debugging (uses fixed ports).
const vitePort = parseInt(process.env.TEST_VITE_PORT ?? '4322')
const wsPort   = parseInt(process.env.TEST_WS_PORT   ?? '7682')

export default defineConfig({
  testDir: './tests',
  // .pw.ts extension keeps Playwright tests invisible to bun's test runner,
  // which scans *.spec.ts / *.test.ts. bun test runs tests/e2e.test.ts instead.
  testMatch: '**/*.pw.ts',
  // One worker: the WS server holds shared session state, so parallel
  // tests would race on the same sessions. Fast enough for this suite.
  workers: 1,
  // No retries in CI — flaky tests should be fixed, not hidden.
  retries: 0,
  // Most tests finish in <1.5s; 15s catches hangs without wasting time.
  timeout: 15_000,
  use: {
    baseURL: `http://localhost:${vitePort}`,
    headless: true,
    // Fast: no video, no screenshots, no traces unless a test fails.
    video: 'off',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: {
    // SHELL=/bin/bash: tests must not depend on the user's interactive shell
    // config (.zshrc plugins, slow DNS lookups, etc.). Bash starts instantly.
    command: `concurrently -n server,vite -c cyan,magenta "SHELL=/bin/bash PORT=${wsPort} bun run --hot server.ts" "VITE_PORT=${vitePort} WS_PORT=${wsPort} vite"`,
    url: `http://localhost:${vitePort}`,
    reuseExistingServer: false,
    timeout: 20_000,
    // Suppress server output during test runs.
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
