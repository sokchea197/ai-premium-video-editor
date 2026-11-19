import { useRef } from "react";
import { formatTime } from "../lib/format";

interface Props {
  duration: number;
  start: number;
  end: number;
  current: number;
  speed: number;
  filmstrip: string | null;
  onTrim: (start: number, end: number) => void;
  onSeek: (t: number) => void;
}

const MIN_GAP = 0.5;

export function Timeline({ duration, start, end, current, speed, filmstrip, onTrim, onSeek }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pct = (t: number) => `${(t / duration) * 100}%`;

  const timeAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  };

  const drag = (kind: "start" | "end" | "seek") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const t = timeAt(ev.clientX);
      if (kind === "start") onTrim(Math.min(t, end - MIN_GAP), end);
      else if (kind === "end") onTrim(start, Math.max(t, start + MIN_GAP));
      else onSeek(Math.max(start, Math.min(end, t)));
    };
    move(e.nativeEvent);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const len = end - start;
  return (
    <div className="timeline">
      <div className="timeline__labels">
        <span>{formatTime(current, true)}</span>
        <span className="muted">
          Clip {formatTime(len, true)}
          {speed !== 1 && <> · plays {formatTime(len / speed, true)} at {speed}×</>}
        </span>
        <span className="muted">{formatTime(duration, true)}</span>
      </div>
      <div className="track" ref={trackRef} onPointerDown={drag("seek")}>
        <div className="track__strip" style={filmstrip ? { backgroundImage: `url(${filmstrip})` } : undefined} />
        <div className="track__dim" style={{ left: 0, width: pct(start) }} />
        <div className="track__dim" style={{ left: pct(end), right: 0 }} />
        <div className="track__window" style={{ left: pct(start), width: pct(len) }}>
          <div className="handle handle--start" onPointerDown={drag("start")} role="slider" aria-label="Trim start" aria-valuenow={start} tabIndex={0} />
          <div className="handle handle--end" onPointerDown={drag("end")} role="slider" aria-label="Trim end" aria-valuenow={end} tabIndex={0} />
        </div>
        <div className="playhead" style={{ left: pct(current) }} />
      </div>
    </div>
  );
}
