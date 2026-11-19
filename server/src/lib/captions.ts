import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { TranscriptWord } from "./deepgram.js";

// ---------------- model ----------------

export const PRESET_IDS = ["bold-pop", "editorial", "minimal", "impact"] as const;
export type PresetId = (typeof PRESET_IDS)[number];
export const CHUNKING = ["punchy", "balanced", "lines"] as const;
export type Chunking = (typeof CHUNKING)[number];

export const captionWordSchema = z.object({
  text: z.string().trim().min(1).max(60),
  start: z.number().min(0),
  end: z.number().min(0),
});
export const captionSegmentSchema = z
  .object({
    id: z.string().min(1).max(64),
    start: z.number().min(0),
    end: z.number().min(0),
    words: z.array(captionWordSchema).min(1).max(40),
  })
  .refine((s) => s.end - s.start >= 0.1, { message: "Caption must last at least 0.1 s" });

export const captionStyleSchema = z.object({
  enabled: z.boolean().default(true),
  preset: z.enum(PRESET_IDS).default("bold-pop"),
  position: z.enum(["lower", "middle", "upper"]).default("lower"),
  size: z.number().min(0.6).max(1.6).default(1),
  highlight: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#E3CB98"),
  /** Word-by-word highlight synced to speech. */
  animate: z.boolean().default(true),
  chunking: z.enum(CHUNKING).default("balanced"),
});

export type CaptionWord = z.infer<typeof captionWordSchema>;
export type CaptionSegment = z.infer<typeof captionSegmentSchema>;
export type CaptionStyle = z.infer<typeof captionStyleSchema>;

export interface Captions {
  style: CaptionStyle;
  segments: CaptionSegment[];
  /** True once the user has changed text/timing (regrouping would discard that). */
  edited: boolean;
}

export const defaultCaptionStyle = () => captionStyleSchema.parse({});

export function validateSegments(segments: unknown, maxTime: number): CaptionSegment[] {
  const parsed = z.array(captionSegmentSchema).max(2000).parse(segments);
  const out = parsed.map((s) => {
    const start = Math.min(s.start, maxTime);
    const end = Math.min(s.end, maxTime);
    if (end - start < 0.1) throw new Error(`Caption "${s.words.map((w) => w.text).join(" ")}" is outside the clip.`);
    // Keep words inside their segment and in order.
    let prev = start;
    const words = s.words.map((w) => {
      const ws = Math.max(prev, Math.min(Math.max(w.start, start), end));
      const we = Math.max(ws, Math.min(w.end, end));
      prev = ws;
      return { text: w.text, start: round(ws), end: round(we) };
    });
    return { id: s.id, start: round(start), end: round(end), words };
  });
  return out.sort((a, b) => a.start - b.start);
}

const round = (n: number) => Math.round(n * 1000) / 1000;

// ---------------- grouping ----------------

const LIMITS: Record<Chunking, { words: number; chars: number; dur: number }> = {
  punchy: { words: 3, chars: 18, dur: 1.8 },
  balanced: { words: 6, chars: 30, dur: 2.8 },
  lines: { words: 12, chars: 56, dur: 4.5 },
};

/** Groups transcript words into readable, speech-synchronised caption segments. */
export function groupWords(words: TranscriptWord[], chunking: Chunking): CaptionSegment[] {
  const lim = LIMITS[chunking];
  const segments: CaptionSegment[] = [];
  let cur: CaptionWord[] = [];

  const flush = () => {
    if (!cur.length) return;
    segments.push({ id: randomUUID(), start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
    cur = [];
  };

  for (const w of words) {
    if (cur.length) {
      const last = cur[cur.length - 1];
      const chars = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
      const gap = w.start - last.end;
      const sentenceEnd = /[.!?…]["')\]]?$/.test(last.text);
      const clauseEnd = /[,;:—–]$/.test(last.text) && cur.length >= Math.ceil(lim.words / 2);
      if (cur.length >= lim.words || chars > lim.chars || gap > 0.6 || sentenceEnd || clauseEnd || w.end - cur[0].start > lim.dur) flush();
    }
    cur.push({ text: w.text, start: w.start, end: w.end });
  }
  flush();

  // Hold each caption a little after its last word (up to the next caption) so it is readable.
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const next = segments[i + 1];
    const minEnd = s.start + 0.5;
    const target = Math.max(s.end + 0.25, minEnd);
    s.end = round(next ? Math.min(target, Math.max(s.end, next.start)) : target);
    s.start = round(s.start);
    if (s.end - s.start < 0.1) s.end = round(s.start + 0.1);
  }
  return segments;
}

/**
 * Applies edited text to a segment. If the word count is unchanged the original
 * per-word timings are kept; otherwise timings are redistributed by length.
 */
export function retimeText(seg: Pick<CaptionSegment, "start" | "end" | "words">, text: string): CaptionWord[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean).slice(0, 40);
  if (!tokens.length) throw new Error("Caption text cannot be empty");
  if (tokens.length === seg.words.length) return seg.words.map((w, i) => ({ ...w, text: tokens[i] }));
  const weights = tokens.map((t) => t.length + 2);
  const total = weights.reduce((a, b) => a + b, 0);
  const span = seg.end - seg.start;
  let t = seg.start;
  return tokens.map((tok, i) => {
    const d = (weights[i] / total) * span;
    const w = { text: tok, start: round(t), end: round(t + d) };
    t += d;
    return w;
  });
}

// ---------------- typography presets ----------------

export interface PresetDef {
  name: string;
  description: string;
  font: string; // ASS / CSS family name, must exist in assets/fonts
  cssFamily: string;
  cssWeight: number;
  /**
   * libass (VSFilter-compatible) sizes text so ascent+descent (OS/2 win metrics)
   * equals the ASS font size; CSS sizes the em box. em = assSize × emRatio,
   * where emRatio = unitsPerEm / (usWinAscent + usWinDescent).
   */
  emRatio: number;
  size: number; // ASS font size at 1080 short side
  uppercase: boolean;
  color: string;
  outline: number;
  outlineColor: string;
  outlineAlpha: number; // 0 opaque .. 255 transparent
  shadow: number;
  shadowAlpha: number;
  box: boolean;
  boxAlpha: number;
  letterSpacing: number;
  activeItalic: boolean;
  activeScale: number;
}

export const PRESETS: Record<PresetId, PresetDef> = {
  "bold-pop": {
    name: "Bold Pop", description: "Confident, word-by-word emphasis",
    font: "Poppins ExtraBold", cssFamily: "Poppins", cssWeight: 800, emRatio: 0.5675, size: 86, uppercase: true,
    color: "#FFFFFF", outline: 5, outlineColor: "#000000", outlineAlpha: 110, shadow: 3, shadowAlpha: 150,
    box: false, boxAlpha: 0, letterSpacing: 0.5, activeItalic: false, activeScale: 1.1,
  },
  editorial: {
    name: "Editorial", description: "Elegant serif, magazine feel",
    font: "DM Serif Display", cssFamily: "DM Serif Display", cssWeight: 400, emRatio: 0.7294, size: 94, uppercase: false,
    color: "#FFFFFF", outline: 0, outlineColor: "#000000", outlineAlpha: 255, shadow: 4, shadowAlpha: 120,
    box: false, boxAlpha: 0, letterSpacing: 0, activeItalic: true, activeScale: 1,
  },
  minimal: {
    name: "Minimal", description: "Clean type on a soft panel",
    font: "Poppins SemiBold", cssFamily: "Poppins", cssWeight: 600, emRatio: 0.5675, size: 62, uppercase: false,
    color: "#FFFFFF", outline: 18, outlineColor: "#0A0A0B", outlineAlpha: 90, shadow: 0, shadowAlpha: 255,
    box: true, boxAlpha: 90, letterSpacing: 0, activeItalic: false, activeScale: 1,
  },
  impact: {
    name: "Impact", description: "Big, punchy, built for hooks",
    font: "Anton", cssFamily: "Anton", cssWeight: 400, emRatio: 0.5769, size: 132, uppercase: true,
    color: "#FFFFFF", outline: 6, outlineColor: "#000000", outlineAlpha: 40, shadow: 0, shadowAlpha: 255,
    box: false, boxAlpha: 0, letterSpacing: 1, activeItalic: false, activeScale: 1.08,
  },
};

/** Layout shared by the ASS renderer and the browser preview so they match. */
export function captionLayout(style: CaptionStyle, width: number, height: number) {
  const p = PRESETS[style.preset];
  const scale = Math.min(width, height) / 1080;
  const fontSize = Math.round(p.size * scale * style.size);
  const vertical = height > width;
  // Lower captions sit above the Reels/TikTok UI (caption, buttons) on vertical video.
  const lowerMargin = vertical ? 0.26 : height === width ? 0.12 : 0.09;
  const marginV =
    style.position === "lower" ? Math.round(height * lowerMargin) : style.position === "upper" ? Math.round(height * (vertical ? 0.16 : 0.08)) : 0;
  const alignment = style.position === "lower" ? 2 : style.position === "middle" ? 5 : 8;
  return { fontSize, marginV, marginH: Math.round(width * 0.08), alignment, scale };
}

// ---------------- ASS rendering ----------------

function assColor(hex: string, alpha = 0) {
  const r = hex.slice(1, 3), g = hex.slice(3, 5), b = hex.slice(5, 7);
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${b}${g}${r}`.toUpperCase();
}
function assTime(t: number) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}
/** ASS has no escape for override braces or backslashes; neutralise them. */
function assText(s: string) {
  return s.replace(/\\/g, "∖").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\n/g, " ");
}

export interface AssOptions {
  width: number;
  height: number;
  /** Maps a source time to output time; segments outside [0, outDuration] are dropped. */
  map: (t: number) => number;
  outDuration: number;
  /** Disable fades (single-frame renders would otherwise catch a caption mid-fade). */
  still?: boolean;
}

export function buildAss(captions: Captions, o: AssOptions): string {
  const st = captions.style;
  const p = PRESETS[st.preset];
  const L = captionLayout(st, o.width, o.height);
  const sc = L.scale * st.size;
  const style = [
    "Caption", p.font, L.fontSize,
    assColor(p.color), assColor(st.highlight), assColor(p.outlineColor, p.outlineAlpha), p.box ? assColor(p.outlineColor, p.boxAlpha) : assColor("#000000", p.shadowAlpha),
    0, 0, 0, 0, 100, 100, (p.letterSpacing * sc).toFixed(1), 0,
    p.box ? 4 : 1, (p.outline * sc).toFixed(1), (p.shadow * sc).toFixed(1),
    L.alignment, L.marginH, L.marginH, L.marginV, 1,
  ].join(",");

  const lines: string[] = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${o.width}`, `PlayResY: ${o.height}`, "WrapStyle: 0",
    "ScaledBorderAndShadow: yes", "YCbCr Matrix: TV.709", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: ${style}`, "",
    "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const hl = assColor(st.highlight);
  const word = (w: CaptionWord) => assText(p.uppercase ? w.text.toLocaleUpperCase() : w.text);
  const active = (w: CaptionWord) => {
    const pop = p.activeScale !== 1 ? `\\fscx${Math.round(p.activeScale * 100)}\\fscy${Math.round(p.activeScale * 100)}` : "";
    return `{\\1c${hl}${p.activeItalic ? "\\i1" : ""}${pop}}${word(w)}{\\r}`;
  };

  if (!st.enabled) return lines.join("\n") + "\n";

  for (const seg of captions.segments) {
    const s = Math.max(0, o.map(seg.start));
    const e = Math.min(o.outDuration, o.map(seg.end));
    if (e - s < 0.05) continue;
    if (!st.animate) {
      lines.push(`Dialogue: 0,${assTime(s)},${assTime(e)},Caption,,0,0,0,,${o.still ? "" : "{\\fad(120,90)}"}${seg.words.map(word).join(" ")}`);
      continue;
    }
    // One event per active word: contiguous, so the line never flickers.
    seg.words.forEach((w, i) => {
      const ws = i === 0 ? s : Math.max(s, o.map(w.start));
      const we = i === seg.words.length - 1 ? e : Math.min(e, o.map(seg.words[i + 1].start));
      if (we - ws < 0.01) return;
      const fade = i === 0 && !o.still ? "{\\fad(120,0)}" : "";
      const text = seg.words.map((x, j) => (j === i ? active(x) : word(x))).join(" ");
      lines.push(`Dialogue: 0,${assTime(ws)},${assTime(we)},Caption,,0,0,0,,${fade}${text}`);
    });
  }
  return lines.join("\n") + "\n";
}

/** Escapes a path for use as a filter option value inside -filter_complex. */
export function escapeFilterPath(p: string) {
  // Unquoted, backslash-escaped at both parsing levels (quoting can't contain a quote).
  // level 1: filter option value
  const l1 = p.replace(/[\\':]/g, (c) => `\\${c}`);
  // level 2: filtergraph description
  return l1.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}
