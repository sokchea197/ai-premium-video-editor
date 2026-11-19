import { useEffect, useMemo, useRef, useState } from "react";
import { HIGHLIGHTS, LANGUAGES, rescale, retimeText, round, segmentText } from "../lib/captions";
import { formatTime } from "../lib/format";
import type { CaptionSegment, CaptionStyle, Captions, Chunking, Health, Job, Project } from "../lib/types";
import { Icon } from "./Icon";

interface Props {
  project: Project;
  captions: Captions | null;
  health: Health | null;
  job: Job | null;
  time: number;
  onTranscribe: (language: string, keyterms: string[]) => void;
  onCancel: () => void;
  onStyle: (patch: Partial<CaptionStyle>) => void;
  onSegments: (segments: CaptionSegment[]) => void;
  onRegroup: (chunking: Chunking) => void;
  onSeek: (t: number) => void;
}

export function CaptionsPanel(props: Props) {
  const { project, captions, health, job } = props;
  const t = health?.ai.transcription;
  const running = project.transcription.status === "running";

  if (!project.source.info.hasAudio) {
    return <div className="panel"><div className="notice">This clip has no audio, so there is nothing to transcribe.</div></div>;
  }
  if (running) {
    return (
      <div className="panel">
        <h4 className="panel__title">Subtitles</h4>
        <div className="render">
          <div className="render__row"><span>{job?.stage ?? "Starting"}</span><span className="muted">{Math.round((job?.progress ?? 0) * 100)}%</span></div>
          <div className="bar bar--gold"><div className="bar__fill" style={{ width: `${(job?.progress ?? 0) * 100}%` }} /></div>
          <button className="link" onClick={props.onCancel}>Cancel</button>
        </div>
        <p className="fineprint">Your audio is sent securely from the server to Deepgram. Your API key never leaves the server.</p>
      </div>
    );
  }
  if (!captions) {
    return (
      <div className="panel">
        <h4 className="panel__title">Subtitles</h4>
        {project.transcription.status === "failed" && <div className="notice notice--error">{project.transcription.error}</div>}
        {t?.available ? <GenerateForm {...props} /> : (
          <div className="notice">
            <p><strong>Automatic subtitles aren't set up yet.</strong></p>
            <p className="muted" style={{ marginTop: 6 }}>Add a Deepgram API key to the server as <code>DEEPGRAM_API_KEY</code> (in <code>.env</code>), then restart it. The key stays on the server and is never sent to your browser.</p>
          </div>
        )}
      </div>
    );
  }
  return <CaptionEditor {...props} captions={captions} />;
}

function GenerateForm({ project, health, onTranscribe, captions }: Props) {
  const [language, setLanguage] = useState(project.transcription.language ?? "auto");
  const [terms, setTerms] = useState("");
  const keyterms = terms.split(",").map((s) => s.trim()).filter(Boolean);
  const price = health?.ai.transcription.pricePerMinuteUsd;
  const minutes = project.source.info.durationSec / 60;
  const rate = price ? (language === "multi" ? price.multilingual : price.standard) + (keyterms.length ? price.keytermAddOn : 0) : 0;
  const cost = minutes * rate;

  return (
    <>
      <p className="muted">Transcribe the speech in this clip and turn it into synchronised, editable captions.</p>
      <label className="field">
        <span>Spoken language</span>
        <select value={language} onChange={(e) => setLanguage(e.target.value)}>
          {LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Names &amp; brand terms <small className="muted">(optional, comma-separated)</small></span>
        <input type="text" placeholder="e.g. Sokchea, Premium Studio" value={terms} onChange={(e) => setTerms(e.target.value)} />
      </label>
      <div className="estimate">
        <span>Estimated Deepgram cost</span>
        <strong>{cost < 0.01 ? "< $0.01" : `≈ $${cost.toFixed(2)}`}</strong>
        <small className="muted">{minutes.toFixed(1)} min of audio × ${rate.toFixed(4)}/min{keyterms.length ? " (includes key terms add-on)" : ""}. Billed by Deepgram to your account.</small>
      </div>
      <button className="btn btn--gold btn--block" onClick={() => {
        if (captions?.edited && !confirm("Re-transcribing replaces your edited captions. Continue?")) return;
        onTranscribe(language, keyterms);
      }}>
        <Icon name="sparkle" /> Generate subtitles
      </button>
    </>
  );
}

function CaptionEditor({ project, captions, health, time, onStyle, onSegments, onRegroup, onSeek, ...rest }: Props & { captions: Captions }) {
  const s = captions.style;
  const presets = health?.captionPresets ?? [];
  const [showRedo, setShowRedo] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const activeId = useMemo(() => captions.segments.find((x) => time >= x.start && time < x.end)?.id, [captions.segments, time]);
  const listRef = useRef<HTMLDivElement>(null);

  const update = (id: string, fn: (seg: CaptionSegment) => CaptionSegment | null) => {
    const next: CaptionSegment[] = [];
    for (const seg of captions.segments) {
      if (seg.id !== id) next.push(seg);
      else {
        const r = fn(seg);
        if (r) next.push(r);
      }
    }
    onSegments(next.sort((a, b) => a.start - b.start));
  };

  const merge = (i: number) => {
    const a = captions.segments[i], b = captions.segments[i + 1];
    if (!b) return;
    const segs = [...captions.segments];
    segs.splice(i, 2, { ...a, end: b.end, words: [...a.words, ...b.words].slice(0, 40) });
    onSegments(segs);
  };

  const addAtPlayhead = () => {
    const start = round(time);
    const next = captions.segments.find((x) => x.start > start);
    const end = round(Math.min(start + 1.5, next ? next.start : project.source.info.durationSec));
    if (end - start < 0.2) return;
    const seg: CaptionSegment = { id: crypto.randomUUID(), start, end, words: [{ text: "New", start, end: round(start + (end - start) / 2) }, { text: "caption", start: round(start + (end - start) / 2), end }] };
    onSegments([...captions.segments, seg].sort((a, b) => a.start - b.start));
    setOpenId(seg.id);
  };

  const nudge = (seg: CaptionSegment, which: "start" | "end", delta: number) => {
    const dur = project.source.info.durationSec;
    let { start, end } = seg;
    if (which === "start") start = Math.max(0, Math.min(end - 0.2, start + delta));
    else end = Math.min(dur, Math.max(start + 0.2, end + delta));
    update(seg.id, (x) => rescale(x, start, end));
  };

  useEffect(() => {
    if (!activeId || openId) return;
    // Scroll only the panel (scrollIntoView would also scroll the editor layout).
    const el = listRef.current?.querySelector<HTMLElement>(`[data-id="${activeId}"]`);
    const scroller = el?.closest<HTMLElement>(".tabpanel");
    if (!el || !scroller) return;
    const e = el.getBoundingClientRect(), c = scroller.getBoundingClientRect();
    if (e.top < c.top + 8 || e.bottom > c.bottom - 8) scroller.scrollBy({ top: e.top - c.top - c.height / 3, behavior: "smooth" });
  }, [activeId, openId]);

  return (
    <div className="panel">
      <div className="panel__row">
        <h4 className="panel__title">Subtitles</h4>
        <label className="toggle toggle--inline">
          <span className="toggle__label">{s.enabled ? "On" : "Off"}</span>
          <input type="checkbox" checked={s.enabled} onChange={(e) => onStyle({ enabled: e.target.checked })} />
          <span className="toggle__switch" aria-hidden />
        </label>
      </div>

      <div className="presets">
        {presets.map((p) => (
          <button key={p.id} className={`preset ${s.preset === p.id ? "is-active" : ""}`} onClick={() => onStyle({ preset: p.id })}>
            <span className="preset__sample" style={{ fontFamily: `"${p.cssFamily}"`, fontWeight: p.cssWeight, textTransform: p.uppercase ? "uppercase" : "none" }}>
              Be <span style={{ color: s.highlight, fontStyle: p.activeItalic ? "italic" : undefined }}>bold</span>
            </span>
            <span className="preset__name">{p.name}</span>
          </button>
        ))}
      </div>

      <div className="segmented segmented--compact" role="radiogroup" aria-label="Position">
        {(["upper", "middle", "lower"] as const).map((pos) => (
          <button key={pos} className={s.position === pos ? "is-active" : ""} onClick={() => onStyle({ position: pos })}>
            {pos === "upper" ? "Top" : pos === "middle" ? "Centre" : "Bottom"}
          </button>
        ))}
      </div>

      <label className="slider">
        <span className="slider__head"><span>Size</span><span className="muted">{Math.round(s.size * 100)}%</span></span>
        <input type="range" min={0.6} max={1.6} step={0.05} value={s.size} onChange={(e) => onStyle({ size: Number(e.target.value) })}
          style={{ "--fill": `${((s.size - 0.6) / 1) * 100}%` } as React.CSSProperties} />
      </label>

      <div className="swatches" role="radiogroup" aria-label="Highlight colour">
        <span className="swatches__label">Highlight</span>
        {HIGHLIGHTS.map((c) => (
          <button key={c} aria-label={c} className={`swatch ${s.highlight.toUpperCase() === c ? "is-active" : ""}`} style={{ background: c }} onClick={() => onStyle({ highlight: c })} />
        ))}
      </div>

      <label className="toggle">
        <span><span className="toggle__label">Word-by-word highlight</span><small className="muted">Follows the speaker's timing</small></span>
        <input type="checkbox" checked={s.animate} onChange={(e) => onStyle({ animate: e.target.checked })} />
        <span className="toggle__switch" aria-hidden />
      </label>

      <div>
        <p className="field-label">Caption length</p>
        <div className="segmented segmented--compact">
          {([["punchy", "Punchy"], ["balanced", "Balanced"], ["lines", "Full lines"]] as const).map(([v, l]) => (
            <button key={v} className={s.chunking === v ? "is-active" : ""} onClick={() => {
              if (v === s.chunking) return;
              if (captions.edited && !confirm("Changing caption length rebuilds captions from the transcript and discards your text edits. Continue?")) return;
              onRegroup(v);
            }}>{l}</button>
          ))}
        </div>
      </div>

      <div className="panel__row">
        <h4 className="panel__title">Edit captions <span className="muted">· {captions.segments.length}</span></h4>
        <button className="link" onClick={addAtPlayhead}>+ Add at playhead</button>
      </div>
      {captions.segments.length === 0 && <div className="notice">No speech was detected in this clip. You can add captions manually.</div>}
      <div className="cues" ref={listRef}>
        {captions.segments.map((seg, i) => (
          <div key={seg.id} data-id={seg.id} className={`cue ${seg.id === activeId ? "is-active" : ""} ${openId === seg.id ? "is-open" : ""}`}>
            <button className="cue__time" onClick={() => { onSeek(Math.min(seg.start + 0.15, (seg.start + seg.end) / 2)); setOpenId(openId === seg.id ? null : seg.id); }}>
              {formatTime(seg.start, true)}
            </button>
            <CueText seg={seg} onCommit={(text) => update(seg.id, (x) => {
              const words = retimeText(x, text);
              return words ? { ...x, words } : x;
            })} />
            {openId === seg.id && (
              <div className="cue__tools">
                <div className="stepper"><span>Start</span>
                  <button onClick={() => nudge(seg, "start", -0.1)} aria-label="Start earlier">−</button>
                  <output>{formatTime(seg.start, true)}</output>
                  <button onClick={() => nudge(seg, "start", 0.1)} aria-label="Start later">+</button>
                </div>
                <div className="stepper"><span>End</span>
                  <button onClick={() => nudge(seg, "end", -0.1)} aria-label="End earlier">−</button>
                  <output>{formatTime(seg.end, true)}</output>
                  <button onClick={() => nudge(seg, "end", 0.1)} aria-label="End later">+</button>
                </div>
                <div className="cue__actions">
                  {i < captions.segments.length - 1 && <button className="chip" onClick={() => merge(i)}>Merge with next</button>}
                  <button className="chip chip--danger" onClick={() => update(seg.id, () => null)}>Delete</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <button className="link" onClick={() => setShowRedo((x) => !x)}>{showRedo ? "Hide" : "Re-transcribe this clip…"}</button>
      {showRedo && <GenerateForm project={project} captions={captions} health={health} time={time} onStyle={onStyle} onSegments={onSegments} onRegroup={onRegroup} onSeek={onSeek} {...rest} />}
      {project.transcript && (
        <p className="fineprint">Transcribed by Deepgram {project.transcript.model}{project.transcript.language ? ` · ${project.transcript.language}` : ""}. Edits are saved automatically and burned into your export with the same fonts you see here.</p>
      )}
    </div>
  );
}

/** Text field that commits on blur/Enter so retiming happens once per edit. */
function CueText({ seg, onCommit }: { seg: CaptionSegment; onCommit: (text: string) => void }) {
  const [value, setValue] = useState(segmentText(seg));
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setValue(segmentText(seg)), [seg]);
  useEffect(() => {
    const el = ref.current;
    if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }
  }, [value]);
  const commit = () => {
    if (!value.trim()) return setValue(segmentText(seg));
    if (value.trim() !== segmentText(seg)) onCommit(value);
  };
  return (
    <textarea ref={ref} className="cue__text" rows={1} value={value} maxLength={400} enterKeyHint="done"
      onChange={(e) => setValue(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }} />
  );
}
