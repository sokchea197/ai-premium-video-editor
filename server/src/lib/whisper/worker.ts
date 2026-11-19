/**
 * Whisper inference worker (open-source Whisper via transformers.js + ONNX Runtime).
 * Runs off the main thread so the server stays responsive. Everything is local;
 * the model is downloaded once from Hugging Face (free) and cached.
 */
import { parentPort } from "node:worker_threads";
import { env, pipeline } from "@huggingface/transformers";
import { planChunks, SAMPLE_RATE } from "./chunks.js";

type Req = { id: string; audio: Float32Array; model: string; language: string; cacheDir: string };

const loaded = new Map<string, Promise<any>>();

function load(model: string, cacheDir: string, onDownload: (pct: number, mb: number) => void) {
  const key = `${cacheDir}|${model}`;
  if (!loaded.has(key)) {
    env.cacheDir = cacheDir;
    env.allowLocalModels = false;
    const files = new Map<string, { loaded: number; total: number }>();
    const p = pipeline("automatic-speech-recognition", model, {
      dtype: "q8",
      device: "cpu",
      progress_callback: (e: any) => {
        if (e.status === "progress" && e.total) {
          files.set(e.file, { loaded: e.loaded, total: e.total });
          let l = 0, t = 0;
          for (const f of files.values()) { l += f.loaded; t += f.total; }
          onDownload(l / t, t / 1e6);
        }
      },
    });
    p.catch(() => loaded.delete(key));
    loaded.set(key, p);
  }
  return loaded.get(key)!;
}

parentPort!.on("message", async (req: Req) => {
  const post = (m: object) => parentPort!.postMessage({ id: req.id, ...m });
  try {
    const asr = await load(req.model, req.cacheDir, (f, mb) => post({ type: "download", fraction: f, totalMb: mb }));
    const chunks = planChunks(req.audio);
    const words: { text: string; start: number; end: number; confidence: number }[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const offset = c.start / SAMPLE_RATE;
      post({ type: "progress", fraction: i / chunks.length });
      const out = await asr(req.audio.subarray(c.start, c.end), {
        return_timestamps: "word",
        language: req.language,
        task: "transcribe",
      });
      for (const w of out.chunks ?? []) {
        const text = String(w.text ?? "").trim();
        const [s, e] = w.timestamp ?? [];
        if (!text || typeof s !== "number") continue;
        const end = typeof e === "number" ? e : s + 0.3;
        words.push({ text, start: +(offset + s).toFixed(3), end: +(offset + Math.max(s, end)).toFixed(3), confidence: 1 });
      }
    }
    post({ type: "done", words });
  } catch (e: any) {
    post({ type: "error", message: e?.message ?? String(e) });
  }
});
