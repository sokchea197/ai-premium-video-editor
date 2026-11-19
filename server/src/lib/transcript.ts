/** Provider-neutral transcript produced by local Whisper. */
export interface TranscriptWord {
  /** Display text with punctuation (e.g. "Hello,"). */
  text: string;
  start: number;
  end: number;
  confidence: number;
}

export interface Transcript {
  provider: "whisper";
  model: string;
  language: string | null;
  audioDurationSec: number;
  createdAt: string;
  words: TranscriptWord[];
}

export class TranscriptionError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}
