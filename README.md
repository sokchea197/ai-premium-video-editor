# AI Premium Video Editor

A web app for turning raw footage into polished personal-branding videos for Instagram Reels and TikTok. It runs on iPhone and desktop.

**Zero running cost.** Everything runs on your own computer with free, open-source tools: FFmpeg renders the video, and Whisper (OpenAI's open-source speech model, run locally) transcribes speech. There are no accounts, API keys, subscriptions or hosting fees. Your footage never leaves your computer.

## Only have an iPhone? Use GitHub Codespaces (free)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/sokchea197/ai-premium-video-editor/tree/claude/ai-premium-video-repo-ra4jra?quickstart=1)

An iPhone can't run FFmpeg or Whisper itself, so the editor runs on a free GitHub cloud machine and you use it from Safari.

- **Cost:** $0. Personal GitHub accounts include 120 core-hours a month (about 60 hours on the 2-core machine this project uses) and 15 GB of storage. No credit card is needed. Without a payment method, GitHub stops the codespace when the free allowance is used up and never charges you.
- **Steps:**
  1. In Safari, open the "Open in GitHub Codespaces" link above while signed in to GitHub, then tap **Create codespace** (or **Resume** later).
  2. The first time only, setup takes 3–5 minutes (it installs FFmpeg and builds the editor).
  3. The terminal then prints **"Open this link in Safari on your iPhone: https://…app.github.dev"**. Tap it.
- **Good to know:**
  - The codespace pauses after 30 minutes without activity. Open the same link again to resume.
  - Download your finished videos, and delete old projects in the editor to stay within the 15 GB of free storage.
  - Your project link is private to your GitHub account.

## Quick start (Mac or Windows computer)

You need two free tools:

| | macOS | Windows |
|---|---|---|
| **Node.js 20+** | `brew install node`, or the installer from nodejs.org | installer from nodejs.org, or `winget install OpenJS.NodeJS.LTS` |
| **FFmpeg** | `brew install ffmpeg` | `winget install Gyan.FFmpeg` |

Then, in the project folder:

```bash
npm install
npm start
```

`npm start` builds the interface and starts the editor. It prints two addresses:

```
On this computer:  http://localhost:8787
On your iPhone:    http://192.168.1.23:8787   (same Wi-Fi)
```

**On your iPhone:** join the same Wi-Fi as the computer and open the "On your iPhone" address in Safari. You can upload straight from Photos or Files. Tip: tap Share → Add to Home Screen to use it like an app.

> The computer must stay on, with `npm start` running, while you edit. On macOS, if a firewall prompt appears the first time, click **Allow** so your iPhone can connect.

The first time you generate subtitles, the free Whisper model downloads once (241 MB, or 76 MB for the faster model). After that, it works offline.

For development, `npm run dev` runs a hot-reloading client and server. Tests (`npm test`) run real FFmpeg renders and real Whisper.

## The workflow

1. **Upload** footage (MP4/MOV, including iPhone 4K HEVC and HDR, up to 20 GB).
2. **Describe your edit** in the *Direct* tab, for example "Vertical for Reels, cinematic look, add bold captions with gold highlight, fade out at the end". The editor shows exactly what it will change, and anything it didn't understand, before you apply it.
3. **Preview** instantly in the editor, and fine-tune in the Frame, Look, Motion, Audio and Captions tabs.
4. **Export** a 1080p MP4 and download it.

## What works today

| Area | Features |
|---|---|
| **Upload** | Resumable chunked upload (8 MB chunks with automatic retry). If the iPhone locks or the Wi-Fi drops, it continues from where it stopped, and it keeps the screen awake while uploading. Accepts MP4, MOV and iPhone HEVC/HDR from Photos or Files, up to 20 GB, with speed and time remaining shown. Files are checked by their **content** with ffprobe, not by file name. |
| **Preview** | Generates a smooth H.264 preview, a poster frame and a timeline filmstrip. HDR (HLG/Dolby Vision/PQ) iPhone footage is tone-mapped to SDR after downscaling: a 10 s 4K/60 HDR clip is ready in about 9 s. |
| **Direct (plain English)** | Type what you want. A local interpreter (free, no AI service) maps it to edits for format, framing, looks, speed, trimming and length, fades, sound and captions. It previews the changes, lists anything it didn't understand, and applies on confirmation. |
| **Framing** | 9:16, 1:1 and 16:9. *Fill frame* crops the video and lets you move the subject position. *Full shot* fits the whole video over a blurred backdrop. |
| **Colour** | Seven grades (Natural, Cinematic, Warm Luxe, Noir, Clean Bright, Film Fade, Emerald), each with an intensity slider, plus an optional vignette. The live preview approximates the grade with CSS. **Show exact rendered frame** renders the real FFmpeg frame. |
| **Motion** | Trim with drag handles that work with touch. Speed from 0.5× to 2× with pitch preserved. Optional motion-interpolated smooth slow motion. Fade in and fade out. |
| **Sound** | EBU R128 loudness normalisation to −14 LUFS / −1.5 dBTP, the Instagram/TikTok target, plus a volume control. |
| **Export** | 1080p H.264 High profile (CRF 18) with 48 kHz AAC, BT.709 colour and faststart MP4. Progress streams live over SSE, with polling as a fallback, and exports can be cancelled. **Every export is checked with ffprobe** (dimensions and duration) before it is marked done. |
| **Subtitles** | Transcribes speech **locally with open-source Whisper** (transformers.js and ONNX Runtime, in a background thread) with word-level timestamps, in 20+ languages including Khmer. Two models: Best (small) and Fast (base). Free and private. |
| **Caption editing** | Edit text inline; word timings are kept, or redistributed if you add or remove words. Nudge start and end by 0.1 s, merge or delete captions, add a caption at the playhead, and choose Punchy, Balanced or Full-line caption lengths. Changes autosave and are validated on the server. |
| **Caption design** | Four typography presets: Bold Pop (Poppins ExtraBold), Editorial (DM Serif Display), Minimal (Poppins on a soft panel) and Impact (Anton). Word-by-word highlight synced to speech, six highlight colours, top/centre/bottom placement that clears the Reels/TikTok interface, and size control. Captions are burned into the export with libass using the **same bundled font files** the preview uses, so preview and export match. |
| **Reliability** | Edits autosave and are validated on the server. A render uses a snapshot of the edit taken when export starts, so later changes don't affect it. Writes are atomic. If the server restarts mid-job, the job is marked failed rather than left looking "done", and can be retried. |

## Architecture

```
web/  (React 19 + Vite, TypeScript)           server/  (Node 22 + Express 5, TypeScript)
┌──────────────────────────────┐   REST + SSE   ┌──────────────────────────────────────┐
│ Library · Upload (XHR)       │ ─────────────▶ │ routes (app.ts)  zod-validated edits │
│ Editor                       │                │   │                                  │
│  ├ Preview (proxy + CSS look)│ ◀── proxy.mp4  │ ProjectStore  data/projects/<id>/    │
│  ├ Timeline (trim, filmstrip)│                │   project.json · source.* · proxy.mp4│
│  ├ Panels (frame/look/…)     │                │   thumb.jpg · filmstrip.jpg · exports│
│  └ Export (live progress)    │ ◀── job events │ JobManager  (queue, cancel, events)  │
└──────────────────────────────┘                │ Pipeline    ingest · export · still  │
                                                │ render.ts   pure FFmpeg graph builder│
                                                │ ffmpeg.ts   probe · run w/ progress  │
                                                │ whisper/    local speech-to-text worker│
                                                │ instructions.ts plain-English → edits│
                                                │ uploads.ts  resumable chunked uploads│
                                                │ captions.ts grouping · editing · ASS │
                                                └──────────────────────────────────────┘
```

Key design decisions:

- **One source of truth for rendering.** `server/src/lib/render.ts` builds the FFmpeg filter graph from the edit settings as a pure function. Export and the exact-frame preview both use it, so the preview frame matches the export pixel for pixel. Because it is a pure function, it is unit-tested directly.
- **The edit model is a declarative JSON document**, validated by one zod schema (`server/src/lib/edit.ts`). AI features in later stages will *propose* changes to this document, and those go through the same validation before you apply them. That keeps AI output inspectable, reversible and safe.
- **Honest job states.** A job is only `done` after FFmpeg exits cleanly *and* the output passes ffprobe verification. Failures carry the FFmpeg stderr tail for debugging.
- **Local-first storage**: one directory per project. This is easy to move to object storage (S3/R2) later.

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | FFmpeg capabilities, formats, looks and AI feature availability |
| POST | `/api/uploads` → PUT `/api/uploads/:id?offset=` → POST `/api/uploads/:id/complete` | Resumable chunked upload (used by the app) |
| POST | `/api/projects` | Single-request upload (`multipart/form-data`, field `video`) |
| POST | `/api/projects/:id/instructions` | Plain-English edit instructions (`{ text, apply }`) |
| GET / PATCH / DELETE | `/api/projects/:id` | Read, edit (`{ name?, edit?, captions?: { style?, segments? } }`) or delete a project |
| POST | `/api/projects/:id/transcribe` | Start local Whisper transcription (`{ language: "en" \| "km" \| …, model: "small" \| "base" }`) |
| POST | `/api/projects/:id/captions/regroup` | Rebuild captions from the transcript (`{ chunking: "punchy" \| "balanced" \| "lines" }`) |
| GET | `/api/fonts/:file` | Bundled caption fonts (OFL), used by the browser preview |
| POST | `/api/projects/:id/reprocess` | Retry a failed ingest |
| GET | `/api/projects/:id/media/{proxy.mp4,thumb.jpg,filmstrip.jpg}` | Preview media (range requests supported) |
| GET | `/api/projects/:id/frame?t=` | Exact FFmpeg-rendered JPEG of the current edit |
| POST | `/api/projects/:id/exports` | Start a 1080p export |
| GET | `/api/projects/:id/exports/:exportId/download` | Download the MP4 |
| GET | `/api/jobs/:id` · `/api/jobs/:id/events` (SSE) · POST `/api/jobs/:id/cancel` | Job status, live progress, cancel |

## Roadmap

| Stage | Scope | Cost |
|---|---|---|
| **1 · Foundation** ✅ | Upload, preview, framing, grading, speed, fades, loudness, verified 1080p export | $0 |
| **2 · Subtitles** ✅ | Local Whisper transcription, caption editor, animated premium caption presets, burned-in export | $0 |
| **2.5 · Direct** ✅ | Plain-English instructions interpreted locally | $0 |
| **3 · Smart editing** | Automatic silence and filler-word removal, highlight detection from transcript and audio energy, multi-clip cut lists, transitions (`xfade`), cinematic push-in zooms, title cards, phrase highlights, brand kit | $0 (FFmpeg + local analysis) |

### About AI services and cost

The project is designed to cost nothing beyond what you already pay for. Note that **a Claude.ai subscription doesn't include Claude API access**: the API is billed separately per use. So this app doesn't call any paid AI service. Plain-English editing uses a local, rule-based interpreter. It's free, private and predictable, but it only understands the kinds of instructions listed above. A smarter free option would be a local language model (for example via Ollama), which needs a fairly powerful computer. Any feature that requires payment will only be added with your explicit approval.
