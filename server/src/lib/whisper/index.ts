import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { TranscriptionError, type Transcript, type TranscriptWord } from "../transcript.js";
import { normalise, SAMPLE_RATE } from "./chunks.js";

export const WHISPER_MODELS = {
  base: { id: "onnx-community/whisper-base_timestamped", label: "Fast", sizeMb: 76 },
  small: { id: "onnx-community/whisper-small_timestamped", label: "Best", sizeMb: 241 },
} as const;
export type WhisperModel = keyof typeof WHISPER_MODELS;

export interface TranscribeRequest {
  /** 16 kHz mono float32 PCM */
  audio: Float32Array;
  model: WhisperModel;
  language: string;
  signal?: AbortSignal;
  onDownload?: (fraction: number, totalMb: number) => void;
  onProgress?: (fraction: number) => void;
}

export interface Transcriber {
  transcribe(req: TranscribeRequest): Promise<Transcript>;
}

/**
 * Local Whisper transcription in a worker thread. The worker (and the loaded
 * model) is kept warm between jobs; cancelling terminates it.
 */
export class WhisperTranscriber implements Transcriber {
  private worker: Worker | null = null;

  constructor(private cacheDir: string) {}

  private getWorker() {
    if (!this.worker) {
      // The worker is TypeScript; load it through tsx like the rest of the server.
      this.worker = new Worker(new URL("./worker.ts", import.meta.url), { execArgv: ["--import", "tsx"] });
      this.worker.unref();
      this.worker.on("exit", () => (this.worker = null));
    }
    return this.worker;
  }

  async transcribe(req: TranscribeRequest): Promise<Transcript> {
    const audio = normalise(req.audio);
    const worker = this.getWorker();
    const id = randomUUID();
    const model = WHISPER_MODELS[req.model];
    const words = await new Promise<TranscriptWord[]>((resolve, reject) => {
      const onMsg = (m: any) => {
        if (m.id !== id) return;
        if (m.type === "download") req.onDownload?.(m.fraction, m.totalMb);
        else if (m.type === "progress") req.onProgress?.(m.fraction);
        else {
          cleanup();
          if (m.type === "done") resolve(m.words);
          else reject(new TranscriptionError(friendly(m.message)));
        }
      };
      const onExit = () => {
        cleanup();
        reject(new TranscriptionError(req.signal?.aborted ? "Cancelled" : "The speech recognition engine stopped unexpectedly."));
      };
      const onAbort = () => void worker.terminate();
      const cleanup = () => {
        worker.off("message", onMsg);
        worker.off("exit", onExit);
        req.signal?.removeEventListener("abort", onAbort);
      };
      worker.on("message", onMsg);
      worker.on("exit", onExit);
      req.signal?.addEventListener("abort", onAbort, { once: true });
      worker.postMessage({ id, audio, model: model.id, language: req.language, cacheDir: this.cacheDir });
    });
    return {
      provider: "whisper",
      model: `whisper-${req.model}`,
      language: req.language,
      audioDurationSec: audio.length / SAMPLE_RATE,
      createdAt: new Date().toISOString(),
      words,
    };
  }

  close() {
    void this.worker?.terminate();
  }
}

function friendly(msg: string) {
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network/i.test(msg))
    return "Couldn't download the free Whisper speech model. It needs an internet connection once; after that it works offline.";
  return `Speech recognition failed: ${msg}`;
}
