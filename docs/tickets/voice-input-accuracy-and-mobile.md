---
title: Make voice input accurate enough to use, and add it to the mobile companion
status: superseded
created: 2026-09-05
updated: 2026-09-21
---

## Problem

The composer's dictation (`src/renderer/src/VoiceInputPrototype.tsx`, Moonshine small streaming English model running locally in WASM) gets too much wrong to be useful: transcripts need more correction than typing the text would have cost. It is still marked as a prototype. The mobile companion (`mobile/`) has no voice input at all, even though a phone is where dictation matters most.

## Scope

Two outcomes, one ticket because they share the decision on where transcription runs.

1. **Desktop accuracy.** Decide whether to stay local with a bigger/better model or add a cloud speech service. Measure before choosing: record a handful of real Toucan prompts and compare word error rate across candidates. A cloud service is only worth adding if it is markedly better than the best local option; otherwise it is a network dependency for no gain.
2. **Mobile.** Add a microphone control to the mobile composer. If transcription stays on-device, a phone browser will not run the WASM model well, so the likely design is the phone streams audio (or uses the platform speech API where available) and the desktop or a service transcribes.

## Acceptance

- Dictating a typical two-sentence prompt on desktop produces text the user can send without editing more than a word or two.
- The mobile composer has a working microphone button with the same idle/loading/listening/error states as desktop.
- Non-English speech either works or fails with a clear message; today it silently produces garbage because the model is English-only.
- The `Prototype` naming and comments are removed once the implementation is the real one.

## Decisions

- Cloud transcription is acceptable, but only a free service, and only if it is really good. Paid services are out.
- Local dictation stays as the offline path regardless. The user usually has a connection but will not depend on it unless the cloud result is clearly better.

## Outcome (2026-09-05)

- **Desktop stays local**, on Moonshine 0.1.5 with the Medium Streaming English model (published
  LibriSpeech WER 2.17% against Small's 2.61%; ~305 MB) plus context biasing: the composer hands
  the model the draft and the newest exchange so identifiers and file names on screen are what it
  leans towards. No cloud service was added: nothing key-less and free is clearly better, and the
  Web Speech API is not available inside Electron.
- **WER on real prompts is measured with `npm run voice:wer -- <dir>`**, which compares small and
  medium on a directory of `.wav`/`.txt` pairs. Recordings of the user's own prompts are the
  input; none were available in this environment, so the model choice rests on the published
  numbers and the measurement is the next step for the user.
- **Mobile** has a microphone in the composer with the same idle/loading/listening/stopping/error
  states. It uses the browser's own recognizer in the phone's language where one exists, and
  otherwise records 16 kHz PCM and posts it to `/api/transcribe`, where the desktop transcribes
  with the same model files in the main process.
- **Non-English**: the desktop names its language (`Dictate (English)`, `Listening (English
  only)…`) instead of producing garbage; the phone path is multilingual. Moonshine's WASM catalog
  has no non-English streaming models yet, so German on the desktop stays out of reach for now.
- `VoiceInputPrototype` is `VoiceInput`; the prototype note moved to `docs/voice-input.md`.
- **Remaining before this closes:** record a handful of real prompts and run `npm run voice:wer`
  to confirm the two-sentence acceptance criterion on the medium model; the model choice so far
  rests on Moonshine's published numbers.

## Superseded (2026-09-21)

Issue [#214](https://github.com/Tucaen/ade/issues/214) replaced the whole engine decision above.
Dictation is now a batch decode of whisper.cpp `large-v3-turbo` in the main process, so the
Outcome's "Desktop stays local, on Moonshine 0.1.5" and everything resting on Moonshine's
streaming models - the context-biasing `setContext` call, the English-only wording, the WASM
model in the renderer - describe code that no longer exists. `docs/voice-input.md` is the current
account; the Moonshine models survive only as the baseline in `npm run voice:wer`.

## Notes

- Main process registers media permissions and cross-origin isolation only for the voice prototype (`src/main/index.ts`); those need to stay or be replaced for whatever approach wins.
- Stall guard on model load (60 s) exists because a hung model download left the banner stuck; keep that protection.
