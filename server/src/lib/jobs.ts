import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  kind: "ingest" | "export";
  projectId: string;
  status: JobStatus;
  /** 0..1 */
  progress: number;
  stage: string;
  error?: string;
  /** Technical detail (ffmpeg stderr tail) for debugging; shown collapsed in UI. */
  detail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobContext {
  signal: AbortSignal;
  progress(fraction: number, stage?: string): void;
}

type Runner = (ctx: JobContext) => Promise<void>;

/** In-process FIFO job queue with bounded concurrency and live events. */
export class JobManager extends EventEmitter {
  private jobs = new Map<string, Job>();
  private queue: { job: Job; run: Runner }[] = [];
  private controllers = new Map<string, AbortController>();
  private running = 0;

  constructor(private concurrency: number) {
    super();
    this.setMaxListeners(0);
  }

  get(id: string) {
    return this.jobs.get(id);
  }

  enqueue(kind: Job["kind"], projectId: string, run: Runner): Job {
    const now = new Date().toISOString();
    const job: Job = { id: randomUUID(), kind, projectId, status: "queued", progress: 0, stage: "Waiting in queue", createdAt: now, updatedAt: now };
    this.jobs.set(job.id, job);
    this.queue.push({ job, run });
    this.emitUpdate(job);
    queueMicrotask(() => this.pump());
    return job;
  }

  cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job || job.status === "done" || job.status === "failed" || job.status === "cancelled") return false;
    const idx = this.queue.findIndex((q) => q.job.id === id);
    if (idx >= 0) this.queue.splice(idx, 1);
    this.controllers.get(id)?.abort();
    this.patch(job, { status: "cancelled", stage: "Cancelled" });
    return true;
  }

  /** Resolves when the job reaches a terminal state. */
  wait(id: string): Promise<Job> {
    return new Promise((resolve) => {
      const check = () => {
        const j = this.jobs.get(id);
        if (j && ["done", "failed", "cancelled"].includes(j.status)) {
          this.off("update", check);
          resolve(j);
        }
      };
      this.on("update", check);
      check();
    });
  }

  private patch(job: Job, p: Partial<Job>) {
    Object.assign(job, p, { updatedAt: new Date().toISOString() });
    this.emitUpdate(job);
  }

  private emitUpdate(job: Job) {
    this.emit("update", job);
    this.emit(`job:${job.id}`, job);
  }

  private pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const { job, run } = this.queue.shift()!;
      const ac = new AbortController();
      this.controllers.set(job.id, ac);
      this.running++;
      this.patch(job, { status: "running", stage: "Starting" });
      let lastEmit = 0;
      const ctx: JobContext = {
        signal: ac.signal,
        progress: (fraction, stage) => {
          if (job.status !== "running") return;
          const now = Date.now();
          job.progress = Math.max(0, Math.min(1, fraction));
          if (stage) job.stage = stage;
          if (stage || now - lastEmit > 250) {
            lastEmit = now;
            this.patch(job, {});
          }
        },
      };
      run(ctx)
        .then(() => {
          if (job.status === "running") this.patch(job, { status: "done", progress: 1, stage: "Complete" });
        })
        .catch((err: any) => {
          if (job.status !== "running") return; // already cancelled
          this.patch(job, { status: "failed", stage: "Failed", error: err?.message ?? String(err), detail: err?.stderrTail || undefined });
        })
        .finally(() => {
          this.running--;
          this.controllers.delete(job.id);
          this.pump();
        });
    }
  }
}
