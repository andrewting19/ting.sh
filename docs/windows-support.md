# Windows Support

## Goal

Feature parity on Windows: a Windows server should behave like a first-class host alongside Unix/macOS hosts, with no frontend special-casing beyond transport/runtime differences.

## Status

As of March 7, 2026:

- PTY abstraction is implemented.
- Windows PTY support is implemented with ConPTY via `node-pty`.
- Windows now prefers Git Bash over `cmd.exe` when Git for Windows is installed.
- Windows live CWD parity is implemented for Git Bash sessions.
- Windows deployment uses `deploy/install.ps1` + NSSM and now bundles a portable Node runtime for the PTY worker.
- Windows auto-update extracts `.zip` releases and now runs `bun install --frozen-lockfile` before restart.
- Phase 5 remains open: Windows CI / Playwright coverage.

## Empirical Findings On `mom`

The `mom` host is the only Windows machine currently available for validation, so it is the source of truth for Windows behavior.

Validated on `mom`:

- OpenSSH `DefaultShell` is `C:\Program Files\Git\bin\bash.exe`.
- The previously deployed service was still defaulting to `cmd.exe`, because the server fell back to `COMSPEC` and the service environment did not provide `SHELL`.
- `node-pty` under Bun on Windows could spawn Git Bash but failed on `write()` with `ERR_SOCKET_CLOSED`.
- `node-pty` under plain Node worked correctly for spawn + write, so the Windows PTY worker remains a Node sidecar.
- After switching the service to the updated code, live validation passed for:
  - session create / attach / input
  - Git Bash default shell
  - live CWD tracking
  - `cd` updates
  - create/duplicate with explicit CWD
  - rename
  - kill
  - bundled-Node worker path

## Architecture

### PTY runtime split

- Unix/macOS: `Bun.spawn(..., { terminal })`
- Windows: `node-pty` ConPTY worker launched through a Node sidecar

The Node sidecar is intentional. On `mom`, direct Bun + `node-pty` could render the initial prompt but failed on `write()`. The sidecar avoids that Bun-on-Windows write-path bug.

### Default shell selection

Windows shell selection now prefers:

1. OpenSSH `DefaultShell` / Git Bash when present
2. common Git for Windows install paths
3. `COMSPEC`
4. `powershell.exe`

This aligns the web terminal with the shell the machine already uses over SSH when possible.

### CWD tracking

Windows cannot use the Unix `/proc/<pid>/cwd` / `lsof` approach, so Git Bash sessions use prompt-based shell integration:

- the server injects a `PROMPT_COMMAND`
- the prompt emits a hidden OSC control frame containing `pwd -W`
- the server strips that control frame from PTY output and updates session `cwd`

This gives Windows the same user-visible features as Unix hosts:

- live CWD subtitle in the sidebar
- create/duplicate-in-same-CWD behavior

Current scope: Git Bash sessions. `cmd.exe` / PowerShell still do not have shell-integrated CWD reporting.

### Windows install/runtime model

`deploy/install.ps1` now:

- installs Bun if needed
- downloads the latest release zip
- stops the service before extracting over the install dir
- bundles a portable Node runtime into `<install dir>/node`
- runs `bun install`
- configures/restarts the NSSM service

Bundling Node avoids depending on a machine-global Node install or user-scoped `nvm` path for the PTY worker.

### Auto-update

Windows auto-update now:

1. checks GitHub releases
2. downloads the latest `.zip`
3. extracts it in place
4. runs `bun install --frozen-lockfile`
5. exits for service restart

`mom` validation covered the startup update-check path successfully. A true end-to-end self-update still requires the next released version to exercise the full download-and-restart cycle against a newer asset.

## Phase Status

- Phase 1: complete
- Phase 2: complete
- Phase 3: complete for Git Bash-based Windows parity
- Phase 4: complete for installer/runtime plumbing on `mom`
- Phase 5: pending

## Remaining Follow-Ups

- Add Windows Playwright / CI coverage
- Run one full released self-update on `mom` against a newer published version
- Decide whether `cmd.exe` / PowerShell need their own CWD shell integration or remain fallback-only shells
