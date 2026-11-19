# AI Premium Video Editor

A web app for turning raw footage into polished personal-branding videos for Instagram Reels and TikTok. It runs on iPhone and desktop, and FFmpeg does all the rendering.

> **Status: Stage 1 (foundation) is complete.** Upload, preview, framing, colour grading, slow motion, fades, loudness balancing and verified 1080p export all work end to end.
> Automatic subtitles and the AI editing assistant come in Stages 2–3. The app reports them as **not yet available**, and nothing about them is simulated.

## Quick start

Requirements: **Node.js 22+** and **FFmpeg 6+** with `libx264`. For HDR footage and later captions you also need `zscale` (libzimg) and `libass`. The standard Ubuntu/Debian and Homebrew `ffmpeg` packages include all of these.

```bash
npm install
npm run build          # builds the web client
npm start              # http://localhost:8787 (serves API + client)
```

For development, run hot-reloading client and server together:

```bash
npm run dev            # client on :5173 (proxies /api → :8787)
```

To open it on your iPhone, start the server on your computer, then visit `http://<computer-LAN-IP>:8787` (or `:5173` in dev) on the same Wi-Fi network.

Tests (these run real FFmpeg renders and check the output with ffprobe):

```bash
npm test
npm run typecheck
```

## What works today

| Area | Features |
|---|---|
| **Upload** | MP4 / MOV / M4V, up to 4 GB by default. Shows real byte-level progress and can be cancelled. Every file is checked with ffprobe; non-video and corrupt files are rejected with a clear message. iPhone rotation metadata is honoured. |
| **Preview** | Generates a smooth H.264 preview proxy, a poster frame and a timeline filmstrip. HDR (HLG/Dolby Vision/PQ) iPhone footage is tone-mapped to SDR so colours don't wash out. |
| **Framing** | 9:16, 1:1 and 16:9. *Fill frame* crops the video and lets you move the subject position. *Full shot* fits the whole video over a blurred backdrop. |
| **Colour** | Seven grades (Natural, Cinematic, Warm Luxe, Noir, Clean Bright, Film Fade, Emerald), each with an intensity slider, plus an optional vignette. The live preview approximates the grade with CSS. **Show exact rendered frame** renders the real FFmpeg frame. |
| **Motion** | Trim with drag handles that work with touch. Speed from 0.5× to 2× with pitch preserved. Optional motion-interpolated smooth slow motion. Fade in and fade out. |
| **Sound** | EBU R128 loudness normalisation to −14 LUFS / −1.5 dBTP, the Instagram/TikTok target, plus a volume control. |
| **Export** | 1080p H.264 High profile (CRF 18) with 48 kHz AAC, BT.709 colour and faststart MP4. Progress streams live over SSE, with polling as a fallback, and exports can be cancelled. **Every export is checked with ffprobe** (dimensions and duration) before it is marked done. |
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
| POST | `/api/projects` | Upload (`multipart/form-data`, field `video`) and start ingest |
| GET / PATCH / DELETE | `/api/projects/:id` | Read, edit (`{ name?, edit? }`) or delete a project |
| POST | `/api/projects/:id/reprocess` | Retry a failed ingest |
| GET | `/api/projects/:id/media/{proxy.mp4,thumb.jpg,filmstrip.jpg}` | Preview media (range requests supported) |
| GET | `/api/projects/:id/frame?t=` | Exact FFmpeg-rendered JPEG of the current edit |
| POST | `/api/projects/:id/exports` | Start a 1080p export |
| GET | `/api/projects/:id/exports/:exportId/download` | Download the MP4 |
| GET | `/api/jobs/:id` · `/api/jobs/:id/events` (SSE) · POST `/api/jobs/:id/cancel` | Job status, live progress, cancel |

## Roadmap

| Stage | Scope | External needs |
|---|---|---|
| **1 · Foundation** ✅ | Everything listed above | FFmpeg only |
| **2 · Subtitles** | Word-level transcription, a caption editor (fix text and timing), premium animated caption styles (word-by-word highlight, karaoke, pop), burned in with libass using bundled fonts | A speech-to-text provider (see below) |
| **3 · AI director** | Audio and scene analysis with FFmpeg (`silencedetect`, `ebur128`, `scdet`) plus the transcript, sent to Claude. Claude returns a reviewable edit plan: hook, key moments, cuts to remove filler and silence, story order, titles and highlighted phrases. Natural-language prompts ("make it punchier, 30 seconds, end on the call to action") become validated edit patches | `ANTHROPIC_API_KEY` |
| **4 · Storytelling timeline** | Multi-clip cut lists, transitions between cuts (`xfade`), cinematic push-in and Ken Burns zooms, elegant title cards and lower thirds, highlighted spoken phrases, and a brand kit (fonts, colours, logo) | — |
| **5 · Production** | Docker image, sign-in, S3/R2 storage, Redis/BullMQ worker queue for parallel renders, HTTPS deployment | Hosting, storage bucket |

## External services and keys

None are needed for Stage 1. For the later stages:

- **Claude API (Anthropic)**: powers the AI director (Stage 3), using model `claude-opus-5-5` with structured outputs so plans come back as valid JSON. You need an API key from console.anthropic.com, set as `ANTHROPIC_API_KEY`. It is billed per token, and a typical analysis of a 1–3 minute clip transcript is a small request.
- **Speech-to-text**: pick one for Stage 2. Claude doesn't transcribe audio, so this is a separate service:
  - **Deepgram (Nova-3)**: fast, accurate word-level timestamps. `DEEPGRAM_API_KEY`. *Recommended.*
  - **OpenAI Whisper API**: word timestamps via `whisper-1`. `OPENAI_API_KEY`.
  - **Self-hosted whisper.cpp / faster-whisper**: free and private with no key, but slower on CPU and needs a model download (≈150 MB–1.5 GB).
- **Infrastructure**: any Linux host with FFmpeg. Rendering is CPU-heavy, so use at least 2 vCPU and 4 GB RAM for comfortable 1080p exports. Uploads and renders need disk space, roughly 3× the source size per project.

Copy `.env.example` to `.env` (or export the variables) to configure the server.
