import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  // One worker: the WS server holds shared session state, so parallel
  // tests would race on the same sessions. Fast enough for this suite.
  workers: 1,
  // No retries in CI — flaky tests should be fixed, not hidden.
  retries: 0,
  use: {
    baseURL: 'http://localhost:4322',
    headless: true,
    // Fast: no video, no screenshots, no traces unless a test fails.
    video: 'off',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: {
    // Separate ports (4322 / 7682) so test server never collides with the
    // real dev server running on 4321 / 7681.
    command: 'concurrently -n server,vite -c cyan,magenta "PORT=7682 bun run --hot server.ts" "VITE_PORT=4322 WS_PORT=7682 vite"',
    url: 'http://localhost:4322',
    // Re-use if already running (e.g. from a previous test run that didn't
    // clean up), but don't re-use the *real* dev server on 4321.
    reuseExistingServer: false,
    timeout: 20_000,
    // Suppress server output during test runs.
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
