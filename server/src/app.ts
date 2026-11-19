import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadConfig, type AppConfig } from "./config.js";
import { ASPECTS, editSchema, segment } from "./lib/edit.js";
import { ffmpegCapabilities, probe, FfmpegError } from "./lib/ffmpeg.js";
import { JobManager } from "./lib/jobs.js";
import { LOOKS } from "./lib/looks.js";
import { Pipeline } from "./lib/pipeline.js";
import { ProjectStore, type Project } from "./lib/store.js";

const ALLOWED_EXT = new Set([".mp4", ".mov", ".m4v"]);

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function createApp(overrides: Partial<AppConfig> = {}) {
  const cfg = loadConfig(overrides);
  const caps = await ffmpegCapabilities(cfg.ffmpegPath);
  if (!caps.available) throw new Error(`FFmpeg not found at "${cfg.ffmpegPath}". Install FFmpeg or set FFMPEG_PATH.`);
  if (!caps.libx264) throw new Error("This FFmpeg build lacks libx264, which is required for MP4 export.");

  const store = new ProjectStore(cfg.dataDir);
  await store.load();
  const jobs = new JobManager(cfg.concurrency);
  const pipeline = new Pipeline(cfg, store, jobs, { zscale: caps.zscale, x264Preset: cfg.x264Preset });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  const mustProject = (req: Request): Project => {
    let p: Project | undefined;
    try {
      p = store.get(String(req.params.id));
    } catch {
      /* invalid id */
    }
    if (!p) throw new HttpError(404, "Project not found");
    return p;
  };

  const publicProject = (p: Project) => ({
    ...p,
    urls: {
      proxy: p.media.hasProxy ? `/api/projects/${p.id}/media/proxy.mp4?v=${p.media.jobId}` : null,
      thumb: p.media.hasThumb ? `/api/projects/${p.id}/media/thumb.jpg?v=${p.media.jobId}` : null,
      filmstrip: p.media.hasFilmstrip ? `/api/projects/${p.id}/media/filmstrip.jpg?v=${p.media.jobId}` : null,
    },
    exports: p.exports.map((e) => ({
      ...e,
      downloadUrl: e.status === "done" ? `/api/projects/${p.id}/exports/${e.id}/download` : null,
    })),
  });

  // ---------- capabilities ----------
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      ffmpeg: caps,
      formats: Object.entries(ASPECTS).map(([id, a]) => ({ id, ...a })),
      looks: Object.entries(LOOKS).map(([id, l]) => ({ id, name: l.name, description: l.description })),
      maxUploadMb: Math.round(cfg.maxUploadBytes / 1024 / 1024),
      // AI features are added in later stages; report their real state, never pretend.
      ai: {
        transcription: { available: false, reason: "Not yet implemented (stage 2)" },
        editingAssistant: { available: false, reason: "Not yet implemented (stage 3)" },
      },
    });
  });

  // ---------- upload ----------
  const upload = multer({
    storage: multer.diskStorage({
      destination: store.tmpDir,
      filename: (_req, file, cb) => cb(null, `upload-${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: cfg.maxUploadBytes, files: 1 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) return cb(new HttpError(415, "Only MP4 and MOV videos are supported."));
      cb(null, true);
    },
  });

  app.post("/api/projects", (req, res, next) => {
    upload.single("video")(req, res, async (err: unknown) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE")
          return next(new HttpError(413, `File is too large. The limit is ${Math.round(cfg.maxUploadBytes / 1024 / 1024)} MB.`));
        return next(err);
      }
      const file = req.file;
      if (!file) return next(new HttpError(400, 'No video received. Send the file in a "video" form field.'));
      try {
        let info;
        try {
          info = await probe(cfg.ffprobePath, file.path);
        } catch (e) {
          throw new HttpError(422, e instanceof Error ? e.message : "Unreadable video");
        }
        if (info.durationSec > 30 * 60) throw new HttpError(422, "Videos longer than 30 minutes are not supported.");
        const ext = path.extname(file.originalname).toLowerCase();
        const name = String(req.body?.name || path.basename(file.originalname, ext)).slice(0, 120);
        const project = await store.create({ name, originalName: file.originalname, tmpFile: file.path, ext, info });
        pipeline.startIngest(project);
        res.status(201).json(publicProject(store.get(project.id)!));
      } catch (e) {
        await fsp.rm(file.path, { force: true });
        next(e);
      }
    });
  });

  // ---------- projects ----------
  app.get("/api/projects", (_req, res) => res.json(store.list().map(publicProject)));
  app.get("/api/projects/:id", (req, res) => res.json(publicProject(mustProject(req))));

  app.patch("/api/projects/:id", async (req, res) => {
    const p = mustProject(req);
    const body = z
      .strictObject({ name: z.string().trim().min(1).max(120).optional(), edit: z.record(z.string(), z.unknown()).optional() })
      .safeParse(req.body);
    const describe = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    if (!body.success) throw new HttpError(400, `Invalid request: ${describe(body.error)}`);
    // Merge onto the current edit, then validate the whole result (unknown keys rejected).
    const merged = editSchema.strict().safeParse({ ...p.edit, ...(body.data.edit ?? {}) });
    if (!merged.success) throw new HttpError(400, `Invalid edit: ${describe(merged.error)}`);
    const nextEdit = merged.data;
    try {
      segment(nextEdit, p.source.info.durationSec);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const updated = await store.update(p.id, (proj) => {
      if (body.data.name) proj.name = body.data.name;
      proj.edit = nextEdit;
    });
    res.json(publicProject(updated!));
  });

  app.delete("/api/projects/:id", async (req, res) => {
    const p = mustProject(req);
    if (p.media.jobId) jobs.cancel(p.media.jobId);
    for (const e of p.exports) jobs.cancel(e.jobId);
    await store.delete(p.id);
    res.status(204).end();
  });

  app.post("/api/projects/:id/reprocess", (req, res) => {
    const p = mustProject(req);
    if (p.media.status === "processing") throw new HttpError(409, "Already processing");
    const job = pipeline.startIngest(p);
    res.status(202).json({ job });
  });

  // ---------- media ----------
  const MEDIA = new Set(["proxy.mp4", "thumb.jpg", "filmstrip.jpg"]);
  app.get("/api/projects/:id/media/:file", (req, res, next) => {
    const p = mustProject(req);
    const f = String(req.params.file);
    if (!MEDIA.has(f)) throw new HttpError(404, "Not found");
    res.sendFile(store.file(p.id, f), { maxAge: "1h", headers: { "Cache-Control": "private, max-age=3600" } }, (err) => err && next(new HttpError(404, "Media not ready")));
  });

  /** Exact FFmpeg-rendered frame of the current edit (true-colour preview). */
  app.get("/api/projects/:id/frame", async (req, res) => {
    const p = mustProject(req);
    const t = Number(req.query.t ?? p.edit.trimStart);
    if (!Number.isFinite(t) || t < 0) throw new HttpError(400, "Invalid time");
    const jpg = await pipeline.renderStill(p, t);
    res.type("image/jpeg").set("Cache-Control", "no-store").send(jpg);
  });

  // ---------- export ----------
  app.post("/api/projects/:id/exports", async (req, res) => {
    const p = mustProject(req);
    const active = p.exports.find((e) => e.status === "queued" || e.status === "rendering");
    if (active) throw new HttpError(409, "An export for this project is already in progress.");
    let result;
    try {
      result = pipeline.startExport(p);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    res.status(202).json({ job: result.job, export: result.record });
  });

  app.get("/api/projects/:id/exports/:exportId/download", (req, res, next) => {
    const p = mustProject(req);
    const e = p.exports.find((x) => x.id === req.params.exportId);
    if (!e || e.status !== "done" || !e.fileName) throw new HttpError(404, "Export not available");
    const safeName = p.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "video";
    res.download(store.file(p.id, e.fileName), `${safeName}-${e.aspect.replace(":", "x")}-1080p.mp4`, (err) => {
      if (err && !res.headersSent) next(new HttpError(404, "Export file missing"));
    });
  });

  app.delete("/api/projects/:id/exports/:exportId", async (req, res) => {
    const p = mustProject(req);
    const e = p.exports.find((x) => x.id === req.params.exportId);
    if (!e) throw new HttpError(404, "Export not found");
    jobs.cancel(e.jobId);
    if (e.fileName) await fsp.rm(store.file(p.id, e.fileName), { force: true });
    await store.update(p.id, (proj) => (proj.exports = proj.exports.filter((x) => x.id !== e.id)));
    res.status(204).end();
  });

  // ---------- jobs ----------
  app.get("/api/jobs/:id", (req, res) => {
    const j = jobs.get(String(req.params.id));
    if (!j) throw new HttpError(404, "Job not found (it may have ended before a server restart)");
    res.json(j);
  });

  app.post("/api/jobs/:id/cancel", (req, res) => {
    const ok = jobs.cancel(String(req.params.id));
    if (!ok) throw new HttpError(409, "Job is not running");
    res.json(jobs.get(String(req.params.id)));
  });

  /** Server-sent events: live job progress. */
  app.get("/api/jobs/:id/events", (req, res) => {
    const id = String(req.params.id);
    const j = jobs.get(id);
    if (!j) throw new HttpError(404, "Job not found");
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = (job: unknown) => res.write(`data: ${JSON.stringify(job)}\n\n`);
    send(j);
    const listener = (job: { status: string }) => {
      send(job);
      if (["done", "failed", "cancelled"].includes(job.status)) setTimeout(() => res.end(), 50);
    };
    jobs.on(`job:${id}`, listener);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      clearInterval(ping);
      jobs.off(`job:${id}`, listener);
    });
  });

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "Not found")));

  // ---------- web client ----------
  if (fs.existsSync(cfg.webDist)) {
    app.use(express.static(cfg.webDist, { index: false, maxAge: "1d" }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(cfg.webDist, "index.html")));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof FfmpegError) {
      console.error("[ffmpeg]", err.message, err.stderrTail);
      return res.status(500).json({ error: err.message, detail: err.stderrTail || undefined });
    }
    if ((err as any)?.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed JSON" });
    console.error(err);
    res.status(500).json({ error: "Something went wrong on the server." });
  });

  return { app, store, jobs, cfg, caps };
}
