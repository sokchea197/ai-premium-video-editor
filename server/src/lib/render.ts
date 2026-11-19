import { ASPECTS, segment, type EditSettings } from "./edit.js";
import type { MediaInfo } from "./ffmpeg.js";
import { lookFilters } from "./looks.js";

export interface RenderEnv {
  zscale: boolean;
  x264Preset: string;
}

const HDR_TO_SDR =
  "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv";

function outputFps(info: MediaInfo) {
  const fps = info.fps > 0 && info.fps <= 60 ? info.fps : 30;
  return Math.round(fps * 1000) / 1000;
}

/** atempo only accepts 0.5..2 per instance (FFmpeg ≥ 4 accepts 0.5..100, but chain to be safe). */
function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s < 0.5) { out.push("atempo=0.5"); s /= 0.5; }
  while (s > 2) { out.push("atempo=2"); s /= 2; }
  out.push(`atempo=${s}`);
  return out;
}

/**
 * Builds the video filter graph, from input [0:v] to output [vout].
 * Shared by export and single-frame preview so the preview is exact.
 */
export function buildVideoGraph(edit: EditSettings, info: MediaInfo, env: RenderEnv, opts: { forStill?: boolean } = {}) {
  const { width: W, height: H } = ASPECTS[edit.aspect];
  const { outputLength } = segment(edit, info.durationSec);
  const fps = outputFps(info);
  const pre: string[] = [];
  if (info.isHdr && env.zscale) pre.push(HDR_TO_SDR);
  pre.push("format=yuv420p");

  if (!opts.forStill && edit.speed !== 1) {
    pre.push(`setpts=PTS/${edit.speed}`);
    if (edit.speed < 1 && edit.smoothSlowMo) pre.push(`minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1`);
  }
  if (!opts.forStill) pre.push(`fps=${fps}`);

  // Crop position honouring the focus point (keeps the subject's face in frame).
  const cropX = `(iw-${W})*${edit.focusX}`;
  const cropY = `(ih-${H})*${edit.focusY}`;
  const fill = `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}:${cropX}:${cropY}`;

  const post = [...lookFilters(edit.look, edit.lookIntensity, edit.vignette)];
  if (!opts.forStill) {
    if (edit.fadeIn > 0) post.push(`fade=t=in:st=0:d=${edit.fadeIn}`);
    if (edit.fadeOut > 0) post.push(`fade=t=out:st=${Math.max(0, outputLength - edit.fadeOut).toFixed(3)}:d=${edit.fadeOut}`);
  }
  post.push("setsar=1", "format=yuv420p");

  const parts: string[] = [];
  if (edit.fit === "fill") {
    parts.push(`[0:v]${[...pre, fill, ...post].join(",")}[vout]`);
  } else {
    parts.push(`[0:v]${pre.join(",")},split=2[bgsrc][fgsrc]`);
    // Downscale before blurring: cheaper and a softer, more luxurious bokeh.
    parts.push(`[bgsrc]${fill},scale=${W / 4}:${H / 4},gblur=sigma=12,scale=${W}:${H},eq=brightness=-0.06:saturation=1.1[bg]`);
    parts.push(`[fgsrc]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos[fg]`);
    parts.push(`[bg][fg]overlay=(W-w)/2:(H-h)/2${post.length ? "," + post.join(",") : ""}[vout]`);
  }
  return { graph: parts.join(";"), width: W, height: H, fps };
}

export function buildAudioGraph(edit: EditSettings, info: MediaInfo): string | null {
  if (!info.hasAudio) return null;
  const { outputLength } = segment(edit, info.durationSec);
  const chain: string[] = ["aresample=48000"];
  if (edit.speed !== 1) chain.push(...atempoChain(edit.speed));
  if (edit.volume !== 1) chain.push(`volume=${edit.volume}`);
  // Social-platform loudness target: -14 LUFS integrated, -1.5 dBTP.
  if (edit.normalizeAudio) chain.push("loudnorm=I=-14:TP=-1.5:LRA=11", "aresample=48000");
  if (edit.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${edit.fadeIn}`);
  if (edit.fadeOut > 0) chain.push(`afade=t=out:st=${Math.max(0, outputLength - edit.fadeOut).toFixed(3)}:d=${edit.fadeOut}`);
  return `[0:a:0]${chain.join(",")}[aout]`;
}

export function buildExportArgs(src: string, out: string, edit: EditSettings, info: MediaInfo, env: RenderEnv) {
  const seg = segment(edit, info.durationSec);
  const video = buildVideoGraph(edit, info, env);
  const audio = buildAudioGraph(edit, info);
  const args = [
    "-ss", seg.start.toFixed(3), "-t", seg.sourceLength.toFixed(3), "-i", src,
    "-filter_complex", [video.graph, audio].filter(Boolean).join(";"),
    "-map", "[vout]",
  ];
  if (audio) args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
  args.push(
    "-c:v", "libx264", "-preset", env.x264Preset, "-crf", "18", "-profile:v", "high", "-level", "4.2",
    "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    "-r", String(video.fps), "-movflags", "+faststart", "-t", seg.outputLength.toFixed(3),
    "-metadata", "comment=Made with AI Premium Video Editor",
    out,
  );
  return { args, outputLength: seg.outputLength, width: video.width, height: video.height };
}

export function buildStillArgs(src: string, out: string, timeSec: number, edit: EditSettings, info: MediaInfo, env: RenderEnv) {
  const t = Math.max(0, Math.min(timeSec, info.durationSec - 0.05));
  const video = buildVideoGraph(edit, info, env, { forStill: true });
  return ["-ss", t.toFixed(3), "-i", src, "-filter_complex", video.graph, "-map", "[vout]", "-frames:v", "1", "-q:v", "3", out];
}

/** Browser-friendly preview proxy: H.264, long side ≤ 1280, SDR. */
export function buildProxyArgs(src: string, out: string, info: MediaInfo, env: RenderEnv) {
  const vf: string[] = [];
  if (info.isHdr && env.zscale) vf.push(HDR_TO_SDR);
  vf.push(
    "scale='if(gte(iw,ih),min(1280,iw),-2)':'if(gte(iw,ih),-2,min(1280,ih))'",
    "format=yuv420p",
  );
  const args = ["-i", src, "-vf", vf.join(","), "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-g", "30"];
  if (info.hasAudio) args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2");
  else args.push("-an");
  args.push("-movflags", "+faststart", out);
  return args;
}

/** Ten-frame filmstrip sprite for the timeline. */
export function buildFilmstripArgs(src: string, out: string, info: MediaInfo, frames = 10) {
  const rate = frames / Math.max(info.durationSec, 0.1);
  return ["-i", src, "-vf", `fps=${rate.toFixed(5)},scale=-2:120,tile=${frames}x1`, "-frames:v", "1", "-q:v", "4", out];
}
