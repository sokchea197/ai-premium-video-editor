import type { Health, Job, Project, EditSettings, ExportRecord, CaptionStyle, CaptionSegment, Chunking } from "./types";

export interface ProjectPatch {
  name?: string;
  edit?: Partial<EditSettings>;
  captions?: { style?: Partial<CaptionStyle>; segments?: CaptionSegment[] };
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: string) {
    super(message);
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw new ApiError("Upload cancelled.", 0);
    throw new ApiError("Can't reach the editor server. Make sure it's running on your computer and that this device is on the same Wi-Fi.", 0);
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A dev proxy answers 500/502/504 with no JSON when the API server is down.
    if (!body.error && res.status >= 500) throw new ApiError("The editor server isn't responding. Make sure it's running (npm start).", res.status);
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.detail);
  }
  return body as T;
}

export const api = {
  health: () => req<Health>("/api/health"),
  projects: () => req<Project[]>("/api/projects"),
  project: (id: string) => req<Project>(`/api/projects/${id}`),
  updateProject: (id: string, patch: ProjectPatch) =>
    req<Project>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteProject: (id: string) => req<void>(`/api/projects/${id}`, { method: "DELETE" }),
  transcribe: (id: string, opts: { language: string; keyterms: string[] }) =>
    req<{ job: Job }>(`/api/projects/${id}/transcribe`, { method: "POST", body: JSON.stringify(opts) }),
  regroupCaptions: (id: string, chunking: Chunking) =>
    req<Project>(`/api/projects/${id}/captions/regroup`, { method: "POST", body: JSON.stringify({ chunking }) }),
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

  upload: uploadVideo,
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


export interface UploadProgress {
  sent: number;
  total: number;
  /** bytes per second (smoothed) */
  rate: number;
  retrying: boolean;
}

/**
 * Resumable chunked upload. Each 8 MB chunk is retried on its own, and after a
 * dropped connection (screen lock, app switch, Wi-Fi blip) the upload resumes
 * from the last byte the server confirmed instead of starting over.
 */
export function uploadVideo(file: File, onProgress: (p: UploadProgress) => void): { promise: Promise<Project>; abort: () => void } {
  const ac = new AbortController();
  let uploadId: string | null = null;
  let wakeLock: { release(): Promise<void> } | null = null;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const checkAbort = () => {
    if (ac.signal.aborted) throw new ApiError("Upload cancelled.", 0);
  };

  const promise = (async () => {
    // Keep the iPhone screen awake while uploading (iOS 16.4+); harmless if unsupported.
    try {
      wakeLock = await (navigator as any).wakeLock?.request("screen");
    } catch {
      /* not supported / not allowed */
    }
    const created = await req<{ id: string; chunkSize: number }>("/api/uploads", {
      method: "POST",
      body: JSON.stringify({ name: file.name || "video", size: file.size }),
      signal: ac.signal,
    });
    uploadId = created.id;
    let offset = 0;
    let rate = 0;
    let failures = 0;
    while (offset < file.size) {
      checkAbort();
      const end = Math.min(file.size, offset + created.chunkSize);
      const t0 = performance.now();
      try {
        const res = await fetch(`/api/uploads/${uploadId}?offset=${offset}`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: file.slice(offset, end),
          signal: ac.signal,
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 409 && typeof body.received === "number") {
          offset = body.received; // server is ahead/behind: resync
          continue;
        }
        if (!res.ok) {
          if (res.status >= 400 && res.status < 500) throw new ApiError(body.error ?? `Upload failed (${res.status})`, res.status);
          throw new Error(`HTTP ${res.status}`);
        }
        const dt = (performance.now() - t0) / 1000;
        const inst = (end - offset) / Math.max(dt, 0.001);
        rate = rate ? rate * 0.7 + inst * 0.3 : inst;
        offset = body.received;
        failures = 0;
        onProgress({ sent: offset, total: file.size, rate, retrying: false });
      } catch (e) {
        checkAbort();
        if (e instanceof ApiError) throw e;
        if (++failures > 8) throw new ApiError("Upload failed: the connection to the editor kept dropping. Check the Wi-Fi and try again.", 0);
        onProgress({ sent: offset, total: file.size, rate, retrying: true });
        await sleep(Math.min(15000, 800 * 2 ** (failures - 1)));
        // Ask the server what it actually has, then continue from there.
        try {
          const st = await req<{ received: number }>(`/api/uploads/${uploadId}`, { signal: ac.signal });
          offset = st.received;
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) throw err;
        }
      }
    }
    onProgress({ sent: file.size, total: file.size, rate, retrying: false });
    return req<Project>(`/api/uploads/${uploadId}/complete`, { method: "POST", body: "{}", signal: ac.signal });
  })().finally(() => {
    void wakeLock?.release().catch(() => {});
  });

  return {
    promise,
    abort: () => {
      ac.abort();
      if (uploadId) void fetch(`/api/uploads/${uploadId}`, { method: "DELETE" }).catch(() => {});
    },
  };
}
