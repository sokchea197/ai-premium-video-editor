import type { Aspect, CaptionSegment, CaptionStyle, CaptionWord, PresetDef } from "./types";

export const OUTPUT: Record<Aspect, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
};

/** Mirrors server/src/lib/captions.ts captionLayout so the preview matches the export. */
export function captionLayout(style: CaptionStyle, preset: PresetDef, width: number, height: number) {
  const scale = Math.min(width, height) / 1080;
  const fontSize = Math.round(preset.size * scale * style.size);
  const vertical = height > width;
  const lowerMargin = vertical ? 0.26 : height === width ? 0.12 : 0.09;
  const marginV =
    style.position === "lower" ? Math.round(height * lowerMargin) : style.position === "upper" ? Math.round(height * (vertical ? 0.16 : 0.08)) : 0;
  return { fontSize, marginV, marginH: Math.round(width * 0.08), scale: scale * style.size };
}

/** Same algorithm as the server: keep timings if the word count matches, else redistribute. */
export function retimeText(seg: CaptionSegment, text: string): CaptionWord[] | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean).slice(0, 40);
  if (!tokens.length) return null;
  if (tokens.length === seg.words.length) return seg.words.map((w, i) => ({ ...w, text: tokens[i].slice(0, 60) }));
  const weights = tokens.map((t) => t.length + 2);
  const total = weights.reduce((a, b) => a + b, 0);
  let t = seg.start;
  return tokens.map((tok, i) => {
    const d = (weights[i] / total) * (seg.end - seg.start);
    const w = { text: tok.slice(0, 60), start: round(t), end: round(t + d) };
    t += d;
    return w;
  });
}

/** Shifts word timings proportionally after a segment's start/end changes. */
export function rescale(seg: CaptionSegment, start: number, end: number): CaptionSegment {
  const span = seg.end - seg.start || 1;
  const map = (t: number) => round(start + ((t - seg.start) / span) * (end - start));
  return { ...seg, start: round(start), end: round(end), words: seg.words.map((w) => ({ ...w, start: map(w.start), end: map(w.end) })) };
}

export const round = (n: number) => Math.round(n * 1000) / 1000;
export const segmentText = (s: CaptionSegment) => s.words.map((w) => w.text).join(" ");

export const HIGHLIGHTS = ["#E3CB98", "#FFFFFF", "#FFD84D", "#F2A7B5", "#9FE3C1", "#8EC5FF"];

/** Languages Whisper transcribes (accuracy varies; English is strongest). */
export const LANGUAGES = [
  ["en", "English"], ["km", "Khmer"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"],
  ["pt", "Portuguese"], ["nl", "Dutch"], ["th", "Thai"], ["vi", "Vietnamese"], ["id", "Indonesian"], ["ms", "Malay"],
  ["tl", "Tagalog"], ["zh", "Chinese"], ["ja", "Japanese"], ["ko", "Korean"], ["hi", "Hindi"], ["ar", "Arabic"],
  ["ru", "Russian"], ["uk", "Ukrainian"], ["pl", "Polish"], ["tr", "Turkish"], ["sv", "Swedish"],
] as const;
