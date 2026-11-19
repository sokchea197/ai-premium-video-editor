import { useState } from "react";
import { api, type InstructionPlan } from "../lib/api";
import type { Project } from "../lib/types";
import { Icon } from "./Icon";
import { toast } from "./Toast";

const EXAMPLES = [
  "Vertical for Reels with a cinematic look and vignette",
  "Add bold captions with gold highlight",
  "Cut the first 2 seconds",
  "Slow motion and fade out at the end",
  "Black and white, elegant captions at the top",
  "Make it 30 seconds long and balance the audio",
];

interface Props {
  project: Project;
  beforeApply: () => Promise<void>;
  onApplied: (p: Project) => void;
  onExport: () => void;
}

/** Plain-English editing, interpreted locally on the server (free; no AI service). */
export function DirectPanel({ project, beforeApply, onApplied, onExport }: Props) {
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<{ plan: InstructionPlan; willTranscribe?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);

  const preview = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      setPlan(await api.instructions(project.id, text, false));
      setApplied(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    try {
      await beforeApply();
      const r = await api.instructions(project.id, text, true);
      if (r.project) onApplied(r.project);
      setApplied(true);
      toast.success(r.job ? "Edits applied. Transcribing captions now (free, on your computer)…" : "Edits applied. Press play to preview.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h4 className="panel__title">Describe your edit</h4>
      <textarea
        className="direct__input"
        rows={3}
        maxLength={2000}
        placeholder="e.g. Make it vertical for Reels, warm golden look, add elegant captions and fade out at the end"
        value={text}
        onChange={(e) => { setText(e.target.value); setPlan(null); setApplied(false); }}
      />
      <div className="chips">
        {EXAMPLES.map((ex) => (
          <button key={ex} className="chip" onClick={() => { setText((t) => (t.trim() ? `${t.trim().replace(/[.,]$/, "")}, ${ex.charAt(0).toLowerCase()}${ex.slice(1)}` : ex)); setPlan(null); setApplied(false); }}>
            {ex}
          </button>
        ))}
      </div>

      {!plan ? (
        <button className="btn btn--gold btn--block" disabled={busy || !text.trim()} onClick={preview}>
          <Icon name="sparkle" /> {busy ? "Reading…" : "Preview changes"}
        </button>
      ) : (
        <div className="plan">
          {plan.plan.changes.length ? (
            <>
              <p className="plan__head">I'll make these changes:</p>
              <ul className="plan__list">
                {plan.plan.changes.map((c) => <li key={c}>{c}</li>)}
                {plan.willTranscribe && <li>Transcribe speech for captions (free, runs on your computer)</li>}
              </ul>
            </>
          ) : (
            <p className="plan__head">I didn't find any edits I know how to make.</p>
          )}
          {plan.plan.notUnderstood.length > 0 && (
            <div className="plan__skip">
              <p>Not understood, so skipped:</p>
              <ul>{plan.plan.notUnderstood.map((c) => <li key={c}>“{c}”</li>)}</ul>
            </div>
          )}
          {applied ? (
            <div className="plan__actions">
              <span className="plan__done">✓ Applied</span>
              <button className="btn btn--gold btn--sm" onClick={onExport}>Go to export</button>
            </div>
          ) : (
            <div className="plan__actions">
              <button className="btn btn--ghost btn--sm" onClick={() => setPlan(null)}>Change text</button>
              <button className="btn btn--gold btn--sm" disabled={busy || !plan.plan.changes.length} onClick={apply}>{busy ? "Applying…" : "Apply"}</button>
            </div>
          )}
        </div>
      )}
      <p className="fineprint">Understands format, framing, colour looks, speed and slow motion, trimming and length, fades, sound and captions. It runs on your own computer, free. You can fine-tune everything in the other tabs.</p>
    </div>
  );
}
