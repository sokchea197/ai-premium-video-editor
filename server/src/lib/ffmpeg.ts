import { spawn } from "node:child_process";

export interface MediaInfo {
  durationSec: number;
  /** Display dimensions (rotation applied). */
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  hasAudio: boolean;
  rotation: number;
  /** HDR transfer (HLG / PQ) – typical for iPhone footage. */
  isHdr: boolean;
  sizeBytes: number;
  formatName: string;
}

export class FfmpegError extends Error {
  constructor(message: string, readonly stderrTail: string = "") {
    super(message);
  }
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [n, d] = rate.split("/").map(Number);
  if (!d) return n || 0;
  return n / d;
}

export async function probe(ffprobePath: string, file: string): Promise<MediaInfo> {
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn(ffprobePath, [
      "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file,
    ]);
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => reject(new FfmpegError(`ffprobe could not start: ${e.message}`)));
    p.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new FfmpegError("This file could not be read as a video.", stderr.slice(-2000))),
    );
  });

  const json = JSON.parse(out);
  const streams: any[] = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  if (!v) throw new FfmpegError("No video stream found in this file.");

  let rotation = 0;
  for (const sd of v.side_data_list ?? []) {
    if (typeof sd.rotation === "number") rotation = sd.rotation;
  }
  if (!rotation && v.tags?.rotate) rotation = Number(v.tags.rotate);
  const rotated = Math.abs(rotation) % 180 === 90;

  const duration = Number(json.format?.duration ?? v.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new FfmpegError("Video has no readable duration.");

  const transfer = String(v.color_transfer ?? "");
  return {
    durationSec: duration,
    width: rotated ? v.height : v.width,
    height: rotated ? v.width : v.height,
    fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 30,
    videoCodec: v.codec_name,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    rotation,
    isHdr: transfer === "arib-std-b67" || transfer === "smpte2084",
    sizeBytes: Number(json.format?.size ?? 0),
    formatName: String(json.format?.format_name ?? ""),
  };
}

export interface RunOptions {
  /** Expected output duration, used to compute progress. */
  durationSec?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** Runs ffmpeg, reporting progress via -progress. Rejects with stderr tail on failure. */
export function runFfmpeg(ffmpegPath: string, args: string[], opts: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", ...args]);
    let stderr = "";
    let buf = "";
    const onAbort = () => p.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    p.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && opts.durationSec && opts.onProgress) {
          opts.onProgress(Math.min(0.999, Number(m[1]) / 1e6 / opts.durationSec));
        }
      }
    });
    p.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > 20000) stderr = stderr.slice(-10000);
    });
    p.on("error", (e) => reject(new FfmpegError(`ffmpeg could not start: ${e.message}`)));
    p.on("close", (code, sig) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) return reject(new FfmpegError("Cancelled"));
      if (code === 0) return resolve();
      reject(new FfmpegError(`ffmpeg exited with ${code ?? sig}`, stderr.slice(-3000)));
    });
  });
}

export async function ffmpegCapabilities(ffmpegPath: string) {
  const run = (args: string[]) =>
    new Promise<string>((resolve) => {
      const p = spawn(ffmpegPath, ["-hide_banner", ...args]);
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("error", () => resolve(""));
      p.on("close", () => resolve(out));
    });
  const [version, filters, encoders] = await Promise.all([run(["-version"]), run(["-filters"]), run(["-encoders"])]);
  const has = (name: string) => new RegExp(`\\s${name}\\s`).test(filters);
  return {
    available: version.length > 0,
    version: version.split("\n")[0]?.replace(/^ffmpeg version /, "").split(" ")[0] ?? null,
    libx264: /\slibx264\s/.test(encoders),
    zscale: has("zscale") && has("tonemap"),
    libass: has("ass") && has("subtitles"),
    loudnorm: has("loudnorm"),
  };
}
