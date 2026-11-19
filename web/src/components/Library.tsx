import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { formatTime, relativeDate } from "../lib/format";
import type { Project } from "../lib/types";
import { navigate } from "../App";
import { Icon } from "./Icon";
import { toast } from "./Toast";

const ACCEPT = "video/mp4,video/quicktime,.mp4,.mov,.m4v";
const OK_EXT = /\.(mp4|mov|m4v)$/i;

export function Library() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ name: string; progress: number; abort: () => void } | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    api.projects().then(setProjects, (e) => setLoadError(e.message));
  }, []);
  useEffect(refresh, [refresh]);

  // Keep processing projects fresh.
  useEffect(() => {
    if (!projects?.some((p) => p.media.status === "processing")) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [projects, refresh]);

  const startUpload = (file: File) => {
    if (!OK_EXT.test(file.name)) {
      toast.error("Please choose an MP4 or MOV video.");
      return;
    }
    const { promise, abort } = api.upload(file, (progress) => setUpload((u) => (u ? { ...u, progress } : u)));
    setUpload({ name: file.name, progress: 0, abort });
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

      <section
        className={`dropzone ${dragging ? "is-dragging" : ""} ${upload ? "is-busy" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !upload && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !upload && inputRef.current?.click()}
      >
        <input ref={inputRef} type="file" accept={ACCEPT} hidden onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) startUpload(f);
        }} />
        {upload ? (
          <div className="dropzone__progress" onClick={(e) => e.stopPropagation()}>
            <p className="dropzone__file">{upload.name}</p>
            <div className="bar"><div className="bar__fill" style={{ width: `${upload.progress * 100}%` }} /></div>
            <div className="dropzone__row">
              <span>{upload.progress < 1 ? `Uploading · ${Math.round(upload.progress * 100)}%` : "Analysing video…"}</span>
              {upload.progress < 1 && <button className="link" onClick={upload.abort}>Cancel</button>}
            </div>
          </div>
        ) : (
          <>
            <div className="dropzone__icon"><Icon name="upload" size={26} /></div>
            <p className="dropzone__title">Upload footage</p>
            <p className="dropzone__hint">Tap to choose, or drop an MP4 / MOV here</p>
          </>
        )}
      </section>

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
