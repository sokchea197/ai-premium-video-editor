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

beforeAll(async () => {
  fx = makeFixtures();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ave-up-"));
  ctx = await createApp({ dataDir, x264Preset: "ultrafast" });
}, 60_000);
afterAll(() => {
  fx.cleanup();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function chunked(buf: Buffer, name: string, chunk = 1024 * 1024) {
  const c = await request(ctx.app).post("/api/uploads").send({ name, size: buf.length });
  expect(c.status).toBe(201);
  for (let off = 0; off < buf.length; off += chunk) {
    const r = await request(ctx.app).put(`/api/uploads/${c.body.id}?offset=${off}`).set("Content-Type", "application/octet-stream").send(buf.subarray(off, off + chunk));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  return c.body.id as string;
}

describe("resumable chunked upload", () => {
  it("uploads a MOV in chunks and creates a ready project", async () => {
    const buf = fs.readFileSync(fx.portraitMov);
    const id = await chunked(buf, "IMG_0001.MOV", 64 * 1024);
    const done = await request(ctx.app).post(`/api/uploads/${id}/complete`).send({});
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.name).toBe("IMG_0001");
    const job = await ctx.jobs.wait(done.body.media.jobId);
    expect(job.status).toBe("done");
  }, 60_000);

  it("accepts videos whose names have no or wrong extensions (content is what counts)", async () => {
    for (const name of ["video", "clip.dat", "My Reel (final).MP4"]) {
      const id = await chunked(fs.readFileSync(fx.landscape), name);
      const done = await request(ctx.app).post(`/api/uploads/${id}/complete`).send({});
      expect(done.status, `${name}: ${JSON.stringify(done.body)}`).toBe(201);
    }
  }, 60_000);

  it("resyncs after an out-of-order or repeated chunk (resume after a dropped connection)", async () => {
    const buf = fs.readFileSync(fx.landscape);
    const c = await request(ctx.app).post("/api/uploads").send({ name: "a.mp4", size: buf.length });
    const half = 200_000;
    await request(ctx.app).put(`/api/uploads/${c.body.id}?offset=0`).set("Content-Type", "application/octet-stream").send(buf.subarray(0, half)).expect(200);
    // client lost the response and resends the same chunk:
    const dup = await request(ctx.app).put(`/api/uploads/${c.body.id}?offset=0`).set("Content-Type", "application/octet-stream").send(buf.subarray(0, half));
    expect(dup.status).toBe(409);
    expect(dup.body.received).toBe(half);
    // resume from what the server reports
    const st = await request(ctx.app).get(`/api/uploads/${c.body.id}`);
    expect(st.body.received).toBe(half);
    await request(ctx.app).put(`/api/uploads/${c.body.id}?offset=${half}`).set("Content-Type", "application/octet-stream").send(buf.subarray(half)).expect(200);
    await request(ctx.app).post(`/api/uploads/${c.body.id}/complete`).send({}).expect(201);
  }, 60_000);

  it("refuses to complete an unfinished upload and rejects non-videos by content", async () => {
    const c = await request(ctx.app).post("/api/uploads").send({ name: "x.mp4", size: 1000 });
    expect((await request(ctx.app).post(`/api/uploads/${c.body.id}/complete`).send({})).status).toBe(409);
    const id = await chunked(Buffer.from("definitely not a video, just text pretending"), "fake.mov");
    const bad = await request(ctx.app).post(`/api/uploads/${id}/complete`).send({});
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatch(/isn't a video/);
    expect(fs.readdirSync(path.join(dataDir, "tmp")).filter((f) => f.includes(id))).toEqual([]);
  });

  it("enforces the size limit up front with a clear message", async () => {
    const r = await request(ctx.app).post("/api/uploads").send({ name: "huge.mov", size: 50 * 1024 ** 3 });
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/limit is 20 GB/);
  });

  it("cancels and removes a partial upload", async () => {
    const c = await request(ctx.app).post("/api/uploads").send({ name: "x.mp4", size: 5000 });
    await request(ctx.app).delete(`/api/uploads/${c.body.id}`).expect(204);
    expect((await request(ctx.app).get(`/api/uploads/${c.body.id}`)).status).toBe(404);
  });
});
