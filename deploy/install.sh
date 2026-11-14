#!/bin/sh
set -e

# LLMProxy2 One-Click Installer for Linux VM & systemd environments
# Supports --role=lite (default) and --role=full

ROLE="lite"
TARGET_DIR="/usr/local/bin"
BIN_NAME="llmproxy"
INSTALL_SRC=""
HUB_URL=""
NODE_TOKEN=""
CLIENT_KEY=""
ADMIN_PASS=""

# Parse arguments
for arg in "$@"; do
  case $arg in
    --role=*)
      ROLE="${arg#*=}"
      ;;
    --bin=*)
      INSTALL_SRC="${arg#*=}"
      ;;
    --hub-url=*)
      HUB_URL="${arg#*=}"
      ;;
    --node-token=*)
      NODE_TOKEN="${arg#*=}"
      ;;
    --client-key=*)
      CLIENT_KEY="${arg#*=}"
      ;;
    --admin-pass=*)
      ADMIN_PASS="${arg#*=}"
      ;;
    --help)
      echo "Usage: $0 [--role=lite|full] [--bin=/path/to/binary] [--hub-url=URL] [--node-token=TOKEN] [--client-key=KEY] [--admin-pass=PASS]"
      exit 0
      ;;
  esac
done

if [ "$ROLE" != "lite" ] && [ "$ROLE" != "full" ]; then
  echo "Error: --role must be either 'lite' or 'full' (got '$ROLE')"
  exit 1
fi

echo "============================================================"
echo "🚀 LLMProxy2 Automated Installer (Role: $ROLE)"
echo "============================================================"

# Detect OS & Architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64|amd64)
    GOARCH="amd64"
    ;;
  aarch64|arm64)
    GOARCH="arm64"
    ;;
  *)
    echo "Error: Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

BINARY_NAME="llmproxy-${OS}-${GOARCH}"
echo "Detected platform: ${OS}/${GOARCH} (${BINARY_NAME})"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Resolve binary
if [ -n "$INSTALL_SRC" ] && [ -f "$INSTALL_SRC" ]; then
  RESOLVED_BIN="$INSTALL_SRC"
elif [ -f "$PROJECT_ROOT/dist/$BINARY_NAME" ]; then
  RESOLVED_BIN="$PROJECT_ROOT/dist/$BINARY_NAME"
elif [ -f "$PROJECT_ROOT/dist/llmproxy" ]; then
  RESOLVED_BIN="$PROJECT_ROOT/dist/llmproxy"
else
  DOWNLOAD_URL="https://github.com/khc8655/ocrprox2/releases/latest/download/llmproxy-linux-${GOARCH}"
  echo "Local binary not found. Downloading from ${DOWNLOAD_URL}..."
  TMP_BIN="/tmp/llmproxy-linux-${GOARCH}-$$"
  if curl -fsSL "$DOWNLOAD_URL" -o "$TMP_BIN"; then
    chmod +x "$TMP_BIN"
    RESOLVED_BIN="$TMP_BIN"
  else
    echo "Error: Compiled binary not found for $BINARY_NAME in $PROJECT_ROOT/dist/ and download failed."
    echo "Please run 'npm run build:release' first or specify --bin=/path/to/binary."
    exit 1
  fi
fi

echo "Installing binary from $RESOLVED_BIN to $TARGET_DIR/$BIN_NAME..."
mkdir -p "$TARGET_DIR"
cp "$RESOLVED_BIN" "$TARGET_DIR/$BIN_NAME"
chmod +x "$TARGET_DIR/$BIN_NAME"
[ -n "$TMP_BIN" ] && rm -f "$TMP_BIN"
echo "Binary installed successfully."

# Setup systemd units
if [ "$ROLE" = "lite" ]; then
  SERVICE_FILE="/etc/systemd/system/llmproxy-lite.service"
  echo "Setting up systemd service: $SERVICE_FILE..."
  cp "$SCRIPT_DIR/llmproxy-lite.service" "$SERVICE_FILE"

  if [ -n "$HUB_URL" ]; then
    sed -i.bak "s|LLMPROXY_HUB_URL=.*|LLMPROXY_HUB_URL=$HUB_URL|" "$SERVICE_FILE" 2>/dev/null || true
  fi
  if [ -n "$NODE_TOKEN" ]; then
    sed -i.bak "s|LLMPROXY_NODE_TOKEN=.*|LLMPROXY_NODE_TOKEN=$NODE_TOKEN|" "$SERVICE_FILE" 2>/dev/null || true
  fi
  if [ -n "$CLIENT_KEY" ]; then
    sed -i.bak "s|LLMPROXY_CLIENT_KEY=.*|LLMPROXY_CLIENT_KEY=$CLIENT_KEY|" "$SERVICE_FILE" 2>/dev/null || true
  fi
  rm -f "${SERVICE_FILE}.bak"

  echo "Lite node service configured."

elif [ "$ROLE" = "full" ]; then
  SERVICE_FILE="/etc/systemd/system/llmproxy-full.service"
  echo "Setting up Full gateway service..."

  # Create llmproxy user if not exists
  if command -v id >/dev/null 2>&1 && ! id -u llmproxy >/dev/null 2>&1; then
    useradd -r -s /bin/false -d /opt/llmproxy llmproxy 2>/dev/null || true
  fi

  mkdir -p /opt/llmproxy/config
  mkdir -p /opt/llmproxy/bin
  cp "$TARGET_DIR/$BIN_NAME" /opt/llmproxy/bin/llmproxy 2>/dev/null || true

  # Default .env template
  if [ ! -f /opt/llmproxy/.env ]; then
    cat <<EOF > /opt/llmproxy/.env
LLMPROXY_ROLE=full
LLMPROXY_ADDR=[::]:8000
CONFIG_DIR=/opt/llmproxy/config
ENCRYPT_KEY=${ADMIN_PASS:-test-default-encryption-key-32bytes}
ADMIN_PASSWORD=${ADMIN_PASS:-admin123}
PROXY_API_KEY=${CLIENT_KEY:-sk-llmproxy-client-default}
EOF
    chmod 600 /opt/llmproxy/.env
    echo "Created /opt/llmproxy/.env template."
  fi

  if command -v chown >/dev/null 2>&1; then
    chown -R llmproxy:llmproxy /opt/llmproxy 2>/dev/null || true
  fi

  cp "$SCRIPT_DIR/llmproxy-full.service" "$SERVICE_FILE"
  echo "Full gateway service configured."
fi

# Reload systemd if available
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  echo "Systemd daemon reloaded."
  echo "To start the service:"
  echo "  sudo systemctl start llmproxy-${ROLE}"
  echo "  sudo systemctl status llmproxy-${ROLE}"
fi

echo "============================================================"
echo "✔ LLMProxy2 ($ROLE) installation completed successfully!"
echo "============================================================"
