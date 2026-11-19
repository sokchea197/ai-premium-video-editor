#!/usr/bin/env bash
# One-time setup for GitHub Codespaces (free tier). Installs only free, open-source tools.
set -euo pipefail
echo "▸ Installing FFmpeg…"
sudo apt-get update -qq
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ffmpeg >/dev/null
ffmpeg -hide_banner -version | head -1
echo "▸ Installing editor dependencies…"
npm install --no-audit --no-fund
echo "▸ Building the editor interface…"
npm run build
echo "✓ Setup complete."
