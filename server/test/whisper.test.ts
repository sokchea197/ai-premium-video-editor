import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

/**
 * Real, local Whisper on real speech (public-domain JFK inaugural excerpt).
 * First run downloads the free "base" model (~76 MB) into a shared cache.
 */
const cache = process.env.WHISPER_CACHE_DIR ?? path.join(os.tmpdir(), "ave-whisper-cache");
let ctx: Awaited<ReturnType<typeof createApp>>;
let dir: string;
let video: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ave-whisper-"));
  video = path.join(dir, "speech.mov");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x223344:s=720x1280:d=11", "-i", path.resolve("test/assets/jfk.wav"),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video]);
  ctx = await createApp({ dataDir: path.join(dir, "data"), whisperCacheDir: cache, x264Preset: "ultrafast" });
}, 60_000);

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("local Whisper (real model, real speech)", () => {
  it("transcribes speech with accurate word timestamps and builds captions", async () => {
    const up = await request(ctx.app).post("/api/projects").attach("video", video);
    expect(up.status).toBe(201);
    await ctx.jobs.wait(up.body.media.jobId);
    await new Promise((r) => setTimeout(r, 50));
    const res = await request(ctx.app).post(`/api/projects/${up.body.id}/transcribe`).send({ language: "en", model: "base" });
    expect(res.status).toBe(202);
    const job = await ctx.jobs.wait(res.body.job.id);
    expect(job.status, job.error).toBe("done");
    await new Promise((r) => setTimeout(r, 50));
    const p = (await request(ctx.app).get(`/api/projects/${up.body.id}`)).body;
    const text = p.transcript.words.map((w: any) => w.text).join(" ").toLowerCase();
    expect(text).toContain("fellow americans");
    expect(text).toContain("what you can do for your country");
    const w = (needle: string) => p.transcript.words.find((x: any) => x.text.toLowerCase().startsWith(needle));
    // Known timings in this recording: "Americans" ≈ 2.1 s, "country" (last) ≈ 9.9–10.3 s
    expect(w("americans").start).toBeGreaterThan(1.6);
    expect(w("americans").start).toBeLessThan(2.6);
    const last = p.transcript.words[p.transcript.words.length - 1];
    expect(last.start).toBeGreaterThan(9);
    expect(last.end).toBeLessThan(11.2);
    for (let i = 1; i < p.transcript.words.length; i++) expect(p.transcript.words[i].start).toBeGreaterThanOrEqual(p.transcript.words[i - 1].start);
    expect(p.captions.segments.length).toBeGreaterThan(1);
  }, 300_000);
});
