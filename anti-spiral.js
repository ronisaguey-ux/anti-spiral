// anti-spiral.js — opencode plugin: catches genuine reasoning loops and stops them.
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
