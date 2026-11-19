import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { makeFixtures } from "./fixtures.js";

let ctx: Awaited<ReturnType<typeof createApp>>;
let fx: ReturnType<typeof makeFixtures>;
let dataDir: string;

function ffprobe(file: string) {
  const out = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]).toString());
  const v = out.streams.find((s: any) => s.codec_type === "video");
  const a = out.streams.find((s: any) => s.codec_type === "audio");
  return { width: v.width, height: v.height, codec: v.codec_name, pix: v.pix_fmt, audio: a?.codec_name, duration: Number(out.format.duration) };
}

async function uploadAndIngest(file: string) {
  const res = await request(ctx.app).post("/api/projects").attach("video", file);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const job = await ctx.jobs.wait(res.body.media.jobId);
  expect(job.status, job.error).toBe("done");
  await new Promise((r) => setTimeout(r, 50)); // let the store record completion
  return (await request(ctx.app).get(`/api/projects/${res.body.id}`)).body;
}

async function exportAndDownload(id: string) {
  const res = await request(ctx.app).post(`/api/projects/${id}/exports`).send();
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  const job = await ctx.jobs.wait(res.body.job.id);
  expect(job.status, `${job.error}\n${job.detail}`).toBe("done");
  await new Promise((r) => setTimeout(r, 100));
  const proj = (await request(ctx.app).get(`/api/projects/${id}`)).body;
  const rec = proj.exports.find((e: any) => e.id === res.body.export.id);
  expect(rec.status).toBe("done");
  const dl = await request(ctx.app).get(rec.downloadUrl).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on("data", (c: Buffer) => chunks.push(c));
    r.on("end", () => cb(null, Buffer.concat(chunks)));
  });
  expect(dl.status).toBe(200);
  const out = path.join(fx.dir, `${rec.id}.mp4`);
  fs.writeFileSync(out, dl.body);
  return ffprobe(out);
}

beforeAll(async () => {
  fx = makeFixtures();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ave-data-"));
  ctx = await createApp({ dataDir, x264Preset: "ultrafast", concurrency: 2 });
}, 60_000);

afterAll(() => {
  fx?.cleanup();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("upload → preview → edit → export", () => {
  it("reports capabilities honestly", async () => {
    const res = await request(ctx.app).get("/api/health");
    expect(res.body.ffmpeg.libx264).toBe(true);
    expect(res.body.ai.transcription.available).toBe(false);
  });

  it("rejects non-video uploads with clear errors", async () => {
    const txt = await request(ctx.app).post("/api/projects").attach("video", fx.text);
    expect(txt.status).toBe(422);
    expect(txt.body.error).toMatch(/isn't a video/);
    const fake = await request(ctx.app).post("/api/projects").attach("video", fx.fake);
    expect(fake.status).toBe(422);
    const none = await request(ctx.app).post("/api/projects");
    expect(none.status).toBe(400);
  });

  it("ingests landscape MP4 and exports vertical 9:16 1080p with grade, slow-mo and fades", async () => {
    const p = await uploadAndIngest(fx.landscape);
    expect(p.media.status).toBe("ready");
    expect(p.source.info).toMatchObject({ width: 1920, height: 1080, hasAudio: true });
    expect(p.edit).toMatchObject({ aspect: "9:16", fit: "blur" });
    for (const k of ["proxy", "thumb", "filmstrip"]) {
      expect((await request(ctx.app).get(p.urls[k])).status).toBe(200);
    }
    const patch = await request(ctx.app).patch(`/api/projects/${p.id}`).send({
      edit: { aspect: "9:16", fit: "fill", look: "cinematic", vignette: true, trimStart: 0.5, trimEnd: 2.5, speed: 0.5, fadeIn: 0.3, fadeOut: 0.5 },
    });
    expect(patch.status).toBe(200);
    const frame = await request(ctx.app).get(`/api/projects/${p.id}/frame?t=1`);
    expect(frame.status).toBe(200);
    expect(frame.headers["content-type"]).toMatch(/jpeg/);

    const out = await exportAndDownload(p.id);
    expect(out).toMatchObject({ width: 1080, height: 1920, codec: "h264", pix: "yuv420p", audio: "aac" });
    expect(out.duration).toBeGreaterThan(3.7); // 2s source at 0.5x = 4s
    expect(out.duration).toBeLessThan(4.3);
  }, 120_000);

  it("handles rotated iPhone-style MOV and exports square with blurred backdrop", async () => {
    const p = await uploadAndIngest(fx.portraitMov);
    expect(p.source.info.height).toBeGreaterThan(p.source.info.width); // rotation honoured
    expect(p.edit.aspect).toBe("9:16");
    expect(p.edit.fit).toBe("fill");
    await request(ctx.app).patch(`/api/projects/${p.id}`).send({ edit: { aspect: "1:1", fit: "blur", look: "warm-luxe" } }).expect(200);
    const out = await exportAndDownload(p.id);
    expect(out).toMatchObject({ width: 1080, height: 1080 });
  }, 120_000);

  it("exports landscape 16:9 from a silent clip", async () => {
    const p = await uploadAndIngest(fx.silent);
    await request(ctx.app).patch(`/api/projects/${p.id}`).send({ edit: { aspect: "16:9", fit: "blur", look: "noir", speed: 2 } }).expect(200);
    const out = await exportAndDownload(p.id);
    expect(out).toMatchObject({ width: 1920, height: 1080 });
    expect(out.audio).toBeUndefined();
    expect(out.duration).toBeLessThan(1.3);
  }, 120_000);

  it("validates edits and reports invalid ones", async () => {
    const p = (await request(ctx.app).get("/api/projects")).body[0];
    const bad = await request(ctx.app).patch(`/api/projects/${p.id}`).send({ edit: { speed: 7 } });
    expect(bad.status).toBe(400);
    const short = await request(ctx.app).patch(`/api/projects/${p.id}`).send({ edit: { trimStart: 1, trimEnd: 1.05 } });
    expect(short.status).toBe(400);
    expect(short.body.error).toMatch(/too short/);
  });

  it("cancels a running export and records it as cancelled, not done", async () => {
    const p = (await request(ctx.app).get("/api/projects")).body.find((x: any) => x.source.info.width === 1920);
    await request(ctx.app).patch(`/api/projects/${p.id}`).send({ edit: { trimStart: 0, trimEnd: null, speed: 0.5, smoothSlowMo: true } }).expect(200);
    const res = await request(ctx.app).post(`/api/projects/${p.id}/exports`).send().expect(202);
    await new Promise((r) => setTimeout(r, 300));
    await request(ctx.app).post(`/api/jobs/${res.body.job.id}/cancel`).expect(200);
    const job = await ctx.jobs.wait(res.body.job.id);
    expect(job.status).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 100));
    const proj = (await request(ctx.app).get(`/api/projects/${p.id}`)).body;
    const rec = proj.exports.find((e: any) => e.id === res.body.export.id);
    expect(rec.status).toBe("cancelled");
    expect(rec.downloadUrl).toBeNull();
  }, 60_000);

  it("deletes a project and its files", async () => {
    const p = (await request(ctx.app).get("/api/projects")).body[0];
    await request(ctx.app).delete(`/api/projects/${p.id}`).expect(204);
    await request(ctx.app).get(`/api/projects/${p.id}`).expect(404);
    expect(fs.existsSync(path.join(dataDir, "projects", p.id))).toBe(false);
  });
});
