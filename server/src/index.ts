import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Load ../.env (repo root) if present; real environment variables take precedence.
const envFile = path.resolve(import.meta.dirname, "..", "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const { createApp } = await import("./app.js");

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

createApp()
  .then(({ app, caps, cfg }) => {
    const server = app.listen(port, host, () => {
      console.log(`\n  Premium Studio is running.\n`);
      if (process.env.CODESPACE_NAME) {
        const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN ?? "app.github.dev";
        console.log(`  Open on your iPhone: https://${process.env.CODESPACE_NAME}-${port}.${domain}`);
      }
      console.log(`  On this computer:  http://localhost:${port}`);
      // Phones on the same Wi-Fi reach the editor via this computer's LAN address.
      const lan = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal);
      for (const a of lan) console.log(`  On your iPhone:    http://${a!.address}:${port}   (same Wi-Fi)`);
      console.log(`\n  ffmpeg ${caps.version} · HDR tone-mapping: ${caps.zscale ? "yes" : "no"} · data: ${cfg.dataDir}\n`);
    });
    // Big uploads and renders: never let Node's default timeouts cut a request.
    server.requestTimeout = 0;
    server.headersTimeout = 120_000;
  })
  .catch((e) => {
    console.error(`\n  Could not start: ${e.message ?? e}\n`);
    if (/FFmpeg not found/.test(String(e.message)))
      console.error("  Install FFmpeg (free):\n    macOS:   brew install ffmpeg\n    Windows: winget install Gyan.FFmpeg\n    Linux:   sudo apt install ffmpeg\n");
    process.exit(1);
  });
