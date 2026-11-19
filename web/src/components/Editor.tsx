import { useCallback, useEffect, useRef, useState } from "react";
import { api, followJob } from "../lib/api";
import type { EditSettings, Health, Job, Project } from "../lib/types";
import { navigate } from "../App";
import { Icon } from "./Icon";
import { Preview } from "./Preview";
import { Timeline } from "./Timeline";
import { AiPanel, AudioPanel, FramePanel, LookPanel, MotionPanel } from "./Panels";
import { ExportPanel } from "./ExportPanel";
import { toast } from "./Toast";
import { formatTime } from "../lib/format";

const TABS = [
  { id: "frame", label: "Frame", icon: "frame" },
  { id: "look", label: "Look", icon: "palette" },
  { id: "motion", label: "Motion", icon: "speed" },
  { id: "audio", label: "Audio", icon: "wave" },
  { id: "ai", label: "AI", icon: "sparkle" },
  { id: "export", label: "Export", icon: "export" },
] as const;
type Tab = (typeof TABS)[number]["id"];

let healthCache: Promise<Health> | null = null;

export function Editor({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditSettings | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [tab, setTab] = useState<Tab>("frame");
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [ingest, setIngest] = useState<Job | null>(null);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [trueFrame, setTrueFrame] = useState<{ url: string | null; loading: boolean; error: string | null }>({ url: null, loading: false, error: null });
  const [trueFrameOn, setTrueFrameOn] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<Partial<EditSettings>>({});

  const load = useCallback(async () => {
    try {
      const p = await api.project(projectId);
      setProject(p);
      setEdit((e) => e ?? p.edit);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    healthCache ??= api.health();
    healthCache.then(setHealth, () => (healthCache = null));
  }, [load]);

  // Follow ingest (proxy creation) progress.
  useEffect(() => {
    if (project?.media.status !== "processing" || !project.media.jobId) return;
    return followJob(project.media.jobId, (j) => {
      setIngest(j);
      if (["done", "failed", "cancelled"].includes(j.status)) setTimeout(load, 200);
    });
  }, [project?.media.status, project?.media.jobId, load]);

  // ---- autosave (debounced, coalesced) ----
  const flush = useCallback(async () => {
    const patch = pending.current;
    pending.current = {};
    if (!Object.keys(patch).length) return;
    setSaveState("saving");
    try {
      const p = await api.updateProject(projectId, { edit: patch });
      setProject(p);
      setSaveState(Object.keys(pending.current).length ? "saving" : "saved");
    } catch (e) {
      setSaveState("error");
      toast.error(`Couldn't save: ${(e as Error).message}`);
    }
  }, [projectId]);

  const set = useCallback((patch: Partial<EditSettings>) => {
    setEdit((e) => (e ? { ...e, ...patch } : e));
    pending.current = { ...pending.current, ...patch };
    setSaveState("saving");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 450);
  }, [flush]);

  useEffect(() => () => { clearTimeout(saveTimer.current); void flush(); }, [flush]);

  // ---- playback within trim range ----
  const duration = project?.source.info.durationSec ?? 0;
  const tStart = edit?.trimStart ?? 0;
  const tEnd = edit?.trimEnd ?? duration;

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = edit?.speed ?? 1;
    v.muted = edit?.volume === 0;
    v.volume = Math.min(1, edit?.volume ?? 1);
  }, [edit?.speed, edit?.volume, project?.urls.proxy]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        if (!v.paused && v.currentTime >= tEnd - 0.02) v.currentTime = tStart;
        setCurrent(v.currentTime);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const v = videoRef.current;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v?.addEventListener("play", onPlay);
    v?.addEventListener("pause", onPause);
    return () => {
      cancelAnimationFrame(raf);
      v?.removeEventListener("play", onPlay);
      v?.removeEventListener("pause", onPause);
    };
  }, [tStart, tEnd, project?.urls.proxy]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    setTrueFrameOn(false);
    if (v.paused) {
      if (v.currentTime < tStart || v.currentTime >= tEnd - 0.05) v.currentTime = tStart;
      v.play().catch(() => toast.error("Playback was blocked by the browser. Tap play again."));
    } else v.pause();
  };

  const seek = (t: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = t;
    setCurrent(t);
  };

  // ---- exact rendered frame ----
  useEffect(() => {
    if (!trueFrameOn || !edit) {
      setTrueFrame((s) => {
        if (s.url) URL.revokeObjectURL(s.url);
        return { url: null, loading: false, error: null };
      });
      return;
    }
    videoRef.current?.pause();
    let cancelled = false;
    setTrueFrame((s) => ({ ...s, loading: true, error: null }));
    // wait for pending save so the server renders the current settings
    const t = setTimeout(async () => {
      await flush();
      try {
        const url = await api.frame(projectId, videoRef.current?.currentTime ?? tStart);
        if (cancelled) return URL.revokeObjectURL(url);
        setTrueFrame((s) => {
          if (s.url) URL.revokeObjectURL(s.url);
          return { url, loading: false, error: null };
        });
      } catch (e) {
        if (!cancelled) {
          setTrueFrame({ url: null, loading: false, error: (e as Error).message });
          toast.error((e as Error).message);
          setTrueFrameOn(false);
        }
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [trueFrameOn, edit, projectId, flush]); // eslint-disable-line react-hooks/exhaustive-deps

  // keyboard: space toggles play
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  if (error) {
    return (
      <div className="centered">
        <p className="notice notice--error">{error}</p>
        <button className="btn btn--ghost" onClick={() => navigate("/")}>Back to projects</button>
      </div>
    );
  }
  if (!project || !edit) return <div className="centered"><div className="spinner" /></div>;

  const rename = async () => {
    const name = prompt("Project name", project.name)?.trim();
    if (!name || name === project.name) return;
    try {
      setProject(await api.updateProject(project.id, { name }));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const ready = project.media.status === "ready";

  return (
    <div className="editor">
      <header className="topbar topbar--editor">
        <button className="icon-btn" onClick={() => navigate("/")} aria-label="Back"><Icon name="back" /></button>
        <button className="editor__name" onClick={rename} title="Rename">{project.name}</button>
        <span className={`save save--${saveState}`}>{saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Saved"}</span>
        <button className="btn btn--gold btn--sm" onClick={() => setTab("export")} disabled={!ready}>Export</button>
      </header>

      <main className="editor__body">
        <section className="editor__canvas">
          {ready ? (
            <>
              <Preview project={project} edit={edit} videoRef={videoRef} trueFrame={trueFrame} onTogglePlay={togglePlay} playing={playing} />
              <div className="transport">
                <button className="transport__play" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
                  <Icon name={playing ? "pause" : "play"} size={20} />
                </button>
                <Timeline duration={duration} start={tStart} end={tEnd} current={current} speed={edit.speed} filmstrip={project.urls.filmstrip}
                  onSeek={seek}
                  onTrim={(s, e) => {
                    set({ trimStart: Math.round(s * 100) / 100, trimEnd: e >= duration - 0.01 ? null : Math.round(e * 100) / 100 });
                    seek(s !== tStart ? s : Math.min(current, e));
                  }} />
              </div>
            </>
          ) : project.media.status === "processing" ? (
            <div className="processing">
              {project.urls.thumb && <img src={project.urls.thumb} alt="" />}
              <p className="eyebrow">Preparing your footage</p>
              <p className="processing__stage">{ingest?.stage ?? "Queued"}</p>
              <div className="bar bar--gold"><div className="bar__fill" style={{ width: `${(ingest?.progress ?? 0) * 100}%` }} /></div>
              <p className="muted">{formatTime(project.source.info.durationSec)} · {project.source.info.width}×{project.source.info.height}{project.source.info.isHdr ? " · HDR → SDR" : ""}</p>
            </div>
          ) : (
            <div className="processing">
              <p className="notice notice--error">{project.media.error ?? "Processing failed."}</p>
              <button className="btn btn--ghost" onClick={() => api.reprocess(project.id).then(load, (e) => toast.error(e.message))}>
                <Icon name="retry" /> Try again
              </button>
            </div>
          )}
        </section>

        <aside className="editor__side">
          <nav className="tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "is-active" : ""} onClick={() => setTab(t.id)}>
                <Icon name={t.icon} size={18} />
                <span>{t.label}</span>
              </button>
            ))}
          </nav>
          <div className="tabpanel" key={tab}>
            {tab === "frame" && <FramePanel edit={edit} set={set} project={project} />}
            {tab === "look" && <LookPanel edit={edit} set={set} health={health} trueFrameOn={trueFrameOn} onTrueFrame={() => setTrueFrameOn((x) => !x)} />}
            {tab === "motion" && <MotionPanel edit={edit} set={set} />}
            {tab === "audio" && <AudioPanel edit={edit} set={set} project={project} />}
            {tab === "ai" && <AiPanel health={health} />}
            {tab === "export" && (ready
              ? <ExportPanel project={project} edit={edit} saving={saveState === "saving"} onChanged={load} />
              : <div className="panel"><p className="notice">Export is available once the footage is prepared.</p></div>)}
          </div>
        </aside>
      </main>
    </div>
  );
}
