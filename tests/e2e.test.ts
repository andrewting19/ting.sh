/**
 * Bun test wrapper for the Playwright E2E suite.
 *
 * `bun test` only discovers *.test.ts and *.spec.ts files. The actual
 * Playwright tests live in *.pw.ts files (invisible to bun's scanner).
 * This file is what bun test finds; it spawns `playwright test` as a
 * subprocess so the full E2E suite runs with proper output streaming.
 */
import { test } from 'bun:test'

// Ask the OS for two free ports by binding to :0.  Each bun test run gets
// its own unique port pair, so concurrent agents never collide and orphaned
// servers from a previous Ctrl+C don't interfere (they're on different ports).
async function getFreePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = server.port
  await server.stop()
  return port
}
const vitePort = await getFreePort()
const wsPort   = await getFreePort()
// Let the OS fully release the sockets before Playwright binds them.
await Bun.sleep(50)

test('e2e suite', async () => {
  const root = import.meta.dir + '/..'
  const proc = Bun.spawn(
    ['./node_modules/.bin/playwright', 'test'],
    {
      stdout: 'inherit',
      stderr: 'inherit',
      cwd: root,
      env: {
        ...process.env,
        // node_modules/.bin must be in PATH so playwright's webServer command
        // can find concurrently (and any other local binaries it invokes).
        PATH: `${root}/node_modules/.bin:${process.env.PATH}`,
        TEST_VITE_PORT: String(vitePort),
        TEST_WS_PORT:   String(wsPort),
      },
    },
  )
  const exitCode = await proc.exited
  if (exitCode !== 0) throw new Error(`Playwright exited with code ${exitCode}`)
}, 180_000) // 3 min — generous for CI/slow machines
