// anti-spiral — opencode plugin: catches genuine reasoning loops and stops them.
//
// v4. What v3 got wrong, measured on a real 15-minute spiral (09-14, 34,576 chars,
// reasoning tics "Let me act." x176 / "OK." x163 / "Let me make the call." x133):
//
//   1. THE TOOL-CALL SPIRAL WAS IMMUNE. The turn hook reset the escalation counter
//      whenever the turn contained a tool call, so a spiral that kept *making* calls
//      ("Let me act." + one Read, 20 seconds apart) zeroed its own counter forever.
//      It was detected 18 times in 15 minutes and never escalated past a redirect.
//      FIX: a separate `toolLoops` counter (a clean tool turn still resets).
//   2. LAYER 1 COULD NOT FIRE AT ALL. Replaying the real spiral through the detector
//      shows the mid-stream check trips at 3,600 chars (10% in) — yet the live journal
//      has ZERO "MID-STREAM CUT" lines, because layer 1 gated every part behind a role
//      map fed by `message.updated`, and a part whose role was never seen was silently
//      skipped. FIX: a reasoning part is assistant by construction (only assistants
//      emit reasoning), so it is judged directly; for text parts an unknown role must
//      first show real stream growth, which a static user message can never do.
//   3. EVERY DETECTION WAS FORGETTABLE. Resetting counters is what let 18 detections
//      pass for silence. FIX: a rate trip — RATE_LIMIT detections inside RATE_WINDOW_MS
//      halts the session regardless of what the counters were reset to. Hits are never
//      cleared by hand; the rolling window is the only thing that forgets, because one
//      clean turn between two loops is precisely the pattern that survived v3.
//   4. SHORT LOOPING TURNS WERE INVISIBLE. `MIN_WORDS = 40` returned early, so a
//      three-line "Let me act." turn (9 words, 100% repetition) scored null. FIX:
//      a short-text path that judges repeated n-grams by coverage, not by length.
//
// v4 measured (test/run.mjs): 3 consecutive looping turns -> HALT on the third; 5
// detections in 5 minutes -> HALT even with every counter reset between them; 20
// clean tool-call turns -> 0 detections; the real 34,576-char spiral -> HALT on
// turn 4, 17% in, about a minute of wall clock instead of fifteen.
//
// v3. Two independent layers, because v2 had one and it missed a 26,000-character
// "Let me go. / Let me read." spiral in a single DeepSeek reasoning stream:
//
//   LAYER 1 — MID-STREAM KILL SWITCH (the `event` hook)
//     Every streamed reasoning/text delta of an ASSISTANT message is watched. When
//     the tail of the stream is dominated by a repeated unit, the session is aborted
//     right there (client.session.abort) and a redirect is sent as the next user
//     message. A spiral is cut at a few hundred characters instead of running to the
//     provider's output-token limit. v2 only had the transform hook, which runs
//     *before the next request* — it cannot touch a generation already in flight.
//
//   LAYER 2 — TURN REVIEW (the `experimental.chat.messages.transform` hook)
//     Before each request the previous assistant turn is judged. A loop injects a
//     redirect with the evidence; three consecutive looping turns without a tool call
//     escalate to a halt. v2 skipped this entirely when the turn contained a tool
//     call, so a reasoning stream that looped 20x and then emitted one Read counted
//     as "progress" — and grew, turn by turn, into the 1006x spiral. Now a tool call
//     still resets the ESCALATION, but a loop is still reported.
//
// WHAT A REAL LOOP IS: the same substantial unit — a sentence, a phrase, a line —
// repeated enough that the repetition DOMINATES a window of text. Ordinary prose
// reuses short phrases; that is not a loop. Five signatures are checked:
//   1. Same sentence (>30 chars) twice in a row.
//   2. Same prose line (>= 6 words) three or more times.
//   3. N-gram dominance over the whole message (n = 3..8, >= 3x, coverage threshold).
//   4. The stall tic: a line of <= 4 words ("Let me go.", "(Run.)", "OK.") standing on
//      its own >= 4 times. Every real spiral examined started this way.
//   5. TAIL dominance: the last ~150 words are >= 60% one repeated n-gram (n = 2..10,
//      >= 4x), or the last 12 lines are short and have <= 4 distinct values. This is
//      the live-spiral signature — the message may be long and mostly fine, and the
//      loop is what it has degenerated into at the end. v2 dropped this check and
//      a 1,000-word reasoning that ended in 20 "Let me read / Let me go" lines
//      scored 16% coverage: invisible.
//
// Code, logs, tables and tool output are stripped before measuring, because those
// repeat lines for legitimate reasons.
//
// Session identity comes from the messages themselves (info.sessionID): the transform
// hook's input is `{}` in opencode 1.18, so v2's `hookInput.session.id` was always
// undefined and every session shared one counter named "default".
//
// A turn is counted at most once (by assistant message id). State is per session,
// pruned after 30 idle days.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import os from "node:os"

// ── public shapes ──────────────────────────────────────────────────────────

/** The kind of repetition a check found. */
export type SpiralKind = "sentence" | "line" | "tic" | "phrase" | "tail" | "short"

/** Evidence for one detection; `coverage` is the share of the judged text it occupies. */
export interface SpiralEvidence {
  kind: SpiralKind
  phrase: string
  count: number
  coverage?: number
}

/** One assistant/tool/text part as opencode hands it to a plugin. */
export interface MessagePart {
  id?: string
  messageID?: string
  sessionID?: string
  type?: string
  text?: string
  thinking?: string
  reasoning?: string
  content?: string
  tool?: string
  state?: unknown
  synthetic?: boolean
  ignored?: boolean
  time?: { start?: number; end?: number }
}

/** Message metadata; only the fields this detector reads. */
export interface MessageInfo {
  id?: string
  role?: string
  sessionID?: string
  agent?: string
  model?: { providerID: string; modelID: string }
  time?: { created?: number; start?: number; end?: number }
}

/** One message in the transform hook's `output.messages`. */
export interface ChatMessage {
  info?: MessageInfo
  parts?: MessagePart[]
}

/** Input of the transform hook. `{}` in opencode 1.18, so it is never read. */
export interface TransformOutput {
  messages?: ChatMessage[]
}

/** The `event` hook's payload. */
export interface PluginEvent {
  type?: string
  properties?: {
    info?: MessageInfo
    part?: MessagePart
    delta?: string
  }
}

/** Stored counters for one session. */
export interface SessionRow {
  loops: number
  aborts: number
  toolLoops: number
  hits: number[]
  lastMsg?: string
  t: number
}

/** The whole state file. */
export interface PluginState {
  v?: number
  sessions: Record<string, SessionRow>
}

/** The subset of the opencode client this plugin calls. */
export interface PluginClient {
  session: {
    abort(args: { path: { id: string } }): Promise<unknown>
    prompt(args: { path: { id: string }; body: { parts: Array<{ type: string; text: string }> } }): Promise<unknown>
  }
  tui?: {
    showToast(args: {
      body: { title: string; variant: string; duration: number; message: string }
    }): Promise<unknown>
  }
}

/** What the plugin factory is given. */
export interface PluginInput {
  client?: PluginClient
}

/** The hooks opencode calls. */
export interface AntiSpiralPlugin {
  event(input: { event?: PluginEvent }): Promise<void>
  "experimental.chat.messages.transform"(hookInput: unknown, output: TransformOutput): Promise<void>
}

/** What layer 1 actually saw, logged every 200 parts. */
interface StreamDiag {
  seen: number
  finished: number
  reasoning: number
  text: number
  roleKnown: number
  roleUnknown: number
  user: number
  judged: number
  cuts: number
}

/** The last assistant turn: all of its reasoning/text, and whether it called a tool. */
interface TurnSummary {
  text: string
  usedTool: boolean
  msgID: string
}

/** Result of counting one n-gram size. */
interface NgramResult {
  best: string | null
  count: number
  coverage: number
}

const VERSION = "v4"
const STATE_DIR =
  process.env.ANTI_SPIRAL_STATE_DIR ||
  path.join(os.homedir(), ".local", "share", "opencode", "anti-spiral")
const STATE_FILE = path.join(STATE_DIR, "state.json")
const STATE_VERSION = 4 // bump invalidates counters written by an older detector
const FREEZE_AFTER = 3
const MIN_WORDS = 40
const MIN_SHORT_WORDS = 8 // below MIN_WORDS but still judgeable (short looping turn)

// Rate trip: the escape hatch a counter-reset spiral used to walk through. 18
// detections in 15 minutes stayed a redirect because each one reset a counter;
// five inside five minutes halts no matter what the counters say.
const RATE_WINDOW_MS = 5 * 60 * 1000
const RATE_LIMIT = 5

// Mid-stream: don't judge a stream before it has this much text, then re-check
// every STREAM_STEP characters of growth (cheap: the check is O(tail)).
const STREAM_MIN_CHARS = Number(process.env.ANTI_SPIRAL_STREAM_MIN_CHARS) || 400
const STREAM_STEP = 200
const TAIL_WORDS = 150
const TAIL_LINES = 12

// ── prose extraction ───────────────────────────────────────────────────────

function stripNonProse(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "\n")            // fenced code blocks
    .replace(/~~~[\s\S]*?~~~/g, "\n")            // alt fenced blocks
    .replace(/`[^`\n]*`/g, " ")                  // inline code
    .replace(/^\s*\|.*\|\s*$/gm, "\n")           // markdown table rows
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?=\S)/gm, "") // list bullets (keep the text)
    .replace(/^\s*[>#]+\s?/gm, "")               // quote / heading markers
}

// A stream in flight may have an open code fence with no closing one yet; drop
// everything from that fence so a log being quoted is not judged as prose.
function stripStreaming(text: string): string {
  const fences = (text.match(/```/g) || []).length
  if (fences % 2 === 1) text = text.slice(0, text.lastIndexOf("```"))
  return stripNonProse(text)
}

function isProseLine(line: string): boolean {
  if (!line) return false
  const words = line.split(/\s+/).filter(Boolean)
  if (words.length < 6) return false
  const symbolish = (line.match(/[{}()[\];=<>|\\/_$@#*`~^]/g) || []).length
  if (symbolish / line.length > 0.18) return false
  const letters = (line.match(/[A-Za-z]/g) || []).length
  return letters / line.length > 0.55
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean)
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean)
}

// ── detection ──────────────────────────────────────────────────────────────

// Max occurrences of any n-gram over `words`, and the share of `words` covered.
function ngramCoverage(words: string[], n: number): NgramResult {
  if (words.length < n * 3) return { best: null, count: 0, coverage: 0 }
  const counts = new Map<string, number>()
  let best: string | null = null
  let bestCount = 0
  for (let i = 0; i <= words.length - n; i++) {
    const g = words.slice(i, i + n).join(" ")
    const c = (counts.get(g) || 0) + 1
    counts.set(g, c)
    if (c > bestCount) { bestCount = c; best = g }
  }
  return { best, count: bestCount, coverage: (bestCount * n) / words.length }
}

// The stall tic: a short line ("Let me go.", "(Run.)", "OK.") standing on its own,
// over and over. In every real spiral examined it was the first symptom — a
// reasoning stream that was otherwise varied, punctuated by "Let me go." between
// every thought, before it collapsed into pure repetition. Nothing legitimate
// repeats a four-word line `minCount` times.
function detectTic(lines: string[], minCount: number): SpiralEvidence | null {
  const counts = new Map<string, number>()
  let best: SpiralEvidence | null = null
  for (const raw of lines) {
    // Labels ("old:", "user: ..."), transcript prefixes and lines where inline code
    // was stripped out (they leave a double space) are structure, not narration.
    if (/:\s*$/.test(raw) || /^(user|assistant|system|old|new|before|after)\s*:/i.test(raw)) continue
    if (raw.includes("  ")) continue
    if (!/[.!?)]$/.test(raw)) continue // a tic is a sentence-shaped line
    const key = raw.toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim().replace(/\s+/g, " ")
    const words = key.split(" ").filter(Boolean)
    if (words.length === 0 || words.length > 4) continue
    if (words.some(w => /\d/.test(w))) continue // "step 3", "line 42": numbered, not a tic
    // "Let me ..." is THE narration tic and is held to the base threshold; any other
    // short line ("Hmm.", "OK.", "Done.") needs two more repeats to count.
    const need = key.startsWith("let me") ? minCount : minCount + 2
    const c = (counts.get(key) || 0) + 1
    counts.set(key, c)
    if (c >= need && (!best || c > best.count)) best = { kind: "tic", phrase: raw.trim().slice(0, 60), count: c }
  }
  return best
}

