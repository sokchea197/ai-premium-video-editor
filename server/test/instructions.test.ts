import { describe, expect, it } from "vitest";
import { defaultEdit } from "../src/lib/edit.js";
import { interpret } from "../src/lib/instructions.js";

const run = (t: string, dur = 60) => interpret(t, defaultEdit(), dur);

describe("plain-English edit instructions (local, free)", () => {
  it("handles a typical personal-branding request", () => {
    const p = run("Make it vertical for Reels, cinematic look with a vignette, add bold captions at the bottom with gold highlight, and fade out at the end");
    expect(p.edit).toMatchObject({ aspect: "9:16", look: "cinematic", vignette: true, fadeOut: 0.8 });
    expect(p.captionStyle).toMatchObject({ enabled: true, preset: "bold-pop", position: "lower", highlight: "#E3CB98" });
    expect(p.transcribe).toBe(true);
    expect(p.notUnderstood).toEqual([]);
  });

  it("trims by first/last seconds, ranges and target length", () => {
    expect(run("cut the first 3 seconds").edit.trimStart).toBe(3);
    expect(run("trim the first 1.5 seconds. then fade in").edit).toMatchObject({ trimStart: 1.5, fadeIn: 0.6 });
    expect(run("remove the last 5 seconds", 40).edit.trimEnd).toBe(35);
    expect(run("keep from 0:05 to 0:20").edit).toMatchObject({ trimStart: 5, trimEnd: 20 });
    expect(run("make it 30 seconds long").edit.trimEnd).toBe(30);
    // 30 s output at 0.5x needs 15 s of source
    expect(run("slow motion, make it 30 seconds").edit).toMatchObject({ speed: 0.5, trimEnd: 15 });
  });

  it("maps looks, speed and sound", () => {
    expect(run("black and white").edit.look).toBe("noir");
    expect(run("warm golden hour vibe").edit.look).toBe("warm-luxe");
    expect(run("vintage film look, subtle grade").edit).toMatchObject({ look: "film-fade", lookIntensity: 0.5 });
    expect(run("slightly slower").edit.speed).toBe(0.75);
    expect(run("speed it up").edit.speed).toBe(1.5);
    expect(run("smooth slow motion").edit).toMatchObject({ speed: 0.5, smoothSlowMo: true });
    expect(run("balance the audio").edit.normalizeAudio).toBe(true);
    expect(run("mute it").edit.volume).toBe(0);
  });

  it("handles framing and caption variations", () => {
    expect(run("square, blurred background").edit).toMatchObject({ aspect: "1:1", fit: "blur" });
    expect(run("elegant serif subtitles in the middle").captionStyle).toMatchObject({ preset: "editorial", position: "middle" });
    expect(run("remove the captions").captionStyle.enabled).toBe(false);
    expect(run("remove the captions").transcribe).toBe(false);
  });

  it("reports what it did not understand instead of guessing", () => {
    const p = run("make it vertical, add a drone shot of Paris and a dancing cat");
    expect(p.edit.aspect).toBe("9:16");
    expect(p.notUnderstood.join(" ")).toMatch(/drone shot of paris/);
  });
});
