import { describe, expect, it } from "vitest";
import { buildAss, defaultCaptionStyle, escapeFilterPath, groupWords, retimeText, validateSegments, type Captions } from "../src/lib/captions.js";
import { planChunks, SAMPLE_RATE } from "../src/lib/whisper/chunks.js";

const words = [
  ["Hi,", 0.1, 0.3], ["I'm", 0.35, 0.5], ["Sokchea.", 0.55, 1.0],
  ["Today", 1.8, 2.0], ["I'll", 2.05, 2.2], ["show", 2.25, 2.4], ["you", 2.45, 2.55], ["how", 2.6, 2.75], ["to", 2.8, 2.85], ["build", 2.9, 3.1], ["a", 3.15, 3.2], ["premium", 3.25, 3.6], ["brand.", 3.65, 4.0],
].map(([text, start, end]) => ({ text: String(text), start: Number(start), end: Number(end), confidence: 0.99 }));

describe("caption grouping", () => {
  it("breaks at sentence ends and long pauses", () => {
    const segs = groupWords(words, "balanced");
    expect(segs[0].words.map((w) => w.text).join(" ")).toBe("Hi, I'm Sokchea.");
    expect(segs[1].words[0].text).toBe("Today");
    for (const s of segs) expect(s.words.length).toBeLessThanOrEqual(6);
  });

  it("punchy mode keeps captions to three words", () => {
    for (const s of groupWords(words, "punchy")) expect(s.words.length).toBeLessThanOrEqual(3);
  });

  it("segments never overlap and stay synchronised to speech", () => {
    const segs = groupWords(words, "lines");
    for (let i = 0; i < segs.length; i++) {
      expect(segs[i].start).toBe(segs[i].words[0].start);
      if (segs[i + 1]) expect(segs[i].end).toBeLessThanOrEqual(segs[i + 1].start);
    }
  });
});

describe("caption editing", () => {
  const seg = { start: 1, end: 3, words: [{ text: "helo", start: 1, end: 1.5 }, { text: "world", start: 1.6, end: 2.4 }] };
  it("keeps word timings when the word count is unchanged", () => {
    expect(retimeText(seg, "Hello world!")).toEqual([{ text: "Hello", start: 1, end: 1.5 }, { text: "world!", start: 1.6, end: 2.4 }]);
  });
  it("redistributes timing when words are added", () => {
    const w = retimeText(seg, "hello there big world");
    expect(w).toHaveLength(4);
    expect(w[0].start).toBe(1);
    expect(w[3].end).toBeCloseTo(3, 2);
  });
  it("validates and clamps edited segments", () => {
    const out = validateSegments([{ id: "a", start: 9, end: 12, words: [{ text: "x", start: 9, end: 11 }] }], 10);
    expect(out[0].end).toBe(10);
    expect(() => validateSegments([{ id: "a", start: 1, end: 1.05, words: [{ text: "x", start: 1, end: 1 }] }], 10)).toThrow();
    expect(() => validateSegments([{ id: "a", start: 1, end: 2, words: [] }], 10)).toThrow();
  });
});

describe("ASS rendering", () => {
  const captions: Captions = { style: defaultCaptionStyle(), segments: groupWords(words, "balanced"), edited: false };

  it("emits one contiguous event per word with highlight colour", () => {
    const ass = buildAss(captions, { width: 1080, height: 1920, outDuration: 10, map: (t) => t });
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toContain("Poppins ExtraBold");
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(events.length).toBe(words.length);
    expect(events[0]).toContain("\\1c&H0098CBE3"); // #E3CB98 as &HAABBGGRR
    expect(events[0]).toContain("HI,");
  });

  it("maps to output time through trim and speed, dropping captions outside the clip", () => {
    // trim 1.5s→, 2x speed
    const ass = buildAss(captions, { width: 1080, height: 1920, outDuration: 1.25, map: (t) => (t - 1.5) / 2 });
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(events.some((e) => e.includes("SOKCHEA"))).toBe(false);
    expect(events[0]).toMatch(/^Dialogue: 0,0:00:00\.15,/); // Today @1.8 → 0.15
  });

  it("static mode emits one event per caption with fades", () => {
    const ass = buildAss({ ...captions, style: { ...captions.style, animate: false, preset: "editorial" } }, { width: 1920, height: 1080, outDuration: 10, map: (t) => t });
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(events.length).toBe(captions.segments.length);
    expect(events[0]).toContain("\\fad(");
    expect(ass).toContain("DM Serif Display");
  });

  it("omits fades for single-frame renders", () => {
    const ass = buildAss(captions, { width: 1080, height: 1920, outDuration: 1, map: (t) => t, still: true });
    expect(ass).not.toContain("\\fad");
  });

  it("neutralises override braces in user text", () => {
    const c: Captions = { ...captions, segments: [{ id: "x", start: 0, end: 1, words: [{ text: "{\\b1}hack", start: 0, end: 1 }] }] };
    const ass = buildAss(c, { width: 1080, height: 1080, outDuration: 2, map: (t) => t });
    expect(ass).not.toContain("{\\b1}");
  });

  it("escapes awkward paths for the filtergraph", () => {
    expect(escapeFilterPath("/tmp/a b/it's:x,[1].ass")).toBe(String.raw`/tmp/a b/it\\\'s\\:x\,\[1\].ass`);
  });
});

describe("Whisper audio chunking", () => {
  it("keeps short audio in one chunk", () => {
    expect(planChunks(new Float32Array(SAMPLE_RATE * 10))).toEqual([{ start: 0, end: SAMPLE_RATE * 10 }]);
  });
  it("splits long audio into <=28 s windows, cutting in the quietest gap", () => {
    // 70 s of "speech" (noise) with silent gaps at 26 s and 53 s
    const a = new Float32Array(SAMPLE_RATE * 70).map(() => Math.random() * 0.5 - 0.25);
    for (const gap of [26, 53]) a.fill(0, gap * SAMPLE_RATE, (gap + 0.3) * SAMPLE_RATE);
    const chunks = planChunks(a);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(28 * SAMPLE_RATE);
    expect(chunks[0].end / SAMPLE_RATE).toBeGreaterThanOrEqual(26);
    expect(chunks[0].end / SAMPLE_RATE).toBeLessThanOrEqual(26.3);
    expect(chunks[2].end).toBe(a.length);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].start).toBe(chunks[i - 1].end);
  });
});

describe("preset font metrics", () => {
  it("emRatio matches each bundled font's OS/2 win metrics", async () => {
    const { PRESETS } = await import("../src/lib/captions.js");
    const files: Record<string, string> = { "Poppins ExtraBold": "Poppins-ExtraBold.ttf", "Poppins SemiBold": "Poppins-SemiBold.ttf", "DM Serif Display": "DMSerifDisplay-Regular.ttf", Anton: "Anton-Regular.ttf" };
    for (const p of Object.values(PRESETS)) {
      const buf = (await import("node:fs")).readFileSync(`assets/fonts/${files[p.font]}`);
      // Parse sfnt table directory for head.unitsPerEm and OS/2 win metrics.
      const n = buf.readUInt16BE(4);
      const tables: Record<string, number> = {};
      for (let i = 0; i < n; i++) tables[buf.toString("latin1", 12 + i * 16, 16 + i * 16)] = buf.readUInt32BE(12 + i * 16 + 8);
      const upm = buf.readUInt16BE(tables.head + 18);
      const winAsc = buf.readUInt16BE(tables["OS/2"] + 74), winDesc = buf.readUInt16BE(tables["OS/2"] + 76);
      expect(p.emRatio).toBeCloseTo(upm / (winAsc + winDesc), 3);
    }
  });
});
