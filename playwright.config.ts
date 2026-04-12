import { defineConfig } from '@playwright/test'

function requirePort(name: string): number {
  const raw = process.env[name]?.trim()
  if (!raw) throw new Error(`${name} is required for Playwright test isolation`)
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`)
  }
  return parsed
}

// Ports are injected by tests/e2e.test.ts. Requiring them keeps Playwright
// from silently falling back to a live/default ting.sh port during bun test.
const vitePort = requirePort('TEST_VITE_PORT')
const wsPort = requirePort('TEST_WS_PORT')
const ptydPort = requirePort('TEST_PTYD_PORT')

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
    // PTYD_PORT is pinned explicitly so an inherited shell env cannot point
    // the test server at a live sidecar. AUTO_UPDATE stays off in tests.
    command: `concurrently -n server,vite -c cyan,magenta "AUTO_UPDATE=false PTYD_AUTOSPAWN=true SHELL=/bin/bash TING_PORT=${wsPort} PTYD_PORT=${ptydPort} HOSTS_FILE=none TING_TEST_MODE=1 bun run --hot server.ts" "VITE_PORT=${vitePort} TING_WS_PORT=${wsPort} vite"`,
    url: `http://localhost:${vitePort}`,
    reuseExistingServer: false,
    timeout: 20_000,
    // Suppress server output during test runs.
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
