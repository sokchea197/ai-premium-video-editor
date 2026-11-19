import type { LookId } from "./edit.js";

/**
 * Colour grades as FFmpeg filter chains. Each look is expressed as parameters
 * scaled by intensity (0..1) so the same grade can be dialled in subtly.
 * The web client mirrors these with CSS filters for live preview; the
 * "true frame" preview renders the exact chain below.
 */
interface LookParams {
  contrast?: number; // eq contrast delta (1 + x)
  brightness?: number; // eq brightness delta
  saturation?: number; // eq saturation delta (1 + x)
  gamma?: number;
  // colorbalance shadows/mids/highlights, r/g/b
  balance?: Partial<Record<"rs" | "gs" | "bs" | "rm" | "gm" | "bm" | "rh" | "gh" | "bh", number>>;
  /** lift blacks / roll highlights (film fade) */
  lift?: number;
  roll?: number;
  mono?: boolean;
}

export const LOOKS: Record<LookId, { name: string; description: string; params: LookParams }> = {
  natural: { name: "Natural", description: "True-to-life colour, gently refined.", params: { contrast: 0.03, saturation: 0.04 } },
  cinematic: {
    name: "Cinematic",
    description: "Teal shadows, warm skin, deep contrast.",
    params: { contrast: 0.12, saturation: 0.02, balance: { rs: -0.06, bs: 0.08, rh: 0.07, bh: -0.06, rm: 0.02 } },
  },
  "warm-luxe": {
    name: "Warm Luxe",
    description: "Golden-hour warmth with soft richness.",
    params: { contrast: 0.06, brightness: 0.015, saturation: 0.1, balance: { rm: 0.05, bm: -0.05, rh: 0.04, bh: -0.04 } },
  },
  noir: { name: "Noir", description: "Monochrome with sculpted contrast.", params: { mono: true, contrast: 0.22, brightness: -0.02 } },
  "clean-bright": {
    name: "Clean Bright",
    description: "Airy, luminous and crisp.",
    params: { brightness: 0.04, contrast: 0.04, saturation: 0.12, gamma: 0.05 },
  },
  "film-fade": {
    name: "Film Fade",
    description: "Lifted blacks and muted, editorial tones.",
    params: { lift: 0.07, roll: 0.05, saturation: -0.15, balance: { rs: 0.02, bs: 0.03 } },
  },
  emerald: {
    name: "Emerald",
    description: "Cool, moody greens for a luxury feel.",
    params: { contrast: 0.1, saturation: -0.05, balance: { gs: 0.04, bs: 0.03, gm: 0.02, rh: 0.03 } },
  },
};

const f = (n: number) => Number(n.toFixed(4)).toString();

export function lookFilters(look: LookId, intensity: number, vignette: boolean): string[] {
  const p = LOOKS[look].params;
  const k = Math.max(0, Math.min(1, intensity));
  const out: string[] = [];
  if (p.mono) out.push(`hue=s=${f(1 - k)}`);
  if (p.balance) {
    const parts = Object.entries(p.balance).map(([key, v]) => `${key}=${f((v ?? 0) * k)}`);
    out.push(`colorbalance=${parts.join(":")}`);
  }
  if (p.lift || p.roll) {
    const lo = (p.lift ?? 0) * k;
    const hi = 1 - (p.roll ?? 0) * k;
    out.push(`curves=all='0/${f(lo)} 1/${f(hi)}'`);
  }
  const eq: string[] = [];
  if (p.contrast) eq.push(`contrast=${f(1 + p.contrast * k)}`);
  if (p.brightness) eq.push(`brightness=${f(p.brightness * k)}`);
  if (p.saturation) eq.push(`saturation=${f(1 + p.saturation * k)}`);
  if (p.gamma) eq.push(`gamma=${f(1 + p.gamma * k)}`);
  if (eq.length) out.push(`eq=${eq.join(":")}`);
  if (vignette) out.push("vignette=angle=PI/5");
  return out;
}
