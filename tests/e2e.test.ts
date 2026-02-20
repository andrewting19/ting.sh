/**
 * Bun test wrapper for the Playwright E2E suite.
 *
 * `bun test` only discovers *.test.ts and *.spec.ts files. The actual
 * Playwright tests live in *.pw.ts files (invisible to bun's scanner).
 * This file is what bun test finds; it spawns `playwright test` as a
 * subprocess so the full E2E suite runs with proper output streaming.
 *
 * Both `bun test` and `bun run test` now run the same suite.
 */
import { test, expect } from 'bun:test'

// Kill any stale processes on the test ports before Playwright starts.
// Playwright's webServer fails immediately if ports are occupied — this
// happens when a previous run was interrupted (Ctrl+C / crash) before
// Playwright's own cleanup hook fired.  We do this here, in the Bun layer,
// because Playwright starts webServer *before* its own globalSetup hook.
const TEST_PORTS = [4322, 7682]
for (const port of TEST_PORTS) {
  const result = Bun.spawnSync(['sh', '-c', `lsof -t -i :${port} | xargs kill -9 2>/dev/null || true`])
  if (result.exitCode !== 0) {
    // lsof/kill not available — not fatal, Playwright will report port errors
  }
}
// Brief pause so the OS recycles the sockets before Playwright binds them.
await Bun.sleep(150)

test('e2e suite', async () => {
  const root = import.meta.dir + '/..'
  const proc = Bun.spawn(
    ['./node_modules/.bin/playwright', 'test'],
    {
      stdout: 'inherit',
      stderr: 'inherit',
      cwd: root,
      // node_modules/.bin must be in PATH so playwright's webServer command
      // can find concurrently (and any other local binaries it invokes).
      env: { ...process.env, PATH: `${root}/node_modules/.bin:${process.env.PATH}` },
    },
  )
  const exitCode = await proc.exited
  if (exitCode !== 0) throw new Error(`Playwright exited with code ${exitCode}`)
}, 180_000) // 3 min — generous for CI/slow machines
