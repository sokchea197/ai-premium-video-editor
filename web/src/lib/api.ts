import type { Health, Job, Project, EditSettings, ExportRecord } from "./types";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: string) {
    super(message);
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiError("Can't reach the server. Check your connection.", 0);
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.detail);
  return body as T;
}

export const api = {
  health: () => req<Health>("/api/health"),
  projects: () => req<Project[]>("/api/projects"),
  project: (id: string) => req<Project>(`/api/projects/${id}`),
  updateProject: (id: string, patch: { name?: string; edit?: Partial<EditSettings> }) =>
    req<Project>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteProject: (id: string) => req<void>(`/api/projects/${id}`, { method: "DELETE" }),
  reprocess: (id: string) => req<{ job: Job }>(`/api/projects/${id}/reprocess`, { method: "POST" }),
  startExport: (id: string) => req<{ job: Job; export: ExportRecord }>(`/api/projects/${id}/exports`, { method: "POST" }),
  deleteExport: (id: string, exportId: string) => req<void>(`/api/projects/${id}/exports/${exportId}`, { method: "DELETE" }),
  cancelJob: (jobId: string) => req<Job>(`/api/jobs/${jobId}/cancel`, { method: "POST" }),
  job: (jobId: string) => req<Job>(`/api/jobs/${jobId}`),

  async frame(id: string, t: number): Promise<string> {
    const res = await fetch(`/api/projects/${id}/frame?t=${t.toFixed(3)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(body.error ?? "Could not render frame", res.status, body.detail);
    }
    return URL.createObjectURL(await res.blob());
  },

  /** XHR upload so we can show real byte-level progress (fetch can't). */
  upload(file: File, onProgress: (fraction: number) => void): { promise: Promise<Project>; abort: () => void } {
    const xhr = new XMLHttpRequest();
    const promise = new Promise<Project>((resolve, reject) => {
      const form = new FormData();
      form.append("video", file, file.name);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        let body: any = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* non-JSON */
        }
        if (xhr.status === 201) resolve(body);
        else reject(new ApiError(body.error ?? `Upload failed (${xhr.status})`, xhr.status));
      };
      xhr.onerror = () => reject(new ApiError("Upload failed — the connection was interrupted.", 0));
      xhr.onabort = () => reject(new ApiError("Upload cancelled.", 0));
      xhr.open("POST", "/api/projects");
      xhr.send(form);
    });
    return { promise, abort: () => xhr.abort() };
  },
};

/**
 * Follows a job live over SSE, falling back to polling if the stream drops
 * (e.g. mobile Safari backgrounding). Returns an unsubscribe function.
 */
export function followJob(jobId: string, onUpdate: (job: Job) => void): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const terminal = (j: Job) => j.status === "done" || j.status === "failed" || j.status === "cancelled";

  const poll = async () => {
    if (closed) return;
    try {
      const j = await api.job(jobId);
      onUpdate(j);
      if (terminal(j)) return;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        onUpdate({ id: jobId, kind: "export", status: "failed", progress: 0, stage: "Failed", error: "This job is no longer known to the server." });
        return;
      }
    }
    timer = setTimeout(poll, 1500);
  };

  if (typeof EventSource !== "undefined") {
    es = new EventSource(`/api/jobs/${jobId}/events`);
    es.onmessage = (ev) => {
      const j = JSON.parse(ev.data) as Job;
      onUpdate(j);
      if (terminal(j)) es?.close();
    };
    es.onerror = () => {
      es?.close();
      es = null;
      if (!closed) timer = setTimeout(poll, 500);
    };
  } else {
    void poll();
  }
  return () => {
    closed = true;
    es?.close();
    clearTimeout(timer);
  };
}
