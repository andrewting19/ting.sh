export interface PendingReplayAttachState {
  timer: ReturnType<typeof setTimeout> | null;
}

export interface SessionHotReloadState<TClient = unknown> {
  shell: string;
  pendingClients?: Map<TClient, PendingReplayAttachState>;
  shellControlRemainder?: string;
  shellTracksCwd?: boolean;
}

// Sessions survive Bun --hot reloads via globalThis, so newly added fields must
// be backfilled before the next code version starts touching them.
export function normalizeSessionHotReloadState<TClient>(
  session: SessionHotReloadState<TClient>,
  defaultShellTracksCwd: boolean,
): boolean {
  let changed = false;

  if (!(session.pendingClients instanceof Map)) {
    session.pendingClients = new Map<TClient, PendingReplayAttachState>();
    changed = true;
  }
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
