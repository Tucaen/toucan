---
title: Make voice input accurate enough to use, and add it to the mobile companion
status: done
created: 2026-09-05
updated: 2026-09-05
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

## Notes

- Main process registers media permissions and cross-origin isolation only for the voice prototype (`src/main/index.ts`); those need to stay or be replaced for whatever approach wins.
- Stall guard on model load (60 s) exists because a hung model download left the banner stuck; keep that protection.
