import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { lookCss } from "../lib/looks";
import type { EditSettings, Project } from "../lib/types";

const RATIO: Record<EditSettings["aspect"], number> = { "9:16": 9 / 16, "1:1": 1, "16:9": 16 / 9 };

interface Props {
  project: Project;
  edit: EditSettings;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  trueFrame: { url: string | null; loading: boolean; error: string | null };
  onTogglePlay: () => void;
  playing: boolean;
}

/** Live, CSS-approximated preview of the edit inside the target frame. */
export function Preview({ project, edit, videoRef, trueFrame, onTogglePlay, playing }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const r = RATIO[edit.aspect];
      const w = Math.min(width, height * r);
      setSize({ w: Math.floor(w), h: Math.floor(w / r) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [edit.aspect]);

  // Blurred backdrop: paint the playing video into a tiny canvas and blur it with CSS.
  useEffect(() => {
    if (edit.fit !== "blur") return;
    let raf = 0;
    const draw = () => {
      const v = videoRef.current;
      const c = canvasRef.current;
      if (v && c && v.readyState >= 2) {
        const ctx = c.getContext("2d");
        if (ctx) {
          const r = RATIO[edit.aspect];
          const vr = v.videoWidth / v.videoHeight;
          // cover-crop
          let sw = v.videoWidth, sh = v.videoHeight;
          if (vr > r) sw = sh * r; else sh = sw / r;
          ctx.drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sh) / 2, sw, sh, 0, 0, c.width, c.height);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [edit.fit, edit.aspect, videoRef]);

  const filter = lookCss(edit.look, edit.lookIntensity);
  const fill = edit.fit === "fill";

  return (
    <div className="stage" ref={stageRef}>
      <div className="frame" style={{ width: size.w, height: size.h }} onClick={onTogglePlay}>
        {!fill && (
          <canvas ref={canvasRef} className="frame__backdrop" width={48} height={Math.round(48 / RATIO[edit.aspect])} style={{ filter: `${filter} blur(18px) brightness(0.9) saturate(1.1)` }} />
        )}
        <video
          ref={videoRef}
          className="frame__video"
          src={project.urls.proxy ?? undefined}
          poster={project.urls.thumb ?? undefined}
          playsInline
          preload="auto"
          onLoadedMetadata={(e) => {
            // Show the real frame at the trim start instead of the poster.
            e.currentTarget.currentTime = edit.trimStart + 0.001;
          }}
          style={{
            objectFit: fill ? "cover" : "contain",
            objectPosition: `${edit.focusX * 100}% ${edit.focusY * 100}%`,
            filter,
          }}
        />
        {edit.vignette && <div className="frame__vignette" />}
        {trueFrame.url && <img className="frame__true" src={trueFrame.url} alt="Exact rendered frame" />}
        {trueFrame.url && <span className="frame__badge">Exact render</span>}
        {trueFrame.loading && <span className="frame__badge">Rendering frame…</span>}
        {!playing && !trueFrame.url && (
          <button className="frame__play" aria-label="Play">
            <svg width="22" height="22" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
          </button>
        )}
      </div>
    </div>
  );
}
