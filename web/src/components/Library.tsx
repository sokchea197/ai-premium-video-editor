import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type UploadProgress } from "../lib/api";
import { formatBytes, formatTime, relativeDate } from "../lib/format";
import type { Project } from "../lib/types";
import { navigate } from "../App";
import { Icon } from "./Icon";
import { toast } from "./Toast";

// "video/*" makes iOS offer Photo Library, Take Video and Files. The server checks the
// actual content with ffprobe, so files with odd names or no extension still work.
const ACCEPT = "video/*,.mp4,.mov,.m4v";
// Only reject the obviously wrong here; generic types like application/octet-stream
// (common from Files/Drive) go to the server, which checks the real content.
const looksLikeVideo = (f: File) => !/^(image|audio|text)\//.test(f.type) && f.type !== "application/pdf";

function uploadLabel(u: { size: number; progress: UploadProgress | null; finishing: boolean }) {
  if (u.finishing) return "Checking video…";
  const p = u.progress;
  if (!p) return "Starting upload…";
  const pct = Math.floor((p.sent / Math.max(1, p.total)) * 100);
  if (p.retrying) return `Connection lost, retrying · ${pct}%`;
  const eta = p.rate > 0 ? Math.ceil((p.total - p.sent) / p.rate) : 0;
  return `${pct}% · ${formatBytes(p.sent)} of ${formatBytes(p.total)}${eta ? ` · ${eta > 90 ? `${Math.ceil(eta / 60)} min` : `${eta} s`} left` : ""}`;
}

export function Library() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ name: string; size: number; progress: UploadProgress | null; abort: () => void; finishing: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [serverDown, setServerDown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.health().then(() => setServerDown(false), () => setServerDown(true));
  }, []);

  const refresh = useCallback(() => {
    api.projects().then((p) => { setProjects(p); setLoadError(null); }, (e) => setLoadError(e.message));
  }, []);
  useEffect(refresh, [refresh]);

  // Keep processing projects fresh.
  useEffect(() => {
    if (!projects?.some((p) => p.media.status === "processing")) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [projects, refresh]);

  const startUpload = (file: File) => {
    if (!looksLikeVideo(file)) {
      toast.error(`“${file.name}” doesn't look like a video. Please choose an MP4 or MOV.`);
      return;
    }
    const { promise, abort } = api.upload(file, (progress) =>
      setUpload((u) => (u ? { ...u, progress, finishing: progress.sent >= progress.total } : u)),
    );
    setUpload({ name: file.name || "Video", size: file.size, progress: null, abort, finishing: false });
    promise
      .then((p) => {
        toast.success("Uploaded. Preparing your preview…");
        navigate(`/p/${p.id}`);
      })
      .catch((e: ApiError) => {
        if (e.message !== "Upload cancelled.") toast.error(e.message);
      })
      .finally(() => setUpload(null));
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) startUpload(f);
  };

  const remove = async (p: Project) => {
    if (!confirm(`Delete “${p.name}” and all its exports?`)) return;
    try {
      await api.deleteProject(p.id);
      setProjects((xs) => xs?.filter((x) => x.id !== p.id) ?? null);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="library">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" />
          <span className="brand__name">Premium Studio</span>
        </div>
        <span className="topbar__meta">AI Video Editor</span>
      </header>

      <section className="hero">
        <p className="eyebrow">Personal branding · Reels · TikTok</p>
        <h1 className="hero__title">
          Turn raw footage into <em>cinematic</em> stories.
        </h1>
        <p className="hero__sub">Upload a clip, shape the frame and grade, and export a polished 1080p master for every platform.</p>
      </section>

      {serverDown && (
        <div className="notice notice--error server-down">
          <strong>Can't reach the editor server.</strong> If you use GitHub Codespaces, reopen your codespace (it pauses after 30 minutes idle). On a computer, run <code>npm start</code> and open the address it prints.
          <button className="link" onClick={() => api.health().then(() => { setServerDown(false); refresh(); }, () => toast.error("Still can't reach the server."))}>Retry</button>
        </div>
      )}

      {upload ? (
        <section className="dropzone is-busy">
          <div className="dropzone__progress">
            <p className="dropzone__file">{upload.name}</p>
            <div className="bar bar--gold"><div className="bar__fill" style={{ width: `${((upload.progress?.sent ?? 0) / Math.max(1, upload.size)) * 100}%` }} /></div>
            <div className="dropzone__row">
              <span>{uploadLabel(upload)}</span>
              {!upload.finishing && <button className="link" onClick={upload.abort}>Cancel</button>}
            </div>
            <p className="fineprint">Keep this page open until the upload finishes. If the connection drops, it resumes automatically.</p>
          </div>
        </section>
      ) : (
        <label
          className={`dropzone ${dragging ? "is-dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          {/* A real (visually hidden) input inside a <label>: the most reliable file picker on iOS Safari. */}
          <input ref={inputRef} className="visually-hidden" type="file" accept={ACCEPT} onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) startUpload(f);
          }} />
          <div className="dropzone__icon"><Icon name="upload" size={26} /></div>
          <p className="dropzone__title">Upload footage</p>
          <p className="dropzone__hint">Tap to choose from Photos or Files, or drop a video here</p>
          <p className="dropzone__formats">MP4 · MOV · iPhone HEVC &amp; HDR · up to 20 GB</p>
        </label>
      )}

      <section className="projects">
        <div className="section-head">
          <h2>Projects</h2>
          {projects && <span className="muted">{projects.length}</span>}
        </div>
        {loadError && <div className="notice notice--error">{loadError} <button className="link" onClick={refresh}>Retry</button></div>}
        {!projects && !loadError && <div className="grid">{[0, 1, 2].map((i) => <div key={i} className="card card--skeleton" />)}</div>}
        {projects?.length === 0 && <p className="empty">Your projects will appear here.</p>}
        <div className="grid">
          {projects?.map((p) => (
            <article key={p.id} className="card" onClick={() => navigate(`/p/${p.id}`)}>
              <div className="card__media" style={{ aspectRatio: p.source.info.width / p.source.info.height > 1 ? "16/10" : "4/5" }}>
                {p.urls.thumb ? <img src={p.urls.thumb} alt="" loading="lazy" /> : <div className="card__placeholder" />}
                <span className="pill pill--dark">{formatTime(p.source.info.durationSec)}</span>
                {p.media.status === "processing" && <span className="pill pill--gold">Preparing…</span>}
                {p.media.status === "failed" && <span className="pill pill--error">Needs attention</span>}
              </div>
              <div className="card__body">
                <div>
                  <h3>{p.name}</h3>
                  <p className="muted">{relativeDate(p.updatedAt)} · {p.exports.filter((e) => e.status === "done").length} exports</p>
                </div>
                <button className="icon-btn" aria-label="Delete project" onClick={(e) => { e.stopPropagation(); void remove(p); }}>
                  <Icon name="trash" size={16} />
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
