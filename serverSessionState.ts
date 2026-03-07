export interface SessionHotReloadState {
  shell: string;
  shellControlRemainder?: string;
  shellTracksCwd?: boolean;
}

// Sessions survive Bun --hot reloads via globalThis, so newly added fields must
// be backfilled before the next code version starts touching them.
export function normalizeSessionHotReloadState(
  session: SessionHotReloadState,
  defaultShellTracksCwd: boolean,
): boolean {
  let changed = false;

  if (typeof session.shellControlRemainder !== "string") {
    session.shellControlRemainder = "";
    changed = true;
  }
  if (typeof session.shellTracksCwd !== "boolean") {
    session.shellTracksCwd = defaultShellTracksCwd;
    changed = true;
  }

  return changed;
}
