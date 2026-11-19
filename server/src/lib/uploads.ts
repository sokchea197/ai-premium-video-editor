import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const CHUNK_SIZE = 8 * 1024 * 1024;

interface Upload {
  id: string;
  name: string;
  size: number;
  received: number;
  file: string;
  touched: number;
  /** Serialises writes so retried/overlapping chunks can't interleave. */
  lock: Promise<void>;
}

export class UploadError extends Error {
  constructor(readonly status: number, message: string, readonly received?: number) {
    super(message);
  }
}

/**
 * Resumable chunked uploads. Phones drop long single requests (screen lock,
 * app switch, Wi-Fi blips); here each 8 MB chunk is retried independently and
 * an interrupted upload continues from the last byte the server has.
 */
export class UploadManager {
  private uploads = new Map<string, Upload>();

  constructor(private dir: string, private maxBytes: number) {
    // Remove abandoned partial uploads older than a day.
    setInterval(() => void this.sweep(24 * 3600_000), 3600_000).unref();
    void this.sweep(24 * 3600_000);
  }

  async create(name: string, size: number) {
    if (!Number.isFinite(size) || size <= 0) throw new UploadError(400, "The file is empty.");
    if (size > this.maxBytes)
      throw new UploadError(413, `This file is ${(size / 1024 ** 3).toFixed(1)} GB. The limit is ${(this.maxBytes / 1024 ** 3).toFixed(0)} GB.`);
    const id = randomUUID();
    const file = path.join(this.dir, `upload-${id}.part`);
    await fs.writeFile(file, "");
    const u: Upload = { id, name: name.slice(0, 200) || "video", size, received: 0, file, touched: Date.now(), lock: Promise.resolve() };
    this.uploads.set(id, u);
    return { id, chunkSize: CHUNK_SIZE, received: 0 };
  }

  get(id: string) {
    const u = this.uploads.get(id);
    if (!u) throw new UploadError(404, "This upload has expired. Please choose the video again.");
    return u;
  }

  async writeChunk(id: string, offset: number, data: Buffer) {
    const u = this.get(id);
    const run = u.lock.then(async () => {
      if (offset !== u.received) throw new UploadError(409, "Out-of-order chunk", u.received);
      if (u.received + data.length > u.size) throw new UploadError(400, "More data than the declared file size.");
      await fs.appendFile(u.file, data);
      u.received += data.length;
      u.touched = Date.now();
    });
    u.lock = run.catch(() => {});
    await run;
    return { received: u.received };
  }

  /** Returns the completed file path and forgets the upload (caller owns the file). */
  finish(id: string) {
    const u = this.get(id);
    if (u.received !== u.size) throw new UploadError(409, `Upload incomplete (${u.received} of ${u.size} bytes).`, u.received);
    this.uploads.delete(id);
    return { file: u.file, name: u.name };
  }

  async cancel(id: string) {
    const u = this.uploads.get(id);
    if (!u) return;
    this.uploads.delete(id);
    await fs.rm(u.file, { force: true });
  }

  private async sweep(maxAgeMs: number) {
    const now = Date.now();
    for (const u of this.uploads.values()) if (now - u.touched > maxAgeMs) await this.cancel(u.id);
    if (!fssync.existsSync(this.dir)) return;
    for (const f of await fs.readdir(this.dir)) {
      if (!f.startsWith("upload-")) continue;
      const p = path.join(this.dir, f);
      const st = await fs.stat(p).catch(() => null);
      if (st && now - st.mtimeMs > maxAgeMs && ![...this.uploads.values()].some((u) => u.file === p)) await fs.rm(p, { force: true });
    }
  }
}
