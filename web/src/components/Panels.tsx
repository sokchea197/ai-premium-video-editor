import type { EditSettings, Health, Project } from "../lib/types";
import { LOOK_SWATCH } from "../lib/looks";

type Set = (patch: Partial<EditSettings>) => void;

function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string; hint?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={String(o.value)} role="radio" aria-checked={value === o.value} className={value === o.value ? "is-active" : ""} onClick={() => onChange(o.value)}>
          <span>{o.label}</span>
          {o.hint && <small>{o.hint}</small>}
        </button>
      ))}
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <label className="slider">
      <span className="slider__head">
        <span>{label}</span>
        <span className="muted">{format ? format(value) : value}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
        style={{ "--fill": `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties} />
    </label>
  );
}

function Toggle({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`toggle ${disabled ? "is-disabled" : ""}`}>
      <span>
        <span className="toggle__label">{label}</span>
        {hint && <small className="muted">{hint}</small>}
      </span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle__switch" aria-hidden />
    </label>
  );
}

export function FramePanel({ edit, set, project }: { edit: EditSettings; set: Set; project: Project }) {
  const srcRatio = project.source.info.width / project.source.info.height;
  const target = edit.aspect === "9:16" ? 9 / 16 : edit.aspect === "1:1" ? 1 : 16 / 9;
  const cropsHorizontally = srcRatio > target;
  return (
    <div className="panel">
      <h4 className="panel__title">Format</h4>
      <Segmented value={edit.aspect} onChange={(aspect) => set({ aspect })} options={[
        { value: "9:16", label: "9:16", hint: "Reels · TikTok" },
        { value: "1:1", label: "1:1", hint: "Feed" },
        { value: "16:9", label: "16:9", hint: "YouTube" },
      ]} />
      <h4 className="panel__title">Framing</h4>
      <Segmented value={edit.fit} onChange={(fit) => set({ fit })} options={[
        { value: "fill", label: "Fill frame", hint: "Crop to fit" },
        { value: "blur", label: "Full shot", hint: "Blurred backdrop" },
      ]} />
      {edit.fit === "fill" && Math.abs(srcRatio - target) > 0.01 && (
        cropsHorizontally ? (
          <Slider label="Subject position" value={edit.focusX} min={0} max={1} step={0.01} onChange={(focusX) => set({ focusX })}
            format={(v) => (v < 0.4 ? "Left" : v > 0.6 ? "Right" : "Centre")} />
        ) : (
          <Slider label="Subject height" value={edit.focusY} min={0} max={1} step={0.01} onChange={(focusY) => set({ focusY })}
            format={(v) => (v < 0.4 ? "Top" : v > 0.6 ? "Bottom" : "Centre")} />
        )
      )}
    </div>
  );
}

export function LookPanel({ edit, set, health, onTrueFrame, trueFrameOn }: { edit: EditSettings; set: Set; health: Health | null; onTrueFrame: () => void; trueFrameOn: boolean }) {
  return (
    <div className="panel">
      <h4 className="panel__title">Colour grade</h4>
      <div className="looks">
        {(health?.looks ?? []).map((l) => (
          <button key={l.id} className={`look ${edit.look === l.id ? "is-active" : ""}`} onClick={() => set({ look: l.id })} title={l.description}>
            <span className="look__swatch" style={{ background: LOOK_SWATCH[l.id] }} />
            <span className="look__name">{l.name}</span>
          </button>
        ))}
      </div>
      <Slider label="Intensity" value={edit.lookIntensity} min={0} max={1} step={0.05} onChange={(lookIntensity) => set({ lookIntensity })} format={(v) => `${Math.round(v * 100)}%`} />
      <Toggle label="Vignette" hint="Draws the eye to your subject" checked={edit.vignette} onChange={(vignette) => set({ vignette })} />
      <button className={`btn btn--ghost btn--block ${trueFrameOn ? "is-active" : ""}`} onClick={onTrueFrame}>
        {trueFrameOn ? "Back to live preview" : "Show exact rendered frame"}
      </button>
      <p className="fineprint">Live preview approximates the grade. The exact frame is rendered by the same FFmpeg pipeline as your export.</p>
    </div>
  );
}

export function MotionPanel({ edit, set }: { edit: EditSettings; set: Set }) {
  return (
    <div className="panel">
      <h4 className="panel__title">Speed</h4>
      <Segmented value={edit.speed} onChange={(speed) => set({ speed, smoothSlowMo: speed < 1 ? edit.smoothSlowMo : false })} options={[
        { value: 0.5, label: "0.5×" }, { value: 0.75, label: "0.75×" }, { value: 1, label: "1×" },
        { value: 1.25, label: "1.25×" }, { value: 1.5, label: "1.5×" }, { value: 2, label: "2×" },
      ]} />
      <Toggle label="Smooth slow motion" hint="Motion-interpolated frames. Much slower to render." checked={edit.smoothSlowMo} disabled={edit.speed >= 1} onChange={(smoothSlowMo) => set({ smoothSlowMo })} />
      <h4 className="panel__title">Transitions</h4>
      <Slider label="Fade in" value={edit.fadeIn} min={0} max={3} step={0.1} onChange={(fadeIn) => set({ fadeIn })} format={(v) => (v ? `${v.toFixed(1)} s` : "Off")} />
      <Slider label="Fade out" value={edit.fadeOut} min={0} max={3} step={0.1} onChange={(fadeOut) => set({ fadeOut })} format={(v) => (v ? `${v.toFixed(1)} s` : "Off")} />
    </div>
  );
}

export function AudioPanel({ edit, set, project }: { edit: EditSettings; set: Set; project: Project }) {
  if (!project.source.info.hasAudio) {
    return <div className="panel"><div className="notice">This clip has no audio track. Your export will be silent.</div></div>;
  }
  return (
    <div className="panel">
      <h4 className="panel__title">Sound</h4>
      <Toggle label="Broadcast loudness" hint="Balances to −14 LUFS, the Instagram & TikTok standard" checked={edit.normalizeAudio} onChange={(normalizeAudio) => set({ normalizeAudio })} />
      <Slider label="Volume" value={edit.volume} min={0} max={2} step={0.05} onChange={(volume) => set({ volume })} format={(v) => `${Math.round(v * 100)}%`} />
      {edit.speed !== 1 && <p className="fineprint">Pitch is preserved when the speed changes.</p>}
    </div>
  );
}
