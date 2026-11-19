import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { buildAss } from "../src/lib/captions.js";
import { makeFixtures } from "./fixtures.js";
import type { TranscribeRequest, Transcriber } from "../src/lib/whisper/index.js";

let fx: ReturnType<typeof makeFixtures>;

/** Stand-in for Whisper so caption/export tests are fast; real Whisper is tested in whisper.test.ts. */
const fake = {
  mode: "ok" as "ok" | "fail" | "empty" | "slow",
  last: null as TranscribeRequest | null,
  words: [["Hi,", 0.2, 0.45], ["I'm", 0.5, 0.7], ["Sokchea.", 0.75, 1.2], ["Welcome", 1.6, 1.95], ["to", 2.0, 2.1], ["my", 2.15, 2.3], ["studio.", 2.35, 2.9]]
    .map(([text, start, end]) => ({ text: String(text), start: Number(start), end: Number(end), confidence: 1 })),
};
const fakeTranscriber: Transcriber = {
  async transcribe(req) {
    fake.last = req;
    req.onProgress?.(0.5);
    if (fake.mode === "slow") await new Promise((r, j) => { const t = setTimeout(r, 5000); req.signal?.addEventListener("abort", () => { clearTimeout(t); j(new Error("Cancelled")); }); });
    if (fake.mode === "fail") throw new Error("Speech recognition failed: model error");
    return { provider: "whisper", model: `whisper-${req.model}`, language: req.language, audioDurationSec: req.audio.length / 16000, createdAt: new Date().toISOString(), words: fake.mode === "empty" ? [] : fake.words };
  },
};
let ctx: Awaited<ReturnType<typeof createApp>>;
let dataDir: string;

async function ready(file: string) {
  const res = await request(ctx.app).post("/api/projects").attach("video", file);
  expect(res.status).toBe(201);
  await ctx.jobs.wait(res.body.media.jobId);
  await new Promise((r) => setTimeout(r, 50));
  return res.body.id as string;
}
async function transcribe(id: string, body: object = {}) {
  const res = await request(ctx.app).post(`/api/projects/${id}/transcribe`).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  const job = await ctx.jobs.wait(res.body.job.id);
  await new Promise((r) => setTimeout(r, 50));
  return { job, project: (await request(ctx.app).get(`/api/projects/${id}`)).body };
}

beforeAll(async () => {
  fx = makeFixtures();
  // Awkward characters in the data path exercise filtergraph escaping for real.
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ave it's:a,[test] "));
  ctx = await createApp({ dataDir, x264Preset: "ultrafast", concurrency: 2 }, { transcriber: fakeTranscriber });
}, 60_000);

afterAll(async () => {
  fx?.cleanup();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("Whisper transcription → captions → burned-in export", () => {
  it("advertises free local transcription", async () => {
    const res = await request(ctx.app).get("/api/health");
    expect(res.body.ai.transcription).toMatchObject({ available: true, provider: "whisper", local: true, costUsd: 0 });
  });

  it("transcribes, builds synchronised captions, edits them, and burns them into a 9:16 export", async () => {
    const id = await ready(fx.landscape);
    const { job, project } = await transcribe(id, { language: "en", model: "base" });
    expect(job.status, job.error).toBe("done");

    // Whisper receives 16 kHz mono PCM covering the whole clip
    expect(fake.last!.model).toBe("base");
    expect(fake.last!.language).toBe("en");
    expect(fake.last!.audio.length / 16000).toBeCloseTo(4, 0);
    expect(Math.max(...fake.last!.audio.subarray(0, 16000).map(Math.abs))).toBeGreaterThan(0.05);

    expect(project.transcript.words).toHaveLength(7);
    expect(project.transcript.provider).toBe("whisper");
    const segs = project.captions.segments;
    expect(segs.map((s: any) => s.words.map((w: any) => w.text).join(" "))).toEqual(["Hi, I'm Sokchea.", "Welcome to my studio."]);
    expect(segs[0].start).toBe(0.2);

    // Edit caption text + style
    const edited = structuredClone(segs);
    edited[1].words = [{ text: "Welcome", start: 1.6, end: 1.95 }, { text: "to", start: 2, end: 2.1 }, { text: "Premium", start: 2.15, end: 2.4 }, { text: "Studio.", start: 2.45, end: 2.9 }];
    const patch = await request(ctx.app).patch(`/api/projects/${id}`).send({ captions: { segments: edited, style: { preset: "editorial", position: "middle" } } });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body.captions.edited).toBe(true);
    expect(patch.body.captions.style.preset).toBe("editorial");

    // Exact-frame preview shows captions (differs from the same frame with captions off)
    const withCaps = (await request(ctx.app).get(`/api/projects/${id}/frame?t=2.5`)).body as Buffer;
    await request(ctx.app).patch(`/api/projects/${id}`).send({ captions: { style: { enabled: false } } }).expect(200);
    const without = (await request(ctx.app).get(`/api/projects/${id}/frame?t=2.5`)).body as Buffer;
    expect(withCaps.length).toBeGreaterThan(1000);
    expect(Buffer.compare(withCaps, without)).not.toBe(0);
    await request(ctx.app).patch(`/api/projects/${id}`).send({ captions: { style: { enabled: true, preset: "bold-pop", position: "lower" } }, edit: { aspect: "9:16", trimStart: 0.5, speed: 1 } }).expect(200);

    // Export with burned-in captions through the escaped awkward path
    const ex = await request(ctx.app).post(`/api/projects/${id}/exports`).send();
    expect(ex.status).toBe(202);
    const ej = await ctx.jobs.wait(ex.body.job.id);
    expect(ej.status, `${ej.error}\n${ej.detail}`).toBe("done");
    // temporary .ass files are cleaned up
    expect(fs.readdirSync(path.join(dataDir, "projects", id)).filter((f) => f.endsWith(".ass"))).toEqual([]);
  }, 120_000);

  it("rejects invalid caption edits", async () => {
    const p = (await request(ctx.app).get("/api/projects")).body.find((x: any) => x.captions);
    const bad = await request(ctx.app).patch(`/api/projects/${p.id}`).send({ captions: { segments: [{ id: "a", start: 1, end: 2, words: [] }] } });
    expect(bad.status).toBe(400);
    const badStyle = await request(ctx.app).patch(`/api/projects/${p.id}`).send({ captions: { style: { highlight: "red" } } });
    expect(badStyle.status).toBe(400);
  });

  it("regroups captions from the transcript", async () => {
    const p = (await request(ctx.app).get("/api/projects")).body.find((x: any) => x.captions);
    const res = await request(ctx.app).post(`/api/projects/${p.id}/captions/regroup`).send({ chunking: "punchy" });
    expect(res.status).toBe(200);
    expect(res.body.captions.edited).toBe(false);
    for (const s of res.body.captions.segments) expect(s.words.length).toBeLessThanOrEqual(3);
  });

  it("reports recognition failures clearly and never as success", async () => {
    fake.mode = "fail";
    const id = await ready(fx.portraitMov);
    const { job, project } = await transcribe(id);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/Speech recognition failed/);
    expect(project.transcription.status).toBe("failed");
    expect(project.captions).toBeNull();
    fake.mode = "ok";
  }, 60_000);

  it("can cancel a transcription", async () => {
    fake.mode = "slow";
    const id = (await request(ctx.app).get("/api/projects")).body.find((x: any) => x.source.info.hasAudio).id;
    const res = await request(ctx.app).post(`/api/projects/${id}/transcribe`).send({});
    await new Promise((r) => setTimeout(r, 300));
    await request(ctx.app).post(`/api/jobs/${res.body.job.id}/cancel`).expect(200);
    const job = await ctx.jobs.wait(res.body.job.id);
    expect(job.status).toBe("cancelled");
    fake.mode = "ok";
  }, 60_000);

  it("handles clips with no speech honestly", async () => {
    fake.mode = "empty";
    const id = (await request(ctx.app).get("/api/projects")).body.find((x: any) => x.source.info.hasAudio && x.transcription.status !== "running").id;
    const { job, project } = await transcribe(id);
    expect(job.status).toBe("done");
    expect(project.captions.segments).toEqual([]);
    fake.mode = "ok";
  }, 60_000);

  it("refuses to transcribe silent videos", async () => {
    const id = await ready(fx.silent);
    const res = await request(ctx.app).post(`/api/projects/${id}/transcribe`).send({});
    expect(res.status).toBe(422);
  }, 60_000);

  it("serves bundled fonts and libass uses them (no fallback fonts)", async () => {
    expect((await request(ctx.app).get("/api/fonts/Poppins-ExtraBold.ttf")).status).toBe(200);
    expect((await request(ctx.app).get("/api/fonts/..%2Fpackage.json")).status).toBe(404);
    const fonts = path.resolve("assets/fonts");
    for (const preset of ["bold-pop", "editorial", "minimal", "impact"] as const) {
      const ass = path.join(fx.dir, `${preset}.ass`);
      fs.writeFileSync(ass, buildAss({ edited: false, style: { enabled: true, preset, position: "lower", size: 1, highlight: "#E3CB98", animate: true, chunking: "balanced" },
        segments: [{ id: "1", start: 0, end: 1, words: [{ text: "Premium", start: 0, end: 0.5 }, { text: "studio", start: 0.5, end: 1 }] }] }, { width: 1080, height: 1920, outDuration: 1, map: (t) => t }));
      const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "verbose", "-f", "lavfi", "-i", "color=black:s=1080x1920:d=0.5", "-vf", `ass=${ass}:fontsdir=${fonts}`, "-frames:v", "1", "-f", "null", "-"]);
      const log = r.stderr.toString();
      const selected = [...log.matchAll(/fontselect: \(([^,]+),[^)]*\) -> (\S+)/g)].map((m) => [m[1], path.basename(m[2])]);
      expect(selected.length, log.slice(-1500)).toBeGreaterThan(0);
      for (const [, file] of selected) expect(file, `${preset} fell back to ${file}`).toMatch(/^(Poppins|Anton|DMSerif)/);
    }
  }, 60_000);
});

describe("optional app password", () => {
  it("requires HTTP Basic auth when APP_PASSWORD is set", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ave-auth-"));
    const app3 = await createApp({ dataDir: dir, appPassword: "s3cret pass" });
    expect((await request(app3.app).get("/api/health")).status).toBe(401);
    expect((await request(app3.app).get("/api/health").auth("me", "wrong")).status).toBe(401);
    expect((await request(app3.app).get("/api/health").auth("me", "s3cret pass")).status).toBe(200);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});



describe("plain-English instructions endpoint", () => {
  it("previews, then applies edits and starts free transcription with the requested caption style", async () => {
    fake.mode = "ok";
    const id = await ready(fx.landscape);
    const text = "Vertical for TikTok, black and white, cut the first 0.5 seconds, add elegant captions at the top";
    const preview = await request(ctx.app).post(`/api/projects/${id}/instructions`).send({ text });
    expect(preview.status).toBe(200);
    expect(preview.body.willTranscribe).toBe(true);
    expect(preview.body.plan.notUnderstood).toEqual([]);
    // preview does not change the project
    expect((await request(ctx.app).get(`/api/projects/${id}`)).body.edit.look).toBe("natural");

    const applied = await request(ctx.app).post(`/api/projects/${id}/instructions`).send({ text, apply: true });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.project.edit).toMatchObject({ aspect: "9:16", look: "noir", trimStart: 0.5 });
    expect(applied.body.job).toBeTruthy();
    await ctx.jobs.wait(applied.body.job.id);
    await new Promise((r) => setTimeout(r, 50));
    const p = (await request(ctx.app).get(`/api/projects/${id}`)).body;
    expect(p.captions.style).toMatchObject({ preset: "editorial", position: "upper", enabled: true });
    expect(p.captions.segments.length).toBeGreaterThan(0);

    const nothing = await request(ctx.app).post(`/api/projects/${id}/instructions`).send({ text: "make it sparkle like unicorns", apply: true });
    expect(nothing.status).toBe(422);
  }, 60_000);
});
