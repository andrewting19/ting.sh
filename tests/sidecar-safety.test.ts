import { expect, test } from 'bun:test'

type RunningServer = {
  proc: ReturnType<typeof Bun.spawn>
  baseUrl: string
}

async function getFreePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = server.port
  await server.stop()
  return port
}

async function waitForReady(baseUrl: string, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 15_000
  let lastError: unknown = null

  while (Date.now() < deadline) {
    if (proc.exitCode != null) {
      throw new Error(`server exited early with code ${proc.exitCode}`)
    }
    try {
      const res = await fetch(`${baseUrl}/api/version`)
      if (res.ok) return
      lastError = new Error(`unexpected readiness status ${res.status}`)
    } catch (err) {
      lastError = err
    }
    await Bun.sleep(50)
  }

  throw new Error(`timed out waiting for server readiness: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function spawnServer(enableRestart: boolean): Promise<RunningServer> {
  const serverPort = await getFreePort()
  const ptydPort = await getFreePort()
  const proc = Bun.spawn([process.execPath, 'run', 'server.ts'], {
    cwd: import.meta.dir + '/..',
    stdout: 'ignore',
    stderr: 'ignore',
    env: {
      ...process.env,
      AUTO_UPDATE: 'false',
      HOSTS_FILE: 'none',
      PTYD_AUTOSPAWN: 'false',
      PTYD_PORT: String(ptydPort),
      TING_ENABLE_SIDECAR_RESTART: enableRestart ? '1' : '0',
      TING_PORT: String(serverPort),
      TING_TEST_MODE: '1',
      TING_WS_PORT: String(serverPort),
    },
  })

  const baseUrl = `http://127.0.0.1:${serverPort}`
  await waitForReady(baseUrl, proc)
  return { proc, baseUrl }
}

async function stopServer(running: RunningServer): Promise<void> {
  try {
    running.proc.kill()
  } catch {
    // ignore shutdown errors
  }
  try {
    await running.proc.exited
  } catch {
    // ignore exit errors
  }
}

test('sidecar restart is disabled unless explicitly enabled', async () => {
  const running = await spawnServer(false)
  try {
    const res = await fetch(`${running.baseUrl}/api/sidecar/restart`, { method: 'POST' })
    expect(res.status).toBe(403)
    const body = await res.text()
    expect(body).toContain('TING_ENABLE_SIDECAR_RESTART')
  } finally {
    await stopServer(running)
  }
})

test('sidecar restart becomes available when explicitly enabled', async () => {
  const running = await spawnServer(true)
  try {
    const res = await fetch(`${running.baseUrl}/api/sidecar/restart`, { method: 'POST' })
    expect(res.status).not.toBe(403)
    const body = await res.text()
    expect(body.length).toBeGreaterThan(0)
  } finally {
    await stopServer(running)
  }
})
