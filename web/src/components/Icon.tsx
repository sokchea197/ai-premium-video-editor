const paths: Record<string, string> = {
  play: "M8 5.5v13l11-6.5z",
  pause: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z",
  upload: "M12 16V4m0 0l-4.5 4.5M12 4l4.5 4.5M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3",
  back: "M15 5l-7 7 7 7",
  trash: "M4 7h16M9 7V4.5h6V7m-8 0l1 12.5h8L17 7",
  download: "M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M4 19.5h16",
  close: "M6 6l12 12M18 6L6 18",
  sparkle: "M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  frame: "M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4",
  film: "M4 5h16v14H4zM8 5v14M16 5v14M4 9.5h4M4 14.5h4M16 9.5h4M16 14.5h4",
  palette: "M12 3a9 9 0 100 18c1.1 0 1.6-.9 1.2-1.8-.5-1.1.2-2.2 1.4-2.2H17a4 4 0 004-4c0-5.5-4-10-9-10zM7.5 12.5h.01M9.5 8h.01M14.5 8h.01",
  speed: "M12 20a8 8 0 118-8M12 12l4-4",
  wave: "M3 12h2m2-4v8m3-11v14m3-10v6m3-8v10m3-6v2",
  export: "M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5M5 12v7.5h14V12",
  retry: "M4 12a8 8 0 0113.7-5.7L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 01-13.7 5.7L4 15.5M4 20v-4.5h4.5",
};

export function Icon({ name, size = 18, className }: { name: keyof typeof paths | string; size?: number; className?: string }) {
  const filled = name === "play" || name === "pause";
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name]} />
    </svg>
  );
}
