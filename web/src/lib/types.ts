export type Aspect = "9:16" | "1:1" | "16:9";
export type LookId = "natural" | "cinematic" | "warm-luxe" | "noir" | "clean-bright" | "film-fade" | "emerald";

export interface EditSettings {
  trimStart: number;
  trimEnd: number | null;
  aspect: Aspect;
  fit: "fill" | "blur";
  focusX: number;
  focusY: number;
  look: LookId;
  lookIntensity: number;
  vignette: boolean;
  speed: number;
  smoothSlowMo: boolean;
  normalizeAudio: boolean;
  volume: number;
  fadeIn: number;
  fadeOut: number;
}

export interface MediaInfo {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  hasAudio: boolean;
  isHdr: boolean;
  sizeBytes: number;
}

export type ExportStatus = "queued" | "rendering" | "done" | "failed" | "cancelled";
export interface ExportRecord {
  id: string;
  jobId: string;
  status: ExportStatus;
  aspect: Aspect;
  width: number;
  height: number;
  durationSec: number;
  createdAt: string;
  finishedAt?: string;
  sizeBytes?: number;
  error?: string;
  downloadUrl: string | null;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  source: { originalName: string; info: MediaInfo };
  media: { status: "processing" | "ready" | "failed"; jobId?: string; error?: string };
  edit: EditSettings;
  exports: ExportRecord[];
  urls: { proxy: string | null; thumb: string | null; filmstrip: string | null };
}

export interface Job {
  id: string;
  kind: "ingest" | "export";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number;
  stage: string;
  error?: string;
  detail?: string;
}

export interface Health {
  ffmpeg: { version: string | null; zscale: boolean };
  formats: { id: Aspect; width: number; height: number; label: string }[];
  looks: { id: LookId; name: string; description: string }[];
  maxUploadMb: number;
  ai: Record<string, { available: boolean; reason?: string }>;
}
