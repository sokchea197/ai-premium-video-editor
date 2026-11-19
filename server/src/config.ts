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
  fontsDir: string;
  /** Where free Whisper models are cached after their one-time download. */
  whisperCacheDir: string;
  whisperModel: "base" | "small";
  /** Optional shared password protecting the whole app (HTTP Basic auth). */
  appPassword: string | null;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dataDir: process.env.DATA_DIR ?? path.join(root, "data"),
    webDist: path.join(root, "web", "dist"),
    maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 20480) * 1024 * 1024,
    concurrency: Number(process.env.RENDER_CONCURRENCY ?? 1),
    ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
    ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
    x264Preset: process.env.X264_PRESET ?? "fast",
    fontsDir: path.join(root, "server", "assets", "fonts"),
    whisperCacheDir: process.env.WHISPER_CACHE_DIR ?? path.join(process.env.DATA_DIR ?? path.join(root, "data"), "models"),
    whisperModel: process.env.WHISPER_MODEL === "base" ? "base" : "small",
    appPassword: process.env.APP_PASSWORD?.trim() || null,
    ...overrides,
  };
}
