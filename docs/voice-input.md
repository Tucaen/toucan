# Voice input

Dictation in Toucan's composer, on the desktop and on the phone. This page records what runs where,
why, and how to measure it.

## Where transcription runs

| Surface                              | Engine                                                                  | Languages            |
| ------------------------------------ | ----------------------------------------------------------------------- | -------------------- |
| Desktop composer, brain-dump capture | whisper.cpp `large-v3-turbo`, a `whisper-server` child of main, offline | Auto-detected (99)   |
| Phone with a browser recognizer      | The browser's own `SpeechRecognition` (Android Chrome, iOS Safari)      | The phone's language |
| Phone without one                    | Records 16 kHz PCM, `POST /api/transcribe`, the desktop's engine        | Auto-detected (99)   |

**Decision: batch decode on Stop, no live text (#214).** The previous engine (Moonshine Medium
Streaming, WASM in the renderer) transcribed while speaking, and two failure modes were inherent to
that design rather than tuning problems: every thinking pause became a finalized line - its own
capital and terminal period - and words at pause boundaries could not be revised with right-context
once finalized ("hazard" for "has it"). Whisper decodes the whole buffered utterance in one pass,
so punctuation comes from content and a pause is just a pause. While recording, the control shows a
level meter and the elapsed time; the transcript appears on Stop, inserted at the cursor, and is
never sent on its own - a transcript is a draft.

**Decision: the engine lives in the main process, as a child process.** The 1.6 GB model load is
paid once and amortized across dictations (`voice-transcription.ts` keeps the engine resident and
releases it after ten idle minutes), and a native crash takes the helper down, not Toucan. The
server binds 127.0.0.1 on an OS-picked port and is torn down with the engine - it is not a network
surface. Both the desktop composer (over the `voice-model:transcribe` IPC) and the phone fallback
(`POST /api/transcribe`) hand the same 16 kHz mono PCM to the same transcriber.

**Decision: the phone still uses its own recognizer first.** It is free, streams interim text, and
needs nothing from the desktop; Android's is the one the keyboard uses. The host fallback covers
browsers without one, and with Whisper behind it, it is multilingual too.

Context biasing survives the engine swap: the composer hands `dictationContext` (the draft plus the
newest exchange, `src/renderer/src/voice-transcript.ts`) to Whisper as its **initial prompt**, so
identifiers, file names and product words that are already on screen are what the decoder leans
towards.

## Optional dictation cleanup

The desktop composer's **Dictation cleanup** picker is off by default. Choose **Cleanup: Haiku**
for fast polishing or **Cleanup: Sonnet** for difficult dictation. Both use your **Claude
subscription**, regardless of which provider the conversation uses, and send the raw transcript
plus the draft/newest-exchange context to Claude. The workspace remembers the choice; it also
applies to desktop brain-dump dictation. Phone dictation is unchanged.

After transcription, **Polishing…** has a **Use original dictation** button that immediately
inserts the raw text. Cleanup has a 30-second deadline. A failure or timeout inserts the original
dictation and shows the reason, while success reports the requested model as unverified. No
dictation is sent as a message automatically.

Cleanup runs a separate, hidden Claude CLI process with no tools, customizations or session
persistence. It never enters the node's ACP session, conversation history, titles or outcome
records. `dictation-cleanup.ts` owns fallback/deadlines, `claude-dictation-cleanup.ts` owns the
process, and `use-dictation-cleanup.ts` retains the raw text even if IPC stops replying. Tests fake
the process and IPC boundaries and spend no account tokens.

## Measuring accuracy on your own prompts

Published WER is read speech in a quiet room. Toucan prompts are spontaneous, technical, and often
from a non-native speaker on a laptop microphone, so measure before believing a number:

```powershell
npm run voice:wer -- <directory> --models medium,whisper
```

The directory holds pairs of `name.wav` (16-bit PCM, any rate) and `name.txt` with what was said.
`medium` is the retired Moonshine streaming model (kept as the baseline any new engine has to
beat), `whisper` is the shipped large-v3-turbo, decoded in batch exactly as the app does on Stop.
Each candidate downloads on first use into the gitignored `src/renderer/public/models/`. Whisper's
per-file time includes its model load, because the CLI pays it per run; the app loads once and
keeps the server resident.

## How the pieces fit

- `src/renderer/src/VoiceInput.tsx` owns the microphone: plain WebAudio capture into a Float32
  buffer (the same recorder shape as the phone's fallback), a level meter and elapsed timer while
  listening, and one `voiceModelApi.transcribe` call on Stop. `voice-transcript.ts` beside it holds
  the pure decisions: labels, the recording readout, meter decay, cursor insertion, the context
  passage. The renderer never sees model bytes.
- `src/shared/whisper-assets.ts` pins the engine build and the checkpoint - URL, size and SHA-256
  each. whisper.cpp is MIT; the `large-v3-turbo` checkpoint is MIT (converted to GGML by
  ggerganov/whisper.cpp on Hugging Face). The pin is what makes "downloaded" mean "reviewed": one of
  these files is an executable. `scripts/whisper-files.mjs` restates the pins for the WER harness
  (plain node cannot import TypeScript) and `tests/whisper-assets.test.ts` holds the two identical.
- `src/main/voice-model-store.ts` owns the assets on disk under `<userData>/models/whisper/`: the
  engine zip is downloaded, verified, and its pinned entries extracted into `bin/` (a marker file
  naming the build is written last, so its presence proves the binaries; a bumped pin re-downloads),
  then the checkpoint beside it (renamed into place only at full, hash-verified size). One shared
  download, progress in whole-percent steps, failures as statuses. `voice-model-download.ts` is the
  real IO; `zip-extract.ts` is the minimal reader for the one pinned archive.
- `src/main/whisper-engine.ts` spawns `whisper-server` (hidden, per the `background-process.ts`
  policy), polls `/health` until the model is loaded, and turns each recording into a multipart
  `/inference` request - `language=auto`, `temperature=0`, the dictation context as `prompt`, and
  `--suppress-nst` so silence decodes to nothing rather than a literal `[BLANK_AUDIO]`.
- `src/main/voice-transcription.ts` is the policy around it: lazy shared load bounded by
  `withStallGuard`, serialized requests, retry after a failed load, release after ten idle minutes.
- `src/main/voice-model-ipc.ts` is the renderer seam: model state/ensure plus `transcribe`, which
  re-checks the same PCM bounds the phone route enforces before decoding.
- `src/shared/remote-voice.ts` is the recording contract both surfaces share: `audio/L16; rate=16000`,
  a 180-second bound, PCM encode/decode and resampling.
- `src/main/remote/remote-server.ts` still owns `POST /api/transcribe` for the phone;
  `mobile/src/MobileVoiceInput.tsx` and `voice-input.ts` are the phone control and its decisions.
  Both engines need a secure page: over plain HTTP the button is disabled with the reason, because
  no browser grants a microphone there.

An earlier install's Moonshine model directory (`<userData>/models/moonshine-medium-streaming-en/`,
291 MB) is no longer read and can be deleted.

## The origin the renderer runs on

A packaged renderer is loaded from `toucan://app/index.html`, a scheme registered privileged
(`standard`, `secure`, `supportFetchAPI`, `corsEnabled`) before the app is ready, with cross-origin
isolation headers stamped on every response. The speech model no longer rides this origin - the
renderer records and never loads model bytes - but the scheme stays: a `file:` page has an opaque
origin that COOP/COEP can never isolate and a `fetch` that refuses the scheme outright, and going
back would re-break whatever next needs either. The handler still sets `Content-Type` itself,
because a custom scheme has no server to label a module script. `tests/app-protocol.test.ts` covers
the routing and the types.

Tests: `tests/voice-transcript.test.ts`, `tests/voice-model-store.test.ts`,
`tests/voice-transcription.test.ts`, `tests/whisper-assets.test.ts`, `tests/zip-extract.test.ts`,
`tests/remote-voice.test.ts`, the transcribe cases in `tests/remote-server.test.ts`,
`tests/mobile-voice-input.test.ts`, `tests/mobile-voice-input.dom.test.tsx`, and the microphone
capture path in `tests/brain-dump-capture.dom.test.tsx`.
