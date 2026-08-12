# Voice input prototype

> THROWAWAY PROTOTYPE on branch `codex/voice-input-prototype`.

Question: Does local, streaming voice input feel useful inside ADE's existing agent composer?

Run it with:

```powershell
npm run prototype:voice
```

The command prepares Moonshine's English Small Streaming model before ADE launches. Create or resume a Claude/Codex node, then select **Mic** beside the composer. The button briefly shows **Wait** while the local model is loaded into memory. Once it changes to **Done**, speak and watch the live preview. Select **Done** to insert the transcript at the saved cursor position, or **×** to discard it. Dictation never sends the prompt automatically.

Prototype constraints:

- English only.
- Model assets total roughly 165 MB. Prototype setup downloads them from Moonshine's CDN before launch and stores them in the gitignored `src/renderer/public/models/moonshine-small-streaming-en/` directory. Mic clicks never download model data.
- The feature runs Moonshine WASM in the renderer and enables cross-origin isolation in the development server.
- The interaction and engine choice are deliberately not production abstractions yet.

Verdict to record after hands-on testing: latency, transcription quality, setup friction, CPU impact, and whether live partial text is worth keeping.
