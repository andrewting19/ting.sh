import { expect, test } from "bun:test";
import { normalizeSessionHotReloadState } from "./serverSessionState";

test("normalizeSessionHotReloadState backfills fields added after hot reload", () => {
  const session: {
    shell: string;
    pendingClients?: Map<string, { timer: ReturnType<typeof setTimeout> | null }>;
    shellControlRemainder?: string;
    shellTracksCwd?: boolean;
  } = {
    shell: "C:/Program Files/Git/bin/bash.exe",
  };

  expect(normalizeSessionHotReloadState(session, true)).toBe(true);
  expect(session.pendingClients).toBeInstanceOf(Map);
  expect(session.pendingClients?.size).toBe(0);
  expect(session.shellControlRemainder).toBe("");
  expect(session.shellTracksCwd).toBe(true);
});

test("normalizeSessionHotReloadState preserves current session fields", () => {
  const pendingClients = new Map<string, { timer: ReturnType<typeof setTimeout> | null }>([
    ["ws-1", { timer: null }],
  ]);
  const session = {
    shell: "/bin/zsh",
    pendingClients,
    shellControlRemainder: "leftover",
    shellTracksCwd: false,
  };

  expect(normalizeSessionHotReloadState(session, true)).toBe(false);
  expect(session.pendingClients).toBe(pendingClients);
  expect(session.shellControlRemainder).toBe("leftover");
  expect(session.shellTracksCwd).toBe(false);
});
