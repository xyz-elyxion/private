#!/bin/sh
# Restore the code-server IDE runtime for local development (the ~400MB
# runtime/ dir is git-ignored; production gets it from the Docker build).
#
# Wired as an npm `preinstall` hook (best-effort — failures never block
# `npm install`) and runnable directly: `sh ./scripts/install-ide-runtime.sh`.
#
# Skips when: the runtime already exists, or CODE_SERVER_SKIP_INSTALL=1.
set -u

if [ "${CODE_SERVER_SKIP_INSTALL:-0}" = "1" ]; then
  exit 0
fi

ENTRY=".code-server-src/runtime/node_modules/code-server/out/node/entry.js"
if [ -f "$ENTRY" ]; then
  exit 0
fi

# Only try when the vendored source is present (i.e. a repo clone).
if [ ! -d ".code-server-src" ]; then
  exit 0
fi

command -v npm >/dev/null 2>&1 || exit 0

echo "[ide] code-server runtime not found — installing (first time only)…"
mkdir -p .code-server-src/runtime
cd .code-server-src/runtime || exit 0

if [ ! -f package.json ]; then
  npm init -y >/dev/null 2>&1 || exit 0
fi

# The rebrand script runs here too so dev matches the Docker image branding.
if npm install code-server@4.104.2 --no-audit --no-fund --unsafe-perm >/dev/null 2>&1; then
  if [ -f ../../scripts/rebrand-ide.sh ]; then
    sh ../../scripts/rebrand-ide.sh >/dev/null 2>&1 || true
  fi
  echo "[ide] code-server installed at .code-server-src/runtime"
else
  echo "[ide] code-server install failed — /ide will return 503 until it's available."
  echo "      Retry with: sh ./scripts/install-ide-runtime.sh (or set CODE_SERVER_SKIP_INSTALL=1 to skip)."
fi
