import fs from "node:fs";
import path from "node:path";

// Load ../.env (repo root) if present; real environment variables take precedence.
const envFile = path.resolve(import.meta.dirname, "..", "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const { createApp } = await import("./app.js");

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

createApp()
  .then(({ app, caps, cfg }) => {
    app.listen(port, host, () => {
      console.log(`AI Premium Video Editor API on http://${host}:${port}`);
      console.log(`  ffmpeg ${caps.version} · HDR tone-mapping: ${caps.zscale ? "yes" : "no"} · data: ${cfg.dataDir}`);
    });
  })
  .catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
