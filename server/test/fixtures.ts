import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ave-fixtures-"));
  const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  const landscape = path.join(dir, "landscape.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", landscape]);
  // iPhone-style portrait MOV: landscape-coded frames with a 90° display rotation.
  const portraitMov = path.join(dir, "portrait.mov");
  ff(["-display_rotation", "90", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=3", "-f", "lavfi", "-i", "sine=frequency=220:duration=3",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", portraitMov]);
  const silent = path.join(dir, "silent.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=size=1080x1080:rate=25:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", silent]);
  const fake = path.join(dir, "fake.mp4");
  fs.writeFileSync(fake, "this is not a video");
  const text = path.join(dir, "notes.txt");
  fs.writeFileSync(text, "hello");
  return { dir, landscape, portraitMov, silent, fake, text, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
