import { useEffect, useState } from "react";
import { api, followJob } from "../lib/api";
import { formatBytes, formatTime, relativeDate } from "../lib/format";
import type { EditSettings, Job, Project } from "../lib/types";
import { Icon } from "./Icon";
import { toast } from "./Toast";

const DIMS = { "9:16": "1080 × 1920", "1:1": "1080 × 1080", "16:9": "1920 × 1080" };

export function ExportPanel({ project, edit, saving, onChanged }: { project: Project; edit: EditSettings; saving: boolean; onChanged: () => void }) {
  const active = project.exports.find((e) => e.status === "queued" || e.status === "rendering");
  const [job, setJob] = useState<Job | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!active) return setJob(null);
    return followJob(active.jobId, (j) => {
      setJob(j);
      if (j.status === "done") toast.success("Export complete. Your video is ready.");
      if (j.status === "failed") toast.error(`Export failed: ${j.error ?? "unknown error"}`);
      if (["done", "failed", "cancelled"].includes(j.status)) setTimeout(onChanged, 200);
    });
  }, [active?.jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setStarting(true);
    try {
      await api.startExport(project.id);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const len = ((edit.trimEnd ?? project.source.info.durationSec) - edit.trimStart) / edit.speed;

  return (
    <div className="panel">
      <h4 className="panel__title">Master export</h4>
      <dl className="specs">
        <div><dt>Resolution</dt><dd>{DIMS[edit.aspect]}</dd></div>
        <div><dt>Format</dt><dd>MP4 · H.264 · AAC</dd></div>
        <div><dt>Duration</dt><dd>{formatTime(len, true)}</dd></div>
        <div><dt>Quality</dt><dd>High (CRF 18)</dd></div>
      </dl>

      {active ? (
        <div className="render">
          <div className="render__row">
            <span>{job?.stage ?? "Queued"}</span>
            <span className="muted">{Math.round((job?.progress ?? 0) * 100)}%</span>
          </div>
          <div className="bar bar--gold"><div className="bar__fill" style={{ width: `${(job?.progress ?? 0) * 100}%` }} /></div>
          <button className="link" onClick={() => api.cancelJob(active.jobId).then(onChanged, (e) => toast.error(e.message))}>Cancel export</button>
        </div>
      ) : (
        <button className="btn btn--gold btn--block" disabled={starting || saving} onClick={start}>
          <Icon name="export" /> {saving ? "Saving changes…" : starting ? "Starting…" : "Export 1080p"}
        </button>
      )}
      {edit.smoothSlowMo && !active && <p className="fineprint">Smooth slow motion is on, so this render will take noticeably longer.</p>}

      {project.exports.length > 0 && <h4 className="panel__title">Exports</h4>}
      <ul className="exports">
        {project.exports.map((e) => (
          <li key={e.id} className={`export export--${e.status}`}>
            <div className="export__info">
              <span className="export__title">{e.aspect} · {e.width}×{e.height}</span>
              <span className="muted">
                {e.status === "done" && `${formatTime(e.durationSec, true)} · ${formatBytes(e.sizeBytes)} · ${relativeDate(e.finishedAt ?? e.createdAt)}`}
                {(e.status === "queued" || e.status === "rendering") && "Rendering…"}
                {e.status === "cancelled" && "Cancelled"}
                {e.status === "failed" && (e.error ?? "Failed")}
              </span>
            </div>
            <div className="export__actions">
              {e.downloadUrl && (
                <a className="icon-btn icon-btn--gold" href={e.downloadUrl} download aria-label="Download"><Icon name="download" /></a>
              )}
              {e.status !== "queued" && e.status !== "rendering" && (
                <button className="icon-btn" aria-label="Remove" onClick={() => api.deleteExport(project.id, e.id).then(onChanged, (err) => toast.error(err.message))}><Icon name="close" size={16} /></button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
