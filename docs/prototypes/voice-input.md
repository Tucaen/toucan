# Experimental voice input

Status: working experimental feature. Keep the engine-specific integration isolated until the interaction and transcription quality have been evaluated further.

Question: Does local, streaming voice input feel useful inside Toucan's existing agent composer?

Run Toucan normally with:

```powershell
npm run dev
```

The command prepares Moonshine's English Small Streaming model before Toucan launches. Create or resume a Claude/Codex node, then select **Mic** beside the composer. The button briefly shows **Wait** while the local model is loaded into memory. Once it changes to **Done**, speak and watch the live preview. Select **Done** to insert the transcript at the saved cursor position, or **×** to discard it. Dictation never sends the prompt automatically. `npm run prototype:voice` remains as a descriptive alias during the experimental phase.

Prototype constraints:

- English only.
- Model assets total roughly 165 MB. Prototype setup downloads them from Moonshine's CDN before launch and stores them in the gitignored `src/renderer/public/models/moonshine-small-streaming-en/` directory. Mic clicks never download model data.
- The feature runs Moonshine WASM in the renderer. Its threaded build needs `SharedArrayBuffer`, which Chromium only exposes to a `crossOriginIsolated` page, so both the development server (`electron.vite.config.ts`) and the main process (`registerVoicePrototypeCrossOriginIsolation` in `src/main/index.ts`, for packaged builds loaded via `loadFile()`) set the required `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` headers. Without cross-origin isolation, the WASM worker dies silently on startup and the mic button hangs on "Preparing local speech model..."; `VoiceInputPrototype`'s `withStallGuard` bounds that wait so it always resolves to a listening or error state instead.
- The interaction and engine choice are deliberately not production abstractions yet.

Hands-on verdict: local capture, live partial transcription, discard, and insertion into the composer work. Preparing the model before launch removes the confusing first-mic download, and the live partial text is useful enough to retain during the experiment. Longer-session latency, transcription quality across speakers, and CPU impact still need broader evaluation before treating the feature as production-ready.
