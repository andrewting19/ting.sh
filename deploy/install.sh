#!/usr/bin/env bash
set -euo pipefail

# ting.sh installer — run with: curl -fsSL <raw-url> | bash
# Installs Bun (if missing), downloads the latest release, sets up systemd.

REPO="andrewting19/ting.sh"
INSTALL_DIR="/opt/ting.sh"

echo "==> Installing ting.sh"

# 1. Install Bun if not present
if ! command -v bun &>/dev/null; then
  echo "==> Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Ensure bun is on the system PATH for systemd
BUN_PATH=$(command -v bun)
if [ "$BUN_PATH" != "/usr/local/bin/bun" ]; then
  ln -sf "$BUN_PATH" /usr/local/bin/bun
fi

echo "==> Bun version: $(bun --version)"

# 2. Determine latest release
LATEST=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
if [ -z "$LATEST" ]; then
  echo "ERROR: Could not determine latest release"
  exit 1
fi
echo "==> Latest release: $LATEST"

# 3. Download and extract
TARBALL_URL="https://github.com/$REPO/releases/download/$LATEST/ting.sh-${LATEST}.tar.gz"
mkdir -p "$INSTALL_DIR"
echo "==> Downloading $TARBALL_URL"
curl -fsSL "$TARBALL_URL" | tar xz -C "$INSTALL_DIR"

# 4. Write version marker
echo "$LATEST" > "$INSTALL_DIR/CURRENT_VERSION"

# 5. Install systemd service (if systemd is available)
if command -v systemctl &>/dev/null; then
  echo "==> Installing systemd service"
  cp "$INSTALL_DIR/deploy/ting-sh.service" /etc/systemd/system/ting-sh.service 2>/dev/null || true

  # If the service file wasn't in the tarball, download it
  if [ ! -f /etc/systemd/system/ting-sh.service ]; then
    curl -fsSL "https://raw.githubusercontent.com/$REPO/main/deploy/ting-sh.service" \
      -o /etc/systemd/system/ting-sh.service
  fi

  systemctl daemon-reload
  systemctl enable ting-sh
  systemctl restart ting-sh
  echo "==> Service started on port 7681"
  echo "==> Configure: edit /opt/ting.sh/.env (PORT, SHELL, etc.)"
  echo "==> Logs: journalctl -u ting-sh -f"
else
  echo "==> No systemd found. Start manually: cd $INSTALL_DIR && bun run server.ts"
fi

echo "==> ting.sh $LATEST installed to $INSTALL_DIR"
