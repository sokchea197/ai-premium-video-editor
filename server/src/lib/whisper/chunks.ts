export const SAMPLE_RATE = 16000;

/**
 * Splits 16 kHz mono audio into windows of at most `maxSec`, cutting at the
 * quietest 50 ms within the last `searchSec` of each window so cuts land in
 * pauses between words rather than mid-word.
 */
export function planChunks(audio: Float32Array, maxSec = 28, searchSec = 5): { start: number; end: number }[] {
  const max = Math.floor(maxSec * SAMPLE_RATE);
  const search = Math.floor(searchSec * SAMPLE_RATE);
  const win = Math.floor(0.05 * SAMPLE_RATE);
  const out: { start: number; end: number }[] = [];
  let start = 0;
  while (start < audio.length) {
    if (audio.length - start <= max) {
      out.push({ start, end: audio.length });
      break;
    }
    let bestEnd = start + max;
    let best = Infinity;
    for (let s = start + max - search; s + win <= start + max; s += win / 2) {
      let e = 0;
      for (let i = s; i < s + win; i++) e += audio[i] * audio[i];
      if (e < best) {
        best = e;
        bestEnd = s + Math.floor(win / 2);
      }
    }
    out.push({ start, end: bestEnd });
    start = bestEnd;
  }
  return out;
}

/** Peak-normalise very quiet recordings (helps Whisper with distant mics). */
export function normalise(audio: Float32Array) {
  let peak = 0;
  for (let i = 0; i < audio.length; i++) peak = Math.max(peak, Math.abs(audio[i]));
  if (peak > 0 && peak < 0.5) {
    const g = 0.9 / peak;
    for (let i = 0; i < audio.length; i++) audio[i] *= g;
  }
  return audio;
}
