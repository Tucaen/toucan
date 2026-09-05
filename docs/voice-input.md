# Voice input

Dictation in Toucan's composer, on the desktop and on the phone. This page records what runs where,
why, and how to measure it.

## Where transcription runs

| Surface                              | Engine                                                                 | Languages                   |
| ------------------------------------ | ---------------------------------------------------------------------- | --------------------------- |
| Desktop composer, brain-dump capture | Moonshine **Medium Streaming English**, WASM in the renderer, offline  | English only, and says so   |
| Phone with a browser recognizer      | The browser's own `SpeechRecognition` (Android Chrome, iOS Safari)     | The phone's language        |
| Phone without one                    | Records 16 kHz PCM, `POST /api/transcribe`, the desktop's model in main | English only                |

**Decision: stay local on the desktop.** The ticket allowed a cloud service if it was free and
clearly better. There is no key-less free service of that quality: Chromium's Web Speech API is not
wired up inside Electron, and the hosted APIs are metered behind account keys, which the ticket
ruled out. What did move the needle within Moonshine's own catalog:

- **Medium Streaming instead of Small Streaming.** Moonshine's published LibriSpeech WER is 2.17%
  for Medium against 2.61% for Small (Tiny: 4.83%). The model is roughly 305 MB instead of 165 MB.
- **Context biasing.** Moonshine 0.1.5 added `setContext`/`setKeyterms`, which bias the decoder
  towards terms in a passage. The composer hands it the current draft and the newest exchange
  (`dictationContext` in `voice-transcript.ts`), so identifiers, file names and product words that
  are already on screen are what the model leans towards. That is the class of word a general
  English model gets wrong in a Toucan prompt.

**Decision: the phone uses its own recognizer first.** It is free, multilingual and needs nothing
from the desktop; Android's is the one the keyboard uses. The host fallback exists for browsers
without one and keeps the design the ticket sketched (phone streams audio, desktop transcribes)
without a second model download on a phone.

## Non-English speech

Moonshine's WASM catalog ships English models only. Its documentation lists German, Spanish and
other streaming models, but the 0.1.5 WASM build does not know them and the CDN paths are not
public, so they cannot be loaded today. Rather than let German come out as plausible English
nonsense, the desktop control names its language up front: the button is **Dictate (English)** and
the live preview reads **Listening (English only)…** until words arrive. Other languages are the
phone's path, where the recognizer follows `navigator.language`.

When Moonshine publishes non-English streaming models to the WASM catalog, `VOICE_MODEL_LANGUAGE`
in `src/shared/remote-voice.ts` and the prepare script are the two places to change.

## Measuring accuracy on your own prompts

Published WER is read speech in a quiet room. Toucan prompts are spontaneous, technical, and often
from a non-native speaker on a laptop microphone, so measure before believing a number:

```powershell
npm run voice:wer -- <directory> --models small,medium
```

The directory holds pairs of `name.wav` (16-bit PCM, any rate) and `name.txt` with what was said.
The harness downloads each requested model into `src/renderer/public/models/`, transcribes every
recording, and prints per-file and overall WER plus decode speed. Record a handful of real prompts
you would type into a Claude or Codex node; that is the set any future engine has to beat.

## How the pieces fit

- `src/renderer/src/VoiceInput.tsx` owns the microphone and the WASM model. `voice-transcript.ts`
  beside it holds the pure decisions: transcript assembly, cursor insertion, labels, the context
  passage. `withStallGuard` bounds model load and start (60 s) so a WASM worker that dies on startup
  leaves an error, not a spinner.
- `src/main/index.ts` grants microphone audio to Toucan's own window only, and sets the
  cross-origin isolation headers a packaged build needs for Moonshine's threaded WASM
  (`registerVoicePermissions`, `registerVoiceCrossOriginIsolation`). The dev server sets the same
  headers in `electron.vite.config.ts`.
- `src/shared/remote-voice.ts` is the phone-to-host contract: `audio/L16; rate=16000; channels=1`,
  a body bound of 180 seconds, PCM encode/decode and resampling used by both ends.
- `src/main/remote/voice-transcription.ts` is the host policy - lazy shared load, serialized
  requests, retry after a failed load, release after ten idle minutes - over an injected engine;
  `voice-engine.ts` is the Moonshine engine reading the same prepared files from disk.
- `mobile/src/MobileVoiceInput.tsx` and `voice-input.ts` are the phone control and its decisions.
  Both engines need a secure page: over plain HTTP the button is disabled with the reason, because
  no browser grants a microphone there.

## Model assets

`npm run dev` and `npm run build` run `scripts/prepare-voice-model.mjs`, which fetches Medium
Streaming English into the gitignored `src/renderer/public/models/moonshine-medium-streaming-en/`.
`npm run check:voice-model` verifies it. The directory name is `VOICE_MODEL_ASSET_DIRECTORY` in
`src/shared/remote-voice.ts`; the renderer loads it over its own origin and main reads it from disk
(`src/renderer/public` in development, `out/renderer` in a packaged build). An older
`moonshine-small-streaming-en/` directory can be deleted.

Tests: `tests/voice-transcript.test.ts`, `tests/remote-voice.test.ts`,
`tests/remote-voice-transcription.test.ts`, the transcribe cases in `tests/remote-server.test.ts`,
`tests/mobile-voice-input.test.ts`, `tests/mobile-voice-input.dom.test.tsx`, and the microphone
capture path in `tests/brain-dump-capture.dom.test.tsx`.
