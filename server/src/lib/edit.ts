import { z } from "zod";

export const ASPECTS = {
  "9:16": { width: 1080, height: 1920, label: "Reels / TikTok" },
  "1:1": { width: 1080, height: 1080, label: "Square feed" },
  "16:9": { width: 1920, height: 1080, label: "Landscape" },
} as const;
export type Aspect = keyof typeof ASPECTS;

export const LOOK_IDS = ["natural", "cinematic", "warm-luxe", "noir", "clean-bright", "film-fade", "emerald"] as const;
export type LookId = (typeof LOOK_IDS)[number];

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

export const editSchema = z.object({
  trimStart: z.number().min(0).default(0),
  /** null = until end of source */
  trimEnd: z.number().positive().nullable().default(null),
  aspect: z.enum(["9:16", "1:1", "16:9"]).default("9:16"),
  /** fill = crop to frame; blur = fit with blurred backdrop */
  fit: z.enum(["fill", "blur"]).default("fill"),
  /** Horizontal framing for fill crops: 0 = left, 0.5 = centre, 1 = right */
  focusX: z.number().min(0).max(1).default(0.5),
  focusY: z.number().min(0).max(1).default(0.5),
  look: z.enum(LOOK_IDS).default("natural"),
  lookIntensity: z.number().min(0).max(1).default(1),
  vignette: z.boolean().default(false),
  speed: z.literal(SPEEDS).default(1),
  /** Motion-interpolated slow motion (much slower render, smoother result). */
  smoothSlowMo: z.boolean().default(false),
  normalizeAudio: z.boolean().default(true),
  volume: z.number().min(0).max(2).default(1),
  fadeIn: z.number().min(0).max(3).default(0),
  fadeOut: z.number().min(0).max(3).default(0),
});

export type EditSettings = z.infer<typeof editSchema>;
export const defaultEdit = (): EditSettings => editSchema.parse({});

/** Effective trimmed segment in source seconds. Throws if invalid. */
export function segment(edit: EditSettings, sourceDuration: number) {
  const start = Math.min(edit.trimStart, sourceDuration);
  const end = Math.min(edit.trimEnd ?? sourceDuration, sourceDuration);
  if (end - start < 0.2) throw new Error("The trimmed clip is too short (minimum 0.2 seconds).");
  return { start, end, sourceLength: end - start, outputLength: (end - start) / edit.speed };
}
