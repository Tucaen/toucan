# Voice input prototype

> THROWAWAY PROTOTYPE on branch `codex/voice-input-prototype`.

Question: Does local, streaming voice input feel useful inside ADE's existing agent composer?

Run it with:

```powershell
npm run prototype:voice
```

Create or resume a Claude/Codex node, then select **Mic** beside the composer. The first use downloads and caches Moonshine's English Small Streaming model. Once the button changes to **Done**, speak and watch the live preview. Select **Done** to insert the transcript at the saved cursor position, or **×** to discard it. Dictation never sends the prompt automatically.

Prototype constraints:

- English only.
- Model assets come from Moonshine's CDN on first use; subsequent use is local/offline through the browser cache.
- The feature runs Moonshine WASM in the renderer and enables cross-origin isolation in the development server.
- The interaction and engine choice are deliberately not production abstractions yet.

Verdict to record after hands-on testing: latency, transcription quality, model-download friction, CPU impact, and whether live partial text is worth keeping.
