import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const SIDEcar_RUNTIME_FILES = [
  "ptyd.ts",
  "src/sidecarConfig.ts",
  "src/pty.ts",
  "src/pty-unix.ts",
  "src/pty-windows.ts",
  "src/windowsShellIntegration.ts",
  "src/sessionNames.ts",
  "src/snapshot/liveTail.ts",
  "src/snapshot/xtermVtSnapshot.ts",
  "src/snapshot/renderedTextSnapshot.ts",
  "src/snapshot/canonicalSnapshot.ts",
] as const;

export interface SidecarRuntimeInfo {
  fingerprint: string;
  fileCount: number;
}

export interface SidecarRuntimeStatus {
  info: SidecarRuntimeInfo | null;
  error: string | null;
}

// Fingerprint reads can fail at runtime even when the files exist — e.g. macOS
// TCC revoking the daemon's ~/Documents access mid-flight (EPERM). Callers that
// must not crash on that use this variant and surface the error instead.
export function tryComputeSidecarRuntimeInfo(cwd = process.cwd()): SidecarRuntimeStatus {
  try {
    const info = computeSidecarRuntimeInfo(cwd);
    if (info.fileCount === 0) {
      return { info: null, error: `no sidecar runtime files readable under ${cwd}` };
    }
    return { info, error: null };
  } catch (err) {
    return { info: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export function computeSidecarRuntimeInfo(cwd = process.cwd()): SidecarRuntimeInfo {
  const hash = createHash("sha256");
  let fileCount = 0;
  for (const rel of SIDEcar_RUNTIME_FILES) {
    const path = resolve(cwd, rel);
    if (!existsSync(path)) continue;
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
    fileCount += 1;
  }
  return {
    fingerprint: hash.digest("hex").slice(0, 16),
    fileCount,
  };
}
