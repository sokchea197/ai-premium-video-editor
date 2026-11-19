import type { EditSettings, LookId } from "./edit.js";
import type { CaptionStyle } from "./captions.js";

/**
 * Free, local interpreter for plain-English editing instructions.
 * It never guesses silently: every change it makes is listed, and any part of
 * the instruction it couldn't map to an edit is reported back.
 */
export interface InstructionPlan {
  edit: Partial<EditSettings>;
  captionStyle: Partial<CaptionStyle>;
  /** Start transcription if there are no captions yet. */
  transcribe: boolean;
  changes: string[];
  notUnderstood: string[];
}

interface Ctx {
  duration: number;
  current: EditSettings;
  plan: InstructionPlan;
}

const NUM: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, sixty: 60, half: 0.5 };
const num = (s: string) => (s in NUM ? NUM[s] : Number(s));
const NUMBER = String.raw`(\d+(?:\.\d+)?|\ba\b|\bone\b|\btwo\b|\bthree\b|\bfour\b|\bfive\b|\bsix\b|\bseven\b|\beight\b|\bnine\b|\bten\b|\bfifteen\b|\btwenty\b|\bthirty\b|\bsixty\b|\bhalf\b)`;
/** "1:05", "65s", "65 seconds", "1 minute" → seconds */
function parseTime(s: string): number | null {
  s = s.trim();
  let m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = new RegExp(`^${NUMBER}\\s*(s|sec|secs|seconds?|m|mins?|minutes?)?$`).exec(s);
  if (!m) return null;
  const n = num(m[1].replace(/\\b/g, ""));
  return /^m/.test(m[2] ?? "") ? n * 60 : n;
}
const TIME = String.raw`(\d+:\d{1,2}(?:\.\d+)?|${NUMBER.slice(1, -1)}(?:\s*(?:s|sec|secs|seconds?|m|mins?|minutes?))?)`;

type Rule = { re: RegExp; apply: (m: RegExpMatchArray, c: Ctx) => void };

const look = (id: LookId, label: string): Rule["apply"] => (_m, c) => {
  c.plan.edit.look = id;
  c.plan.changes.push(`Colour grade: ${label}`);
};

const RULES: Rule[] = [
  // ---- format ----
  { re: /\b(9\s*[:x/]\s*16|vertical|portrait|reels?|tik ?tok|shorts|stories)\b/, apply: (_m, c) => { c.plan.edit.aspect = "9:16"; c.plan.changes.push("Format: vertical 9:16 (Reels/TikTok)"); } },
  { re: /\b(1\s*[:x/]\s*1|square|(instagram )?feed post)\b/, apply: (_m, c) => { c.plan.edit.aspect = "1:1"; c.plan.changes.push("Format: square 1:1"); } },
  { re: /\b(16\s*[:x/]\s*9|landscape|horizontal|widescreen|youtube)\b/, apply: (_m, c) => { c.plan.edit.aspect = "16:9"; c.plan.changes.push("Format: landscape 16:9"); } },
  { re: /\b(blur(red)? (background|backdrop|bars)|full shot|don'?t crop|no crop(ping)?|fit (the )?(whole|entire)|show (the )?(whole|entire))\b/, apply: (_m, c) => { c.plan.edit.fit = "blur"; c.plan.changes.push("Framing: full shot with blurred backdrop"); } },
  { re: /\b(fill (the )?(frame|screen)|crop (it )?to fill|zoom(ed)? in to fill|full ?screen)\b/, apply: (_m, c) => { c.plan.edit.fit = "fill"; c.plan.changes.push("Framing: fill the frame"); } },
  { re: /\b(i'?m|subject|person|face)\b.*\b(on|to) the left\b/, apply: (_m, c) => { c.plan.edit.fit = "fill"; c.plan.edit.focusX = 0.2; c.plan.changes.push("Keep the subject on the left in frame"); } },
  { re: /\b(i'?m|subject|person|face)\b.*\b(on|to) the right\b/, apply: (_m, c) => { c.plan.edit.fit = "fill"; c.plan.edit.focusX = 0.8; c.plan.changes.push("Keep the subject on the right in frame"); } },

  // ---- captions (before looks: "gold highlight" etc.) ----
  { re: /\b(no|remove|without|hide|turn off|disable)\b.*\b(captions?|subtitles?)\b/, apply: (_m, c) => { c.plan.captionStyle.enabled = false; c.plan.changes.push("Captions: off"); } },
  { re: /\b(add|with|generate|create|auto|include|turn on|show)\b.*\b(captions?|subtitles?)\b|\b(captions?|subtitles?)\b.*\b(on)\b/, apply: (_m, c) => { c.plan.captionStyle.enabled = true; c.plan.transcribe = true; c.plan.changes.push("Captions: on (transcribed free with Whisper if needed)"); } },
  { re: /\b(bold|pop|punchy|hormozi|mrbeast)\b.*\b(captions?|subtitles?|text)\b|\b(captions?|subtitles?)\b.*\b(bold|pop)\b/, apply: (_m, c) => { c.plan.captionStyle.preset = "bold-pop"; c.plan.captionStyle.enabled = true; c.plan.changes.push("Caption style: Bold Pop"); } },
  { re: /\b(elegant|editorial|serif|classy|luxury|luxurious|magazine)\b.*\b(captions?|subtitles?|text|font)\b|\b(captions?|subtitles?)\b.*\b(elegant|editorial|serif)\b/, apply: (_m, c) => { c.plan.captionStyle.preset = "editorial"; c.plan.captionStyle.enabled = true; c.plan.changes.push("Caption style: Editorial"); } },
  { re: /\b(minimal|clean|simple|subtle)\b.*\b(captions?|subtitles?|text)\b/, apply: (_m, c) => { c.plan.captionStyle.preset = "minimal"; c.plan.captionStyle.enabled = true; c.plan.changes.push("Caption style: Minimal"); } },
  { re: /\b(big|huge|large|impact|loud)\b.*\b(captions?|subtitles?|text)\b(?!.*\b(smaller|bigger)\b)/, apply: (_m, c) => { c.plan.captionStyle.preset = "impact"; c.plan.captionStyle.enabled = true; c.plan.changes.push("Caption style: Impact"); } },
  { re: /\b(captions?|subtitles?|text)\b.*\b(top|upper)\b|\b(top|upper)\b.*\b(captions?|subtitles?)\b/, apply: (_m, c) => { c.plan.captionStyle.position = "upper"; c.plan.changes.push("Captions: top"); } },
  { re: /\b(captions?|subtitles?|text)\b.*\b(middle|cent(er|re))\b|\b(middle|cent(er|re))\b.*\b(captions?|subtitles?)\b/, apply: (_m, c) => { c.plan.captionStyle.position = "middle"; c.plan.changes.push("Captions: centre"); } },
  { re: /\b(captions?|subtitles?|text)\b.*\b(bottom|lower)\b|\b(bottom|lower)\b.*\b(captions?|subtitles?)\b/, apply: (_m, c) => { c.plan.captionStyle.position = "lower"; c.plan.changes.push("Captions: bottom"); } },
  { re: /\b(bigger|larger)\b.*\b(captions?|subtitles?|text)\b|\b(captions?|subtitles?|text)\b.*\b(bigger|larger)\b/, apply: (_m, c) => { c.plan.captionStyle.size = 1.3; c.plan.changes.push("Captions: larger"); } },
  { re: /\b(smaller)\b.*\b(captions?|subtitles?|text)\b|\b(captions?|subtitles?|text)\b.*\b(smaller)\b/, apply: (_m, c) => { c.plan.captionStyle.size = 0.8; c.plan.changes.push("Captions: smaller"); } },
  { re: /\b(gold|golden|champagne)\b.*\b(highlight|words?|captions?)\b/, apply: (_m, c) => { c.plan.captionStyle.highlight = "#E3CB98"; c.plan.changes.push("Caption highlight: gold"); } },
  { re: /\b(yellow)\b.*\b(highlight|words?|captions?)\b/, apply: (_m, c) => { c.plan.captionStyle.highlight = "#FFD84D"; c.plan.changes.push("Caption highlight: yellow"); } },
  { re: /\b(pink|rose)\b.*\b(highlight|words?|captions?)\b/, apply: (_m, c) => { c.plan.captionStyle.highlight = "#F2A7B5"; c.plan.changes.push("Caption highlight: pink"); } },
  { re: /\b(green|mint)\b.*\b(highlight|words?|captions?)\b/, apply: (_m, c) => { c.plan.captionStyle.highlight = "#9FE3C1"; c.plan.changes.push("Caption highlight: mint"); } },
  { re: /\b(blue)\b.*\b(highlight|words?|captions?)\b/, apply: (_m, c) => { c.plan.captionStyle.highlight = "#8EC5FF"; c.plan.changes.push("Caption highlight: blue"); } },
  { re: /\b(word[- ]by[- ]word|karaoke|highlight (each|the) word|animated (captions?|subtitles?|words?))\b/, apply: (_m, c) => { c.plan.captionStyle.animate = true; c.plan.changes.push("Captions: word-by-word highlight"); } },
  { re: /\b(static|no animation|don'?t animate|plain) (captions?|subtitles?)\b/, apply: (_m, c) => { c.plan.captionStyle.animate = false; c.plan.changes.push("Captions: static"); } },
  { re: /\b(short|punchy|few words|one to three words)\b.*\b(captions?|subtitles?|lines?)\b/, apply: (_m, c) => { c.plan.captionStyle.chunking = "punchy"; c.plan.changes.push("Caption length: punchy"); } },
  { re: /\b(full|long|whole) (lines?|sentences?)\b/, apply: (_m, c) => { c.plan.captionStyle.chunking = "lines"; c.plan.changes.push("Caption length: full lines"); } },

  // ---- looks ----
  { re: /\b(black and white|black & white|b ?& ?w|b\/w|monochrome|grayscale|greyscale|noir)\b/, apply: look("noir", "Noir (black & white)") },
  { re: /\b(teal and orange|teal & orange|cinematic|filmic|hollywood|movie look|dramatic)\b(?! (captions?|subtitles?))/, apply: look("cinematic", "Cinematic") },
  { re: /\b(warm|golden hour|golden|sunset|cozy|cosy)\b(?!.*\b(highlight|captions?|subtitles?)\b)/, apply: look("warm-luxe", "Warm Luxe") },
  { re: /\b(bright|clean look|airy|light and airy|fresh)\b(?!.*\b(captions?|subtitles?)\b)/, apply: look("clean-bright", "Clean Bright") },
  { re: /\b(vintage|retro|faded|film look|film fade|analog|analogue|editorial look|muted)\b/, apply: look("film-fade", "Film Fade") },
  { re: /\b(emerald|green tones?|cool and moody|moody green)\b/, apply: look("emerald", "Emerald") },
  { re: /\b(moody|dark)\b(?!.*\b(green|emerald)\b)/, apply: look("cinematic", "Cinematic (moody)") },
  { re: /\b(natural|no filter|true colou?rs?|realistic)\b/, apply: look("natural", "Natural") },
  { re: /\b(subtle|light|gentle|slight)\b.*\b(grade|look|filter|colou?r)\b/, apply: (_m, c) => { c.plan.edit.lookIntensity = 0.5; c.plan.changes.push("Grade intensity: subtle (50%)"); } },
  { re: /\b(strong|heavy|intense|stronger)\b.*\b(grade|look|filter|colou?r)\b/, apply: (_m, c) => { c.plan.edit.lookIntensity = 1; c.plan.changes.push("Grade intensity: full"); } },
  { re: /\b(no|remove|without) vignette\b/, apply: (_m, c) => { c.plan.edit.vignette = false; c.plan.changes.push("Vignette: off"); } },
  { re: /\bvignette\b/, apply: (_m, c) => { c.plan.edit.vignette = true; c.plan.changes.push("Vignette: on"); } },

  // ---- speed ----
  { re: /\b(super slow|very slow|half speed|0\.5\s*x|50 ?%)\b|\bslow[- ]?mo(tion)?\b(?!.*\b(slightly|a bit|a little)\b)/, apply: (_m, c) => { c.plan.edit.speed = 0.5; c.plan.changes.push("Speed: 0.5× slow motion"); } },
  { re: /\b(slightly|a bit|a little) slow(er|ed)?( down)?\b|\b0\.75\s*x\b|\bslightly slow[- ]?mo(tion)?\b/, apply: (_m, c) => { c.plan.edit.speed = 0.75; c.plan.changes.push("Speed: 0.75×"); } },
  { re: /\b(double speed|2\s*x|twice as fast)\b/, apply: (_m, c) => { c.plan.edit.speed = 2; c.plan.changes.push("Speed: 2×"); } },
  { re: /\b1\.5\s*x\b|\b(faster|speed (it )?up)\b(?!.*\b(slightly|a bit|a little)\b)/, apply: (_m, c) => { c.plan.edit.speed = 1.5; c.plan.changes.push("Speed: 1.5×"); } },
  { re: /\b1\.25\s*x\b|\b(slightly|a bit|a little) faster\b/, apply: (_m, c) => { c.plan.edit.speed = 1.25; c.plan.changes.push("Speed: 1.25×"); } },
  { re: /\b(normal|real[- ]?time|original) speed\b/, apply: (_m, c) => { c.plan.edit.speed = 1; c.plan.changes.push("Speed: normal"); } },
  { re: /\bsmooth\b.*\bslow|\bslow.*\bsmooth/, apply: (_m, c) => { c.plan.edit.smoothSlowMo = true; c.plan.changes.push("Smooth (motion-interpolated) slow motion"); } },

  // ---- trimming ----
  { re: new RegExp(`\\b(?:cut|trim|remove|skip|drop|delete)\\b.*\\bfirst ${TIME}`), apply: (m, c) => {
      const t = parseTime(m[1]); if (t == null) return;
      c.plan.edit.trimStart = Math.min(t, c.duration - 0.5); c.plan.changes.push(`Trim: remove the first ${t} s`); } },
  { re: new RegExp(`\\b(?:cut|trim|remove|skip|drop|delete)\\b.*\\blast ${TIME}`), apply: (m, c) => {
      const t = parseTime(m[1]); if (t == null) return;
      c.plan.edit.trimEnd = Math.max(0.5, c.duration - t); c.plan.changes.push(`Trim: remove the last ${t} s`); } },
  { re: new RegExp(`\\b(?:from|between|keep)\\b\\s*${TIME}\\s*(?:to|-|–|until|and)\\s*${TIME}`), apply: (m, c) => {
      const a = parseTime(m[1]), b = parseTime(m[2]); if (a == null || b == null || b <= a) return;
      c.plan.edit.trimStart = Math.min(a, c.duration); c.plan.edit.trimEnd = Math.min(b, c.duration); c.plan.changes.push(`Trim: keep ${a} s – ${b} s`); } },
  { re: new RegExp(`^(?!.*\\b(first|last|from|between)\\b).*\\b(?:make it|keep it|under|max(?:imum)?|at most|no longer than|shorten(?: it)? to|only|long|reel|video|clip)\\b`), apply: (_m, c) => {
      const clause = _m.input ?? "";
      const t = new RegExp(`${NUMBER}[- ]?(s|sec|secs|seconds?|mins?|minutes?)\\b`).exec(clause);
      if (!t) return;
      const secs = num(t[1]) * (/^m/.test(t[2]) ? 60 : 1);
      if (!(secs > 0)) return;
      // Output length is source length / speed.
      const speed = c.plan.edit.speed ?? c.current.speed;
      const start = c.plan.edit.trimStart ?? c.current.trimStart;
      c.plan.edit.trimEnd = Math.min(c.duration, start + secs * speed);
      c.plan.changes.push(`Length: ${secs} s`); } },

  // ---- transitions ----
  { re: /\bfade (in and out|in & out|in\/out)\b|\bfades\b/, apply: (_m, c) => { c.plan.edit.fadeIn = 0.6; c.plan.edit.fadeOut = 0.8; c.plan.changes.push("Fade in and fade out"); } },
  { re: /\bfade(s)? in\b(?! and)/, apply: (_m, c) => { c.plan.edit.fadeIn = 0.6; c.plan.changes.push("Fade in"); } },
  { re: /\bfade(s)? (out|to black)\b|\bend with a fade\b/, apply: (_m, c) => { c.plan.edit.fadeOut = 0.8; c.plan.changes.push("Fade out"); } },
  { re: /\bno fades?\b/, apply: (_m, c) => { c.plan.edit.fadeIn = 0; c.plan.edit.fadeOut = 0; c.plan.changes.push("No fades"); } },

  // ---- sound ----
  { re: /\b(mute|no sound|silent|remove (the )?(audio|sound))\b/, apply: (_m, c) => { c.plan.edit.volume = 0; c.plan.changes.push("Audio: muted"); } },
  { re: /\b(louder|boost (the )?(audio|volume|voice|sound)|turn (it )?up)\b/, apply: (_m, c) => { c.plan.edit.volume = 1.5; c.plan.edit.normalizeAudio = true; c.plan.changes.push("Audio: louder"); } },
  { re: /\b(quieter|softer|lower (the )?(audio|volume)|turn (it )?down)\b/, apply: (_m, c) => { c.plan.edit.volume = 0.6; c.plan.changes.push("Audio: quieter"); } },
  { re: /\b(normali[sz]e|balance|level|professional|clean up|even out|broadcast)\b.*\b(audio|sound|volume|voice|loudness)\b|\b(audio|sound|voice)\b.*\b(balanced|normali[sz]ed|levell?ed)\b/, apply: (_m, c) => { c.plan.edit.normalizeAudio = true; c.plan.changes.push("Audio: balanced to −14 LUFS"); } },
];

/** Words that carry no editing meaning on their own. */
const FILLER = /^(please|pls|can you|could you|i want|i'd like|i would like|make|it|the|this|video|clip|look|and|then|also|a|an|to|me|my|more|very|really|so|just|with|for|of|on|in|nice|good|great|premium|professional|instagram|personal brand(ing)?|\s)+$/;

export function interpret(text: string, current: EditSettings, duration: number): InstructionPlan {
  const plan: InstructionPlan = { edit: {}, captionStyle: {}, transcribe: false, changes: [], notUnderstood: [] };
  const ctx: Ctx = { duration, current, plan };
  const clauses = text
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .split(/(?:\.(?!\d)|[;!?\n])+|,(?!\d)|\b(?:and then|then|also|plus)\b|\band\b(?!\s+(?:out|white|orange|&|airy|moody)\b)(?=\s+(?:make|add|use|cut|trim|remove|put|turn|give|set|keep|fade|slow|speed|apply|with)\b)/)
    .map((s) => s?.trim())
    .filter(Boolean) as string[];

  for (const clause of clauses) {
    let matched = false;
    const before = plan.changes.length;
    for (const r of RULES) {
      const m = clause.match(r.re);
      if (!m) continue;
      r.apply(m, ctx);
      if (plan.changes.length > before) matched = true;
    }
    if (!matched && !FILLER.test(clause)) plan.notUnderstood.push(clause);
  }
  // Keep the last decision per setting, but list each change once.
  plan.changes = [...new Set(plan.changes)];
  return plan;
}
