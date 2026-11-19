import type { Aspect, Captions, PresetDef } from "../lib/types";
import { OUTPUT, captionLayout } from "../lib/captions";

const rgba = (hex: string, assAlpha: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${((255 - assAlpha) / 255).toFixed(3)})`;
};

interface Props {
  captions: Captions;
  preset: PresetDef | undefined;
  aspect: Aspect;
  frameWidth: number;
  /** Source time in seconds. */
  time: number;
  trimStart: number;
  trimEnd: number;
}

/** Live caption preview using the same fonts, sizes and safe-zone margins as the libass export. */
export function CaptionOverlay({ captions, preset, aspect, frameWidth, time, trimStart, trimEnd }: Props) {
  const { style } = captions;
  if (!style.enabled || !preset || frameWidth <= 0 || time < trimStart || time > trimEnd) return null;
  const seg = captions.segments.find((s) => time >= s.start && time < s.end);
  if (!seg) return null;

  const out = OUTPUT[aspect];
  const L = captionLayout(style, preset, out.width, out.height);
  const k = frameWidth / out.width;
  const px = (n: number) => `${(n * k).toFixed(2)}px`;
  const outline = preset.outline * L.scale;

  let activeIdx = -1;
  if (style.animate) {
    for (let i = 0; i < seg.words.length; i++) if (i === 0 || seg.words[i].start <= time) activeIdx = i;
  }

  const textStyle: React.CSSProperties = {
    fontFamily: `"${preset.cssFamily}", sans-serif`,
    fontWeight: preset.cssWeight,
    // Match libass sizing: ASS size = ascent+descent height; CSS size = em box.
    fontSize: px(L.fontSize * preset.emRatio),
    lineHeight: 1 / preset.emRatio,
    letterSpacing: px(preset.letterSpacing * L.scale),
    color: preset.color,
    textTransform: preset.uppercase ? "uppercase" : "none",
    ...(preset.box
      ? { background: rgba(preset.outlineColor, preset.boxAlpha), padding: `${px(outline * 0.45)} ${px(outline)}`, borderRadius: px(6) }
      : {
          WebkitTextStroke: outline ? `${px(outline * 2)} ${rgba(preset.outlineColor, preset.outlineAlpha)}` : undefined,
          paintOrder: "stroke fill",
          textShadow: preset.shadow ? `${px(preset.shadow * L.scale)} ${px(preset.shadow * L.scale)} 0 ${rgba("#000000", preset.shadowAlpha)}` : undefined,
        }),
  };

  const justify = style.position === "lower" ? "flex-end" : style.position === "middle" ? "center" : "flex-start";
  return (
    <div
      className="captions-layer"
      style={{
        justifyContent: justify,
        paddingBottom: style.position === "lower" ? px(L.marginV) : 0,
        paddingTop: style.position === "upper" ? px(L.marginV) : 0,
        paddingLeft: px(L.marginH),
        paddingRight: px(L.marginH),
      }}
    >
      <div key={seg.id} className="caption" style={textStyle}>
        {seg.words.map((w, i) => (
          <span key={i}>
            {i > 0 && " "}
            <span
              className="caption__word"
              // Scale via font-size (like libass \fscx/\fscy) so neighbouring words make room.
              style={i === activeIdx ? { color: style.highlight, fontStyle: preset.activeItalic ? "italic" : undefined, fontSize: `${preset.activeScale}em`, lineHeight: 0 } : undefined}
            >
              {w.text}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
