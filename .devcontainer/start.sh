#!/usr/bin/env bash
# Starts the editor in the background (if not already running) and prints the link to open.
cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"
if [ -n "${CODESPACE_NAME:-}" ]; then
  URL="https://${CODESPACE_NAME}-${PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
else
  URL="http://localhost:${PORT}"
fi
if ! curl -fs "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
  echo "▸ Starting Premium Studio…"
  # Fully detached so it keeps running after this terminal closes.
  setsid nohup npm start > /tmp/premium-studio.log 2>&1 < /dev/null &
  for _ in $(seq 1 90); do
    curl -fs "http://localhost:${PORT}/api/health" >/dev/null 2>&1 && break
    sleep 1
  done
fi
if curl -fs "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
  printf '\n  ✅ Premium Studio is running.\n\n  Open this link in Safari on your iPhone:\n\n     %s\n\n' "$URL"
  printf '  (Sign in to GitHub in Safari if asked. Keep this tab open while editing.)\n\n'
else
  echo "  ❌ The editor didn't start. Last log lines:"
  tail -n 30 /tmp/premium-studio.log
  exit 1
fi
