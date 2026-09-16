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
- `src/main/app-protocol.ts` and the `toucan://app` origin it defines are what make the model
  loadable at all in a packaged build; see **The origin the renderer runs on** below.
- `src/main/index.ts` grants microphone audio to Toucan's own window only
  (`registerVoicePermissions`) and serves that origin (`registerAppProtocol`). The dev server sets
  the same isolation headers in `electron.vite.config.ts`.
- `src/shared/remote-voice.ts` is the phone-to-host contract: `audio/L16; rate=16000; channels=1`,
  a body bound of 180 seconds, PCM encode/decode and resampling used by both ends.
- `src/main/remote/voice-transcription.ts` is the host policy - lazy shared load, serialized
  requests, retry after a failed load, release after ten idle minutes - over an injected engine;
  `voice-engine.ts` is the Moonshine engine reading the same prepared files from disk.
- `mobile/src/MobileVoiceInput.tsx` and `voice-input.ts` are the phone control and its decisions.
  Both engines need a secure page: over plain HTTP the button is disabled with the reason, because
  no browser grants a microphone there.

## Model assets

The model is not in the installer. It is 291 MB that never changes between releases, and
shipping it made every installer and every auto-update download twice the size. An installed build
downloads it on the first dictation instead, into `<userData>/models/moonshine-medium-streaming-en/`,
and the microphone button shows the download with the host's byte counts (`downloading` state in
`voice-transcript.ts`). The pieces:

- `src/main/voice-model-store.ts` owns where the model is and the one shared download. Readiness
  is the presence of `streaming_config.json`, which is downloaded last and only ever renamed into
  place at its full size, so its presence proves the rest arrived. A failure is a status, and the
  next attempt skips the files that already landed. `voice-model-download.ts` is the real CDN and
  disk IO behind it.
- The renderer still asks for `models/moonshine-medium-streaming-en/<file>` beside its own
  `index.html`. `src/main/app-protocol.ts` decides which `toucan://app` requests those are, and the
  handler answers them from the store's directory rather than the bundle - `build.files` excludes
  the model from the package on purpose.
- `voice-model:*` IPC (`voice-model-ipc.ts`, `window.voiceModelApi`) is how the button asks for
  the model, follows its progress, and learns which files to fetch. The phone path
  (`voice-transcription.ts`) awaits the same store before loading the engine.

## The origin the renderer runs on

A packaged renderer is loaded from `toucan://app/index.html`, a scheme registered privileged
(`standard`, `secure`, `supportFetchAPI`, `corsEnabled`) before the app is ready. It is not a
detail. Loading the renderer with `loadFile()` - the obvious thing - breaks dictation in two
independent ways, and both look like a hung button rather than an error:

- **No `SharedArrayBuffer`.** Moonshine's threaded WASM build needs one, and Chromium only exposes
  it to a cross-origin-isolated page. A `file:` page has an opaque origin, which COOP/COEP cannot
  isolate however the headers are delivered - `webRequest.onHeadersReceived` included. Emscripten's
  pthread worker then throws `DataCloneError` on its first `postMessage` **inside a promise that
  never settles**, so the button sits on "Preparing local speech model…" until the 60 s stall guard
  fires.
- **No way to read the model.** `fetch` and the Cache API both reject a non-HTTP scheme outright
  (`Request scheme 'file' is unsupported`).

The scheme fixes the first. The second is only half fixed by it, because the Cache API refuses any
non-HTTP scheme including this one - so `VoiceInput` no longer uses Moonshine's `AssetDownloader`.
The host names and sizes the files (`src/main/voice-model-files.ts`), the renderer fetches them off
its own origin (`src/renderer/src/voice-model-files.ts`) and hands the bytes to
`Transcriber.load({ files })`. That also stops 291 MB from being copied into a browser cache it is
already on disk for.

Two things the handler must keep doing: stamp the isolation headers on every response
(`require-corp` means subresources opt in too, so `Cross-Origin-Resource-Policy` goes on as well),
and set `Content-Type` itself - a custom scheme has no server behind it, and Chromium refuses a
module script or a streaming WebAssembly compile on a guessed type. `tests/app-protocol.test.ts`
covers the routing and the types.

In development, `npm run dev` still runs `scripts/prepare-voice-model.mjs`, which fetches the model
into the gitignored `src/renderer/public/models/moonshine-medium-streaming-en/` so Vite serves it;
the store treats that directory as already prepared and downloads nothing. `npm run build` runs the
same hook, but `build.files` excludes `out/renderer/models/**` from the package, and the release
workflow sets `TOUCAN_SKIP_VOICE_MODEL=1` so it never fetches the model at all. The directory name
is `VOICE_MODEL_ASSET_DIRECTORY` in `src/shared/remote-voice.ts`. An older
`moonshine-small-streaming-en/` directory can be deleted.

Tests: `tests/voice-transcript.test.ts`, `tests/voice-model-store.test.ts`,
`tests/voice-model-protocol.test.ts`, `tests/remote-voice.test.ts`,
`tests/remote-voice-transcription.test.ts`, the transcribe cases in `tests/remote-server.test.ts`,
`tests/mobile-voice-input.test.ts`, `tests/mobile-voice-input.dom.test.tsx`, and the microphone
capture path in `tests/brain-dump-capture.dom.test.tsx`.
