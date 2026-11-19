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
import { CHUNKING, PRESETS, captionStyleSchema, groupWords, validateSegments } from "./lib/captions.js";
import { TranscriptionError } from "./lib/deepgram.js";
import { timingSafeEqual } from "node:crypto";
import { UploadError, UploadManager } from "./lib/uploads.js";

const KNOWN_EXT = new Set([".mp4", ".mov", ".m4v", ".3gp", ".mkv", ".webm"]);

/** Storage extension from the name if sensible, otherwise from the detected container. */
function storageExt(originalName: string, formatName: string) {
  const ext = path.extname(originalName).toLowerCase();
  if (KNOWN_EXT.has(ext)) return ext;
  if (/mov|mp4/.test(formatName)) return ".mov";
  if (/matroska|webm/.test(formatName)) return ".mkv";
  return ".video";
}

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
  app.use(express.json({ limit: "4mb" }));

  // Optional shared password for the whole app. Strongly recommended whenever the
  // server is reachable from the internet, since transcription spends Deepgram credit.
  if (cfg.appPassword) {
    const expected = Buffer.from(cfg.appPassword);
    app.use((req, res, next) => {
      const m = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
      const pass = m ? Buffer.from(m[1], "base64").toString().split(":").slice(1).join(":") : "";
      const given = Buffer.from(pass);
      if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
      res.set("WWW-Authenticate", 'Basic realm="Premium Studio", charset="UTF-8"').status(401).json({ error: "Sign in required" });
    });
  }

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
      uploadChunkBytes: 8 * 1024 * 1024,
      // Report real availability, never pretend. The API key itself is never sent.
      ai: {
        transcription: pipeline.transcriptionAvailable
          ? { available: true, provider: "deepgram", model: cfg.deepgramModel, pricePerMinuteUsd: { standard: 0.0043, multilingual: 0.0052, keytermAddOn: 0.0013 } }
          : { available: false, provider: "deepgram", reason: "The server has no DEEPGRAM_API_KEY configured." },
        editingAssistant: { available: false, reason: "Not yet implemented (stage 3)" },
      },
      captionPresets: Object.entries(PRESETS).map(([id, p]) => ({ id, ...p })),
    });
  });

  // ---------- upload ----------
  /** Validates by content (ffprobe), not by file name, then creates the project. */
  async function createProjectFromFile(tmpFile: string, originalName: string, name?: string) {
    try {
      let info;
      try {
        info = await probe(cfg.ffprobePath, tmpFile);
      } catch {
        throw new HttpError(422, "This file isn't a video we can read. Please choose an MP4 or MOV video (iPhone videos are supported).");
      }
      if (info.durationSec > 30 * 60) throw new HttpError(422, "Videos longer than 30 minutes are not supported.");
      const ext = storageExt(originalName, info.formatName);
      const projectName = String(name || path.basename(originalName, path.extname(originalName)) || "Untitled").slice(0, 120);
      const project = await store.create({ name: projectName, originalName, tmpFile, ext, info });
      pipeline.startIngest(project);
      return store.get(project.id)!;
    } catch (e) {
      await fsp.rm(tmpFile, { force: true });
      throw e;
    }
  }

  // Resumable chunked upload (used by the web app).
  const uploads = new UploadManager(store.tmpDir, cfg.maxUploadBytes);
  const uploadErr = (e: unknown) => {
    if (e instanceof UploadError) return Object.assign(new HttpError(e.status, e.message), { received: e.received });
    return e;
  };

  app.post("/api/uploads", async (req, res) => {
    const body = z.object({ name: z.string().max(400).default("video"), size: z.number().int().positive() }).safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, "Invalid upload request");
    try {
      res.status(201).json(await uploads.create(body.data.name, body.data.size));
    } catch (e) {
      throw uploadErr(e);
    }
  });

  app.get("/api/uploads/:id", (req, res) => {
    try {
      const u = uploads.get(String(req.params.id));
      res.json({ id: u.id, received: u.received, size: u.size });
    } catch (e) {
      throw uploadErr(e);
    }
  });

  app.put("/api/uploads/:id", express.raw({ type: () => true, limit: "16mb" }), async (req, res) => {
    const offset = Number(req.query.offset);
    if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, "Missing offset");
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, "Empty chunk");
    try {
      res.json(await uploads.writeChunk(String(req.params.id), offset, req.body));
    } catch (e) {
      throw uploadErr(e);
    }
  });

  app.post("/api/uploads/:id/complete", async (req, res) => {
    let done;
    try {
      done = uploads.finish(String(req.params.id));
    } catch (e) {
      throw uploadErr(e);
    }
    const project = await createProjectFromFile(done.file, done.name, typeof req.body?.name === "string" ? req.body.name : undefined);
    res.status(201).json(publicProject(project));
  });

  app.delete("/api/uploads/:id", async (req, res) => {
    await uploads.cancel(String(req.params.id));
    res.status(204).end();
  });

  // Single-request multipart upload (simple clients, curl, tests).
  const upload = multer({
    storage: multer.diskStorage({
      destination: store.tmpDir,
      filename: (_req, _file, cb) => cb(null, `upload-${Date.now()}-${Math.random().toString(36).slice(2)}.part`),
    }),
    limits: { fileSize: cfg.maxUploadBytes, files: 1 },
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
        const project = await createProjectFromFile(file.path, file.originalname, req.body?.name);
        res.status(201).json(publicProject(project));
      } catch (e) {
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
      .strictObject({
        name: z.string().trim().min(1).max(120).optional(),
        edit: z.record(z.string(), z.unknown()).optional(),
        captions: z.strictObject({ style: z.record(z.string(), z.unknown()).optional(), segments: z.array(z.unknown()).optional() }).optional(),
      })
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
    let nextCaptions = p.captions;
    if (body.data.captions) {
      if (!p.captions) throw new HttpError(409, "This project has no captions yet. Generate subtitles first.");
      const style = captionStyleSchema.strict().safeParse({ ...p.captions.style, ...(body.data.captions.style ?? {}) });
      if (!style.success) throw new HttpError(400, `Invalid caption style: ${describe(style.error)}`);
      let segments = p.captions.segments;
      if (body.data.captions.segments) {
        try {
          segments = validateSegments(body.data.captions.segments, p.source.info.durationSec);
        } catch (e) {
          throw new HttpError(400, e instanceof z.ZodError ? `Invalid captions: ${describe(e)}` : (e as Error).message);
        }
      }
      nextCaptions = { style: style.data, segments, edited: p.captions.edited || Boolean(body.data.captions.segments) };
    }
    const updated = await store.update(p.id, (proj) => {
      if (body.data.name) proj.name = body.data.name;
      proj.edit = nextEdit;
      proj.captions = nextCaptions;
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

  // ---------- transcription & captions ----------
  app.post("/api/projects/:id/transcribe", (req, res) => {
    const p = mustProject(req);
    const body = z
      .strictObject({
        language: z.string().regex(/^(auto|multi|[a-z]{2,3}(-[A-Za-z0-9]{2,8})?)$/).default("auto"),
        keyterms: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
      })
      .safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, "Invalid transcription options");
    if (!pipeline.transcriptionAvailable) throw new HttpError(503, "Transcription is not configured: the server has no DEEPGRAM_API_KEY.");
    if (p.media.status !== "ready") throw new HttpError(409, "Wait until the footage has finished preparing.");
    if (!p.source.info.hasAudio) throw new HttpError(422, "This video has no audio track to transcribe.");
    if (p.transcription.status === "running") throw new HttpError(409, "Transcription is already running.");
    let job;
    try {
      job = pipeline.startTranscribe(p, { language: body.data.language, keyterms: body.data.keyterms.filter(Boolean) });
    } catch (e) {
      if (e instanceof TranscriptionError) throw new HttpError(e.status ?? 500, e.message);
      throw e;
    }
    res.status(202).json({ job });
  });

  app.post("/api/projects/:id/captions/regroup", async (req, res) => {
    const p = mustProject(req);
    const body = z.strictObject({ chunking: z.enum(CHUNKING) }).safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, "Invalid caption length");
    if (!p.transcript || !p.captions) throw new HttpError(409, "Generate subtitles first.");
    const updated = await store.update(p.id, (proj) => {
      const style = { ...proj.captions!.style, chunking: body.data.chunking };
      proj.captions = { style, segments: groupWords(proj.transcript!.words, body.data.chunking), edited: false };
    });
    res.json(publicProject(updated!));
  });

  // Bundled OFL fonts, so the browser preview uses the exact typefaces burned into exports.
  app.get("/api/fonts/:file", (req, res, next) => {
    const f = path.basename(String(req.params.file));
    if (!/^[\w-]+\.ttf$/.test(f)) throw new HttpError(404, "Not found");
    res.sendFile(path.join(cfg.fontsDir, f), { maxAge: "30d", headers: { "Access-Control-Allow-Origin": "*" } }, (err) => err && next(new HttpError(404, "Not found")));
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
  if (fs.existsSync(path.join(cfg.webDist, "index.html"))) {
    app.use(express.static(cfg.webDist, { index: false, maxAge: "1d" }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.set("Cache-Control", "no-cache").sendFile(path.join(cfg.webDist, "index.html")));
  } else {
    // Previously a bare "Cannot GET /": explain how to get the editor UI instead.
    app.get(/^\/(?!api\/).*/, (_req, res) =>
      res.status(503).type("html").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#0a0a0b;color:#f4f0e8;font:16px system-ui;padding:32px;line-height:1.6"><h2>The editor interface hasn't been built yet</h2><p>The server is running, but the web app files are missing. Stop the server and start it with:</p><pre style="background:#151517;padding:12px;border-radius:8px">npm start</pre><p>from the project folder (it builds the interface automatically).</p></body>`),
    );
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, received: (err as any).received });
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
