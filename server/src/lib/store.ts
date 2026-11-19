import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { defaultEdit, editSchema, type EditSettings } from "./edit.js";
import type { MediaInfo } from "./ffmpeg.js";

export type MediaStatus = "processing" | "ready" | "failed";
export type ExportStatus = "queued" | "rendering" | "done" | "failed" | "cancelled";

export interface ExportRecord {
  id: string;
  jobId: string;
  status: ExportStatus;
  aspect: EditSettings["aspect"];
  width: number;
  height: number;
  durationSec: number;
  createdAt: string;
  finishedAt?: string;
  fileName?: string;
  sizeBytes?: number;
  error?: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  source: { fileName: string; originalName: string; info: MediaInfo };
  media: { status: MediaStatus; jobId?: string; error?: string; hasProxy: boolean; hasThumb: boolean; hasFilmstrip: boolean };
  edit: EditSettings;
  exports: ExportRecord[];
}

/**
 * File-backed project store: one directory per project with project.json and
 * its media. Writes are atomic (write + rename) and serialised per project.
 */
export class ProjectStore {
  private cache = new Map<string, Project>();
  private writeChains = new Map<string, Promise<void>>();

  constructor(readonly root: string) {
    fssync.mkdirSync(path.join(root, "projects"), { recursive: true });
    fssync.mkdirSync(path.join(root, "tmp"), { recursive: true });
  }

  get tmpDir() {
    return path.join(this.root, "tmp");
  }
  dir(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid project id");
    return path.join(this.root, "projects", id);
  }
  file(id: string, name: string) {
    return path.join(this.dir(id), path.basename(name));
  }

  async load() {
    const ids = await fs.readdir(path.join(this.root, "projects"));
    for (const id of ids) {
      try {
        const p = JSON.parse(await fs.readFile(path.join(this.root, "projects", id, "project.json"), "utf8")) as Project;
        p.edit = editSchema.parse(p.edit ?? {});
        this.cache.set(p.id, p);
      } catch {
        // skip unreadable/incomplete project directories
      }
    }
    // Any work in flight when the server stopped is gone: say so honestly.
    for (const p of this.cache.values()) {
      let changed = false;
      if (p.media.status === "processing") {
        p.media = { ...p.media, status: "failed", error: "Processing was interrupted by a server restart. Retry to continue." };
        changed = true;
      }
      for (const e of p.exports) {
        if (e.status === "queued" || e.status === "rendering") {
          e.status = "failed";
          e.error = "Export was interrupted by a server restart.";
          changed = true;
        }
      }
      if (changed) await this.save(p);
    }
  }

  list() {
    return [...this.cache.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  get(id: string) {
    return this.cache.get(id);
  }

  async create(input: { name: string; originalName: string; tmpFile: string; ext: string; info: MediaInfo }) {
    const id = randomUUID();
    const dir = this.dir(id);
    await fs.mkdir(dir, { recursive: true });
    const fileName = `source${input.ext}`;
    await fs.rename(input.tmpFile, path.join(dir, fileName));
    const now = new Date().toISOString();
    // Reels/TikTok first: every project starts vertical. Landscape sources default
    // to the blurred-backdrop framing so nothing important is cropped away.
    const edit = defaultEdit();
    if (input.info.width > input.info.height) edit.fit = "blur";
    const p: Project = {
      id,
      name: input.name,
      createdAt: now,
      updatedAt: now,
      source: { fileName, originalName: input.originalName, info: input.info },
      media: { status: "processing", hasProxy: false, hasThumb: false, hasFilmstrip: false },
      edit,
      exports: [],
    };
    this.cache.set(id, p);
    await this.save(p);
    return p;
  }

  async update(id: string, fn: (p: Project) => void) {
    const p = this.cache.get(id);
    if (!p) return undefined;
    fn(p);
    p.updatedAt = new Date().toISOString();
    await this.save(p);
    return p;
  }

  private save(p: Project) {
    const prev = this.writeChains.get(p.id) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (!this.cache.has(p.id)) return;
      const target = path.join(this.dir(p.id), "project.json");
      const tmp = `${target}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(p, null, 2));
      await fs.rename(tmp, target);
    });
    this.writeChains.set(p.id, next.catch(() => {}));
    return next;
  }

  async delete(id: string) {
    this.cache.delete(id);
    await this.writeChains.get(id);
    await fs.rm(this.dir(id), { recursive: true, force: true });
  }
}
