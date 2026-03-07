import { expect, test } from "bun:test";
import { normalizeSessionHotReloadState } from "./serverSessionState";

test("normalizeSessionHotReloadState backfills fields added after hot reload", () => {
  const session: {
    shell: string;
    shellControlRemainder?: string;
    shellTracksCwd?: boolean;
  } = {
    shell: "C:/Program Files/Git/bin/bash.exe",
  };

  expect(normalizeSessionHotReloadState(session, true)).toBe(true);
  expect(session.shellControlRemainder).toBe("");
  expect(session.shellTracksCwd).toBe(true);
});

test("normalizeSessionHotReloadState preserves current session fields", () => {
  const session = {
    shell: "/bin/zsh",
    shellControlRemainder: "leftover",
    shellTracksCwd: false,
  };

  expect(normalizeSessionHotReloadState(session, true)).toBe(false);
  expect(session.shellControlRemainder).toBe("leftover");
  expect(session.shellTracksCwd).toBe(false);
});
