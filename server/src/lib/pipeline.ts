import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { probe, runFfmpeg, FfmpegError } from "./ffmpeg.js";
import type { JobManager } from "./jobs.js";
import { buildExportArgs, buildFilmstripArgs, buildProxyArgs, buildStillArgs, stillTime, type CaptionBurnIn, type RenderEnv } from "./render.js";
import { buildAss, captionStyleSchema, defaultCaptionStyle, groupWords, type CaptionStyle, type Captions } from "./captions.js";
import { WHISPER_MODELS, type Transcriber, type WhisperModel } from "./whisper/index.js";
import { ASPECTS, segment } from "./edit.js";
import type { ExportRecord, Project, ProjectStore } from "./store.js";

export class Pipeline {
  constructor(
    private cfg: AppConfig,
    private store: ProjectStore,
    private jobs: JobManager,
    private env: RenderEnv,
    private transcriber: Transcriber,
  ) {}

  /** Creates preview proxy, poster thumbnail and timeline filmstrip. */
  startIngest(project: Project) {
    const id = project.id;
    const job = this.jobs.enqueue("ingest", id, async (ctx) => {
      const p = this.store.get(id);
      if (!p) throw new Error("Project was deleted");
      const src = this.store.file(id, p.source.fileName);
      const info = p.source.info;
      const proxyTmp = this.store.file(id, "proxy.tmp.mp4");
      ctx.progress(0, "Creating smooth preview");
      await runFfmpeg(this.cfg.ffmpegPath, buildProxyArgs(src, proxyTmp, info, this.env), {
        durationSec: info.durationSec,
        signal: ctx.signal,
        onProgress: (f) => ctx.progress(f * 0.85),
      });
      await fs.rename(proxyTmp, this.store.file(id, "proxy.mp4"));
      const proxy = this.store.file(id, "proxy.mp4");

      ctx.progress(0.86, "Capturing poster frame");
      await runFfmpeg(this.cfg.ffmpegPath, [
        "-ss", Math.min(1, info.durationSec / 3).toFixed(2), "-i", proxy, "-frames:v", "1", "-vf", "scale=-2:640", "-q:v", "3",
        this.store.file(id, "thumb.jpg"),
      ], { signal: ctx.signal });

      ctx.progress(0.92, "Building timeline filmstrip");
      await runFfmpeg(this.cfg.ffmpegPath, buildFilmstripArgs(proxy, this.store.file(id, "filmstrip.jpg"), info), { signal: ctx.signal });
    });

    void this.store.update(id, (p) => {
      p.media = { ...p.media, status: "processing", jobId: job.id, error: undefined };
    });
    void this.jobs.wait(job.id).then((j) =>
      this.store.update(id, (p) => {
        if (j.status === "done") p.media = { status: "ready", jobId: j.id, hasProxy: true, hasThumb: true, hasFilmstrip: true };
        else p.media = { ...p.media, status: "failed", error: j.error ?? "Processing was cancelled" };
      }),
    );
    return job;
  }

  startExport(project: Project): { job: ReturnType<JobManager["enqueue"]>; record: ExportRecord } {
    const id = project.id;
    const edit = structuredClone(project.edit); // snapshot: later edits don't affect this render
    const info = project.source.info;
    const src = this.store.file(id, project.source.fileName);
    const exportId = randomUUID();
    const fileName = `export-${exportId}.mp4`;
    const tmpOut = this.store.file(id, `${fileName}.part.mp4`);
    const captions = project.captions ? structuredClone(project.captions) : null;
    const burn = this.captionBurnIn(id, `export-${exportId}.ass`, captions);
    // Validate eagerly so a bad trim is reported immediately, not as a failed job.
    const plan = buildExportArgs(src, tmpOut, edit, info, this.env, burn ?? undefined);

    const job = this.jobs.enqueue("export", id, async (ctx) => {
      ctx.progress(0, "Rendering 1080p master");
      if (burn && captions) {
        const seg = segment(edit, info.durationSec);
        await fs.writeFile(burn.assPath, buildAss(captions, {
          width: plan.width, height: plan.height, outDuration: plan.outputLength,
          map: (t) => (t - seg.start) / edit.speed,
        }));
      }
      await this.store.update(id, (p) => {
        const r = p.exports.find((e) => e.id === exportId);
        if (r) r.status = "rendering";
      });
      try {
        await runFfmpeg(this.cfg.ffmpegPath, plan.args, {
          durationSec: plan.outputLength,
          signal: ctx.signal,
          onProgress: (f) => ctx.progress(f * 0.97),
        });
      } catch (e) {
        await fs.rm(tmpOut, { force: true });
        throw e;
      } finally {
        if (burn) await fs.rm(burn.assPath, { force: true });
      }
      ctx.progress(0.98, "Verifying output");
      // Never report success without checking the file is a valid video of the right shape.
      const out = await probe(this.cfg.ffprobePath, tmpOut).catch(() => null);
      if (!out || out.width !== plan.width || out.height !== plan.height || Math.abs(out.durationSec - plan.outputLength) > 1) {
        await fs.rm(tmpOut, { force: true });
        throw new FfmpegError(
          `Rendered file failed verification (expected ${plan.width}x${plan.height}, ${plan.outputLength.toFixed(1)}s; got ${out ? `${out.width}x${out.height}, ${out.durationSec.toFixed(1)}s` : "unreadable file"}).`,
        );
      }
      await fs.rename(tmpOut, this.store.file(id, fileName));
    });

    const record: ExportRecord = {
      id: exportId,
      jobId: job.id,
      status: "queued",
      aspect: edit.aspect,
      width: plan.width,
      height: plan.height,
      durationSec: plan.outputLength,
      createdAt: new Date().toISOString(),
    };
    void this.store.update(id, (p) => p.exports.unshift(record));
    void this.jobs.wait(job.id).then(async (j) => {
      let size: number | undefined;
      if (j.status === "done") size = (await fs.stat(this.store.file(id, fileName)).catch(() => null))?.size;
      await this.store.update(id, (p) => {
        const r = p.exports.find((e) => e.id === exportId);
        if (!r) return;
        r.finishedAt = new Date().toISOString();
        if (j.status === "done" && size) {
          r.status = "done";
          r.fileName = fileName;
          r.sizeBytes = size;
        } else {
          r.status = j.status === "cancelled" ? "cancelled" : "failed";
          r.error = j.error ?? (j.status === "cancelled" ? "Cancelled" : "Output file missing");
        }
      });
    });
    return { job, record };
  }

  async renderStill(project: Project, timeSec: number): Promise<Buffer> {
    const src = this.store.file(project.id, project.source.fileName);
    const key = randomUUID();
    const out = `${this.store.tmpDir}/still-${key}.jpg`;
    const burn = this.captionBurnIn(project.id, `still-${key}.ass`, project.captions);
    try {
      if (burn && project.captions) {
        const t = stillTime(timeSec, project.source.info);
        const { width, height } = ASPECTS[project.edit.aspect];
        // Input-seeked frame has pts 0 at source time t.
        await fs.writeFile(burn.assPath, buildAss(project.captions, { width, height, outDuration: 1, map: (x) => x - t, still: true }));
      }
      await runFfmpeg(this.cfg.ffmpegPath, buildStillArgs(src, out, timeSec, project.edit, project.source.info, this.env, burn ?? undefined));
      return await fs.readFile(out);
    } finally {
      await fs.rm(out, { force: true });
      if (burn) await fs.rm(burn.assPath, { force: true });
    }
  }

  private captionBurnIn(projectId: string, name: string, captions: Captions | null): CaptionBurnIn | null {
    if (!captions?.style.enabled || !captions.segments.length) return null;
    return { assPath: this.store.file(projectId, name), fontsDir: this.cfg.fontsDir };
  }

  /** Transcribes speech locally with open-source Whisper, then builds captions. Free, no account. */
  startTranscribe(project: Project, opts: { language: string; model: WhisperModel; style?: Partial<CaptionStyle> }) {
    const id = project.id;
    const job = this.jobs.enqueue("transcribe", id, async (ctx) => {
      const p = this.store.get(id);
      if (!p) throw new Error("Project was deleted");
      const src = this.store.file(id, p.source.fileName);
      const pcmPath = this.store.file(id, `speech-${job.id}.f32`);
      try {
        ctx.progress(0.01, "Extracting speech audio");
        // 16 kHz mono float PCM, which is what Whisper consumes.
        await runFfmpeg(this.cfg.ffmpegPath, ["-i", src, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", pcmPath], {
          durationSec: p.source.info.durationSec, signal: ctx.signal, onProgress: (f) => ctx.progress(0.01 + f * 0.07),
        });
        const buf = await fs.readFile(pcmPath);
        const audio = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        const size = WHISPER_MODELS[opts.model].sizeMb;
        ctx.progress(0.1, "Loading Whisper speech model");
        const transcript = await this.transcriber.transcribe({
          audio, model: opts.model, language: opts.language, signal: ctx.signal,
          onDownload: (f) => ctx.progress(0.1, `Downloading free Whisper model, one time only (${Math.round(f * size)} of ${size} MB)`),
          onProgress: (f) => ctx.progress(0.12 + f * 0.83, "Transcribing speech on this computer"),
        });
        ctx.progress(0.97, transcript.words.length ? "Building synchronised captions" : "No speech detected");
        await this.store.update(id, (proj) => {
          const style = captionStyleSchema.parse({ ...(proj.captions?.style ?? defaultCaptionStyle()), ...(opts.style ?? {}) });
          proj.transcript = transcript;
          proj.captions = { style, segments: groupWords(transcript.words, style.chunking), edited: false };
        });
      } finally {
        await fs.rm(pcmPath, { force: true });
      }
    });
    void this.store.update(id, (p) => {
      p.transcription = { status: "running", jobId: job.id, language: opts.language, model: opts.model };
    });
    void this.jobs.wait(job.id).then((j) =>
      this.store.update(id, (p) => {
        p.transcription =
          j.status === "done"
            ? { status: "idle", language: opts.language, model: opts.model }
            : { status: "failed", jobId: j.id, error: j.status === "cancelled" ? "Transcription was cancelled." : j.error ?? "Transcription failed", language: opts.language, model: opts.model };
      }),
    );
    return job;
  }
}
