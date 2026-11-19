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

export type PresetId = "bold-pop" | "editorial" | "minimal" | "impact";
export type Chunking = "punchy" | "balanced" | "lines";

export interface CaptionWord { text: string; start: number; end: number }
export interface CaptionSegment { id: string; start: number; end: number; words: CaptionWord[] }
export interface CaptionStyle {
  enabled: boolean;
  preset: PresetId;
  position: "lower" | "middle" | "upper";
  size: number;
  highlight: string;
  animate: boolean;
  chunking: Chunking;
}
export interface Captions { style: CaptionStyle; segments: CaptionSegment[]; edited: boolean }
export interface Transcript { provider: string; model: string; language: string | null; audioDurationSec: number; createdAt: string; words: { text: string }[] }

export interface PresetDef {
  id: PresetId;
  name: string;
  description: string;
  cssFamily: string;
  cssWeight: number;
  emRatio: number;
  size: number;
  uppercase: boolean;
  color: string;
  outline: number;
  outlineColor: string;
  outlineAlpha: number;
  shadow: number;
  shadowAlpha: number;
  box: boolean;
  boxAlpha: number;
  letterSpacing: number;
  activeItalic: boolean;
  activeScale: number;
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
  transcript: Transcript | null;
  captions: Captions | null;
  transcription: { status: "idle" | "running" | "failed"; jobId?: string; error?: string; language?: string; model?: string };
  urls: { proxy: string | null; thumb: string | null; filmstrip: string | null };
}

export interface Job {
  id: string;
  kind: "ingest" | "export" | "transcribe";
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
  ai: {
    transcription: { available: boolean; local?: boolean; costUsd?: number; defaultModel?: "base" | "small"; models?: { id: "base" | "small"; label: string; sizeMb: number }[] };
    editingAssistant: { available: boolean; reason?: string };
  };
  captionPresets: PresetDef[];
}
