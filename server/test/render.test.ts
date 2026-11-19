import { describe, expect, it } from "vitest";
import { editSchema } from "../src/lib/edit.js";
import type { MediaInfo } from "../src/lib/ffmpeg.js";
import { buildAudioGraph, buildExportArgs, buildVideoGraph } from "../src/lib/render.js";

const info: MediaInfo = {
  durationSec: 10, width: 1920, height: 1080, fps: 29.97, videoCodec: "h264", hasAudio: true,
  rotation: 0, isHdr: false, sizeBytes: 1, formatName: "mov,mp4",
};
const env = { zscale: true, x264Preset: "medium" };

describe("render graph", () => {
  it("crops to 1080x1920 for vertical fill", () => {
    const { graph, width, height } = buildVideoGraph(editSchema.parse({ aspect: "9:16" }), info, env);
    expect([width, height]).toEqual([1080, 1920]);
    expect(graph).toContain("crop=1080:1920");
    expect(graph.endsWith("[vout]")).toBe(true);
  });

  it("uses blurred backdrop composite for blur fit", () => {
    const { graph } = buildVideoGraph(editSchema.parse({ aspect: "1:1", fit: "blur" }), info, env);
    expect(graph).toContain("split=2");
    expect(graph).toContain("gblur");
    expect(graph).toContain("overlay");
  });

  it("applies slow motion to video and audio and places fade-out at output end", () => {
    const edit = editSchema.parse({ speed: 0.5, trimStart: 2, trimEnd: 6, fadeOut: 1 });
    const v = buildVideoGraph(edit, info, env).graph;
    expect(v).toContain("setpts=PTS/0.5");
    expect(v).toContain("fade=t=out:st=7.000:d=1"); // 4s source / 0.5 = 8s output
    const a = buildAudioGraph(edit, info)!;
    expect(a).toContain("atempo=0.5");
    expect(a).toContain("loudnorm=I=-14");
  });

  it("tone-maps HDR sources only when zscale is available", () => {
    const hdr = { ...info, isHdr: true };
    expect(buildVideoGraph(editSchema.parse({}), hdr, env).graph).toContain("tonemap");
    expect(buildVideoGraph(editSchema.parse({}), hdr, { ...env, zscale: false }).graph).not.toContain("tonemap");
  });

  it("omits audio when source has none", () => {
    const { args } = buildExportArgs("in.mp4", "out.mp4", editSchema.parse({}), { ...info, hasAudio: false }, env);
    expect(args).not.toContain("[aout]");
  });

  it("rejects a trim that is too short", () => {
    expect(() => buildExportArgs("in", "out", editSchema.parse({ trimStart: 5, trimEnd: 5.1 }), info, env)).toThrow(/too short/);
  });

  it("rejects unsupported speeds", () => {
    expect(editSchema.safeParse({ speed: 3 }).success).toBe(false);
    expect(editSchema.parse({ speed: 0.75 }).speed).toBe(0.75);
  });
});
