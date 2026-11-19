/**
 * Deepgram pre-recorded transcription (server-side only).
 * The API key is read from server config and is never logged or returned.
 */

export interface TranscriptWord {
  /** Display text, punctuated and formatted (e.g. "Hello,"). */
  text: string;
  start: number;
  end: number;
  confidence: number;
}

export interface Transcript {
  provider: "deepgram";
  model: string;
  language: string | null;
  requestId: string | null;
  audioDurationSec: number;
  createdAt: string;
  words: TranscriptWord[];
}

export class TranscriptionError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
  }
}

export interface DeepgramOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** "auto" = detect language, "multi" = Nova-3 multilingual code-switching, else BCP-47 code. */
  language: string;
  keyterms?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function buildListenUrl(o: Pick<DeepgramOptions, "baseUrl" | "model" | "language" | "keyterms">) {
  const u = new URL("/v1/listen", o.baseUrl);
  u.searchParams.set("model", o.model);
  u.searchParams.set("smart_format", "true");
  u.searchParams.set("punctuate", "true");
  if (o.language === "auto") u.searchParams.set("detect_language", "true");
  else u.searchParams.set("language", o.language);
  for (const k of o.keyterms ?? []) u.searchParams.append("keyterm", k);
  return u;
}

function describeFailure(status: number, body: any): TranscriptionError {
  const detail = typeof body?.err_msg === "string" ? body.err_msg : typeof body?.message === "string" ? body.message : "";
  switch (status) {
    case 400:
      return new TranscriptionError(`Deepgram could not process this audio${detail ? `: ${detail}` : "."}`, status);
    case 401:
    case 403:
      return new TranscriptionError("Deepgram rejected the API key. Check DEEPGRAM_API_KEY on the server.", status);
    case 402:
      return new TranscriptionError("Your Deepgram account has run out of credit. Add credit in the Deepgram console to continue.", status);
    case 413:
      return new TranscriptionError("The audio is too large for Deepgram to accept in one request.", status);
    case 429:
      return new TranscriptionError("Deepgram is rate-limiting requests. Please try again in a minute.", status, true);
    default:
      if (status >= 500) return new TranscriptionError("Deepgram is temporarily unavailable. Please try again shortly.", status, true);
      return new TranscriptionError(`Deepgram returned an unexpected error (${status})${detail ? `: ${detail}` : ""}.`, status);
  }
}

export function parseDeepgramResponse(json: any, model: string): Transcript {
  const channel = json?.results?.channels?.[0];
  const alt = channel?.alternatives?.[0];
  if (!alt || !Array.isArray(alt.words)) throw new TranscriptionError("Deepgram returned a response without a transcript.");
  const words: TranscriptWord[] = alt.words
    .map((w: any) => ({
      text: String(w.punctuated_word ?? w.word ?? "").trim(),
      start: Number(w.start),
      end: Number(w.end),
      confidence: Number(w.confidence ?? 0),
    }))
    .filter((w: TranscriptWord) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start);
  return {
    provider: "deepgram",
    model,
    language: channel.detected_language ?? json?.metadata?.language ?? null,
    requestId: json?.metadata?.request_id ?? null,
    audioDurationSec: Number(json?.metadata?.duration ?? 0),
    createdAt: new Date().toISOString(),
    words,
  };
}

export async function transcribeWithDeepgram(audio: Buffer, contentType: string, o: DeepgramOptions): Promise<Transcript> {
  const url = buildListenUrl(o);
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 10 * 60_000);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Token ${o.apiKey}`, "Content-Type": contentType },
        body: new Uint8Array(audio),
        signal,
      });
    } catch (e) {
      if (o.signal?.aborted) throw new TranscriptionError("Cancelled");
      if (timeout.aborted) throw new TranscriptionError("Deepgram did not respond in time.", undefined, false);
      const err = new TranscriptionError("Could not reach Deepgram. Check the server's internet connection.", undefined, true);
      if (attempt >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON error page */
    }
    if (res.ok) {
      if (!body) throw new TranscriptionError("Deepgram returned an unreadable response.");
      return parseDeepgramResponse(body, o.model);
    }
    const err = describeFailure(res.status, body);
    if (!err.retryable || attempt >= attempts) throw err;
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
}
