import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");

export interface AppConfig {
  dataDir: string;
  webDist: string;
  maxUploadBytes: number;
  /** Max concurrent FFmpeg jobs. Rendering is CPU-bound, so keep this low. */
  concurrency: number;
  ffmpegPath: string;
  ffprobePath: string;
  x264Preset: string;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dataDir: process.env.DATA_DIR ?? path.join(root, "data"),
    webDist: path.join(root, "web", "dist"),
    maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 4096) * 1024 * 1024,
    concurrency: Number(process.env.RENDER_CONCURRENCY ?? 1),
    ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
    ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
    x264Preset: process.env.X264_PRESET ?? "medium",
    ...overrides,
  };
}
