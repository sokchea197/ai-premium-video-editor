import type { LookId } from "./types";

/**
 * CSS approximations of the server-side FFmpeg grades, for instant live preview.
 * "True frame" in the editor renders the exact FFmpeg result.
 */
type Fn = [name: string, value: number, identity: number, unit?: string];
const LOOK_CSS: Record<LookId, Fn[]> = {
  natural: [["contrast", 1.03, 1], ["saturate", 1.04, 1]],
  cinematic: [["contrast", 1.12, 1], ["sepia", 0.1, 0], ["hue-rotate", -10, 0, "deg"], ["saturate", 1.05, 1]],
  "warm-luxe": [["sepia", 0.2, 0], ["saturate", 1.18, 1], ["contrast", 1.06, 1], ["brightness", 1.02, 1]],
  noir: [["grayscale", 1, 0], ["contrast", 1.22, 1], ["brightness", 0.98, 1]],
  "clean-bright": [["brightness", 1.07, 1], ["contrast", 1.04, 1], ["saturate", 1.12, 1]],
  "film-fade": [["contrast", 0.88, 1], ["saturate", 0.85, 1], ["brightness", 1.04, 1], ["sepia", 0.06, 0]],
  emerald: [["contrast", 1.1, 1], ["saturate", 0.95, 1], ["hue-rotate", 10, 0, "deg"]],
};

export function lookCss(look: LookId, intensity: number) {
  return LOOK_CSS[look]
    .map(([name, v, id, unit = ""]) => `${name}(${(id + (v - id) * intensity).toFixed(3)}${unit})`)
    .join(" ");
}

/** Swatch gradients that hint each look's palette. */
export const LOOK_SWATCH: Record<LookId, string> = {
  natural: "linear-gradient(135deg,#d9c7b0,#7d6a58)",
  cinematic: "linear-gradient(135deg,#e7a46a,#1f4b57)",
  "warm-luxe": "linear-gradient(135deg,#f2c98a,#8a5a2b)",
  noir: "linear-gradient(135deg,#e6e6e6,#111)",
  "clean-bright": "linear-gradient(135deg,#ffffff,#b9d4e8)",
  "film-fade": "linear-gradient(135deg,#cbbfb0,#5d5752)",
  emerald: "linear-gradient(135deg,#9fc9a8,#0d3b30)",
};
