# Local voice input for ADE

Research date: 2026-08-12

## Executive answer

Supporting **voice input inside ADE's chat composer is a small-to-medium feature**, not a fundamental architectural change. ADE already has one provider-neutral composer (`src/renderer/src/ChatNode.tsx`) and a narrow Electron preload/main-process boundary. The smallest useful behavior is therefore: press a microphone button, speak, stop, review the transcript in the existing draft, then press Send. Voice should not auto-submit prompts.

Reasonable effort ranges:

- **Technical spike:** 1–3 engineering days for push-to-talk, local transcription, and inserting the final text into the composer on one development machine.
- **Release-quality Windows feature:** roughly 1–2 weeks for permissions, model download/caching, packaged-build support, cancellation, microphone errors, CPU-load testing, license notices, and tests.
- **A Wispr Flow-level experience:** 3–6+ weeks. The recognition engine is only part of that product; live partial text, endpoint detection, filler removal, punctuation/formatting, custom vocabulary, global hotkeys, pasting into arbitrary applications, device selection, history, and a highly polished low-latency overlay are separate work.

This estimate is for **dictating into ADE itself**. System-wide dictation into other Windows applications is materially harder and is not needed for the proposed feature.

## Recommendation

Use a small engine-neutral `VoiceTranscriber` boundary and run a short bake-off with two implementations:

1. **Moonshine WASM for the fastest streaming prototype**, especially if the first version can be English-only. Its JavaScript package exposes a `MicTranscriber`, in-progress text callbacks, completed-line callbacks, and true streaming models; it runs locally and officially supports Windows. The code and English STT models are MIT licensed. The important catch is that non-English Moonshine models use a restrictive community license, so this is not a clean multilingual default. [Moonshine README and JavaScript API](https://github.com/moonshine-ai/moonshine#javascript), [streaming event flow](https://github.com/moonshine-ai/moonshine#transcription-event-flow), [license](https://github.com/moonshine-ai/moonshine#license)
2. **`whisper.cpp` as the conservative multilingual production candidate.** It is dependency-light C/C++, runs fully offline on Windows, supports CPU, CUDA, Vulkan, OpenVINO, quantization, VAD, and a C API. It is MIT licensed. Official OpenAI Whisper checkpoints cover 99 languages and use permissive licenses, although the exact license varies by distribution/checkpoint (for example, the official Hugging Face base card says Apache-2.0 while large-v3-turbo says MIT). Pinning the exact model source is therefore part of the implementation. [whisper.cpp README](https://github.com/ggml-org/whisper.cpp), [whisper.cpp license](https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE), [official Whisper base model card](https://huggingface.co/openai/whisper-base), [official large-v3-turbo model card](https://huggingface.co/openai/whisper-large-v3-turbo)

For the first shipped version, prefer **push-to-talk or tap-to-record with final transcription**, not continuous always-on listening. It is easier to make predictable, cheaper on CPU, and clearer from a privacy perspective. Add live partial text only after measuring whether it materially improves the experience.

## Why ADE is a favorable integration target

- `ChatNode.tsx` has one controlled `<textarea>` draft and one `setDraft` path. A transcript can be appended at the cursor/draft level without touching ACP or provider code.
- Electron/Chromium already supplies microphone capture through `navigator.mediaDevices.getUserMedia`; Electron exposes explicit media permission handling in `session`. [Electron session permissions](https://www.electronjs.org/docs/latest/api/session), [MediaDevices microphone capture](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- ADE's context-isolated preload API is already the correct place to expose a narrow transcription service if inference runs in the main process or a child process.
- The current Windows package includes only `out/**/*`. A native engine or separately shipped model would therefore need an `extraResources`/unpacked-resource rule and runtime path resolution; a renderer WASM package avoids most native-binary mechanics but still needs packaged-asset and first-run download testing.
- ADE is Electron 42/React/TypeScript. As a direct proof that this stack works, the MIT-licensed OpenWhispr application uses Electron 41, React/TypeScript, `whisper.cpp`, and `sherpa-onnx`, publishes a Windows executable, and downloads the native engines as build resources. It is a useful architecture/reference implementation, not a library that ADE should import wholesale. [OpenWhispr README](https://github.com/OpenWhispr/openwhispr), [OpenWhispr build scripts](https://github.com/OpenWhispr/openwhispr/blob/main/package.json), [OpenWhispr license](https://github.com/OpenWhispr/openwhispr/blob/main/LICENSE)

## Candidate comparison

| Candidate | Windows/local | Streaming | Runtime and footprint | Languages | License and bundling | Fit for ADE |
|---|---|---|---|---|---|---|
| **Moonshine Voice / `@moonshine-ai/moonshine-wasm`** | Official Windows, C/C++ and JavaScript/WASM paths; on-device | **Native streaming** with partial and completed-line events, default 500 ms update interval | CPU-oriented ONNX runtime; published tiny through medium streaming architectures; first load may download hundreds of MB depending on model | STT currently English, Spanish, Mandarin, Japanese, Korean, Vietnamese, Ukrainian, Arabic | Code + **English models MIT**. Other-language models use Moonshine Community License: registration/attribution conditions and revenue restrictions apply. Do not bundle those without an explicit product/license review. | **Best fast spike**, especially English-only. Lowest impedance for the renderer. Multilingual license is the blocker. |
| **`whisper.cpp`** | Official MSVC/MinGW Windows; fully offline; C API | Has a microphone example described as a naive real-time loop, but Whisper itself is a 30-second-window model; "streaming" is rolling/chunked re-inference rather than a native streaming decoder | CPU-only works; CUDA, Vulkan, OpenVINO and quantization available. Official GGML sizes: tiny 75 MiB/~273 MB RAM, base 142 MiB/~388 MB, small 466 MiB/~852 MB, medium 1.5 GiB/~2.1 GB | Whisper multilingual checkpoints cover 99 languages; `.en` variants are English-only | Engine MIT; exact model license depends on the pinned source/checkpoint (official base: Apache-2.0; official large-v3-turbo: MIT). Bundling is feasible with the applicable notices; converted/quantized weights should retain model provenance. | **Best conservative production choice** for multilingual ADE. Use a packaged sidecar or a maintained native binding. Slightly more build/distribution work than WASM. |
| **faster-whisper + CTranslate2** | Windows x86-64 Python wheels; offline | Segment generator, batching and VAD, but not a true incremental microphone decoder by itself | Excellent CPU INT8 and NVIDIA CUDA performance. Python 3.9+; GPU currently requires compatible CUDA/cuDNN libraries. Official benchmark shows small-model CPU INT8 using ~1.5 GB RAM on an i7-12700K | Same Whisper family; multilingual | Both faster-whisper and CTranslate2 are MIT; retain the exact selected/converted model's license and provenance | **Excellent benchmark/prototype engine**, but embedding Python, packages, model conversion, and CUDA DLLs in ADE's portable `.exe` makes release packaging heavier. Prefer only if measured accuracy/latency beats the native/WASM options enough to justify a Python sidecar. |
| **sherpa-onnx** | Official Windows x64/arm64, NodeJS, JavaScript, C/C++, Rust, WASM; fully local | **True streaming and non-streaming** APIs, VAD and punctuation support | ONNX Runtime; CPU-first with several optional accelerators; official precompiled Windows libraries | Very broad catalog, but usually one model per language/model family rather than one universal checkpoint. NVIDIA Parakeet TDT 0.6B v3 is a notable 25-European-language option with German, punctuation/capitalization, and CC-BY-4.0 terms. | Framework Apache-2.0. **Model licensing is separate and varies by model/source**; audit the exact selected weights and tokenizer/data files before redistribution. | Strong engine framework and a good second production option, particularly for true streaming. More model-selection and compliance work than Whisper. |
| **Vosk** | Offline; official Node, C#, C++, Java, Python and other bindings | **Continuous low-latency streaming** | Small models are typically ~50 MB and ~300 MB RAM; large models can need up to 16 GB | 20+ languages/dialects, with separate language models | API Apache-2.0. Model licenses vary; many official English/German models are Apache-2.0, while others are AGPL/LGPL/CC-NC. Audit per model. | Best when tiny footprint, streaming, or vocabulary control matters more than modern free-form dictation quality. Punctuation/case restoration is separate and official punctuation models are around 1.1–1.6 GB. |
| **`whisper-rs`** | Windows build instructions; wraps `whisper.cpp` | Same characteristics as `whisper.cpp` | Exposes CUDA/Vulkan/OpenBLAS feature flags | Same Whisper models | Wrapper is Unlicense/public-domain; underlying `whisper.cpp` is MIT and weights keep their own license | No direct advantage in ADE's TypeScript/Electron stack unless ADE deliberately adds a Rust helper. Also note the project has moved from GitHub to Codeberg. |

Primary sources for the table: [Moonshine platforms/API/benchmarks](https://github.com/moonshine-ai/moonshine), [`whisper.cpp` platforms, accelerators, model memory](https://github.com/ggml-org/whisper.cpp), [`whisper.cpp` real-time example](https://github.com/ggml-org/whisper.cpp#real-time-audio-input-example), [faster-whisper requirements and benchmarks](https://github.com/SYSTRAN/faster-whisper), [CTranslate2 Windows/GPU installation](https://opennmt.net/CTranslate2/installation.html), [sherpa-onnx platforms and APIs](https://github.com/k2-fsa/sherpa-onnx), [sherpa-onnx local operation](https://k2-fsa.github.io/sherpa/onnx/), [NVIDIA Parakeet v3 model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), [Vosk API capabilities](https://github.com/alphacep/vosk-api), [Vosk model sizes/licenses](https://alphacephei.com/vosk/models), [`whisper-rs` README/license](https://github.com/tazz4843/whisper-rs).

## Mobile portability

| Candidate | iOS | Android | Browser/WASM | Practical qualification |
|---|---|---|---|---|
| **Moonshine Voice** | Native Swift package/XCFramework and microphone example | Published Maven artifact and Android Studio microphone example | Official `@moonshine-ai/moonshine-wasm` package and web dictation example | Closest to a turnkey cross-platform SDK and the strongest English streaming option. Official benchmarks include recent Pixel and iPad hardware, but lower-end devices still need testing. Code and English models are MIT; non-English models retain the restrictive Community License, and German is not currently offered. |
| **`whisper.cpp`** | Buildable Objective-C and SwiftUI examples; the XCFramework and model must be built/added manually | Buildable C++ and Java sample apps; models are added to app assets manually | Official SIMD WASM microphone/demo builds | Broad multilingual option, but these are integration examples rather than a packaged mobile SDK. Official guidance favors tiny/base on Android and tiny/base/small on iOS. The WASM README reports limited desktop-browser performance and model/audio constraints, so browser support should not be treated as mobile-qualified without a device spike. Engine is MIT; pin and audit the exact model license separately. |
| **sherpa-onnx** | Native arm64 support with Swift/iOS examples | Native arm32/arm64/x86/x64 support and Android examples | Official WASM support and demos | Widest engine/platform surface and supports true streaming, but it is a framework plus model catalog rather than one turnkey recognizer. CPU is the portable baseline; accelerator support is build/device/model dependent. Choose a small or int8 mobile model and audit its separate license. The ~0.6B-parameter Parakeet v3 option is attractive for European languages but too heavy to assume as a phone default without benchmarking. |
| **faster-whisper / CTranslate2** | No official iOS package or supported wheel | No official Android package or supported wheel | No official browser/WASM distribution | Official binaries target desktop/server Python platforms. It may be technically portable with custom native work, but it is not a sensible mobile foundation for ADE. |
| **OpenWhispr** | None | None | None | Officially a macOS/Windows/Linux Electron desktop app. Use it as a desktop dictation UX/architecture reference, not as reusable mobile support. |

For a future native ADE mobile client, keep `VoiceTranscriber` engine-neutral. **Moonshine is the shortest native iOS/Android route for English**, while **`whisper.cpp` is the safer permissive multilingual route, including German**, at the cost of more platform integration and chunked rather than native streaming. **sherpa-onnx is the strongest alternative when true streaming and model choice justify a larger evaluation effort.** Browser/WASM is useful for a PWA experiment, but mobile microphone lifecycle, memory, latency, and Safari/Chrome behavior need real-device validation; it is not equivalent to native background-capable dictation.

Primary mobile sources: [`whisper.cpp` Android example](https://github.com/ggml-org/whisper.cpp/tree/master/examples/whisper.android), [`whisper.cpp` SwiftUI example](https://github.com/ggml-org/whisper.cpp/tree/master/examples/whisper.swiftui), [`whisper.cpp` WASM examples](https://github.com/ggml-org/whisper.cpp/tree/master/examples/whisper.wasm), [Moonshine native and web quickstarts](https://github.com/moonshine-ai/moonshine), [Moonshine Swift package](https://github.com/moonshine-ai/moonshine-swift), [sherpa-onnx platform matrix and APIs](https://github.com/k2-fsa/sherpa-onnx), [CTranslate2 installation targets](https://opennmt.net/CTranslate2/installation.html), [OpenWhispr supported desktop platforms](https://github.com/OpenWhispr/openwhispr).

## Wispr Flow-like open-source layers

There are complete free/open-source dictation applications, but they are better treated as references than libraries:

- **OpenWhispr** is MIT, cross-platform, and closest to a feature-rich Wispr Flow-style product. It supports a global hotkey, automatic paste, local Whisper/Parakeet, optional cleanup, and Windows. Its Electron implementation is particularly relevant to ADE. [Repository](https://github.com/OpenWhispr/openwhispr)
- **Handy** is MIT, offline, Windows/macOS/Linux, and intentionally simple/forkable. It uses React/TypeScript plus a Rust/Tauri backend with local Whisper/Parakeet, Silero VAD, push-to-talk, audio capture, and global shortcuts. Its component choices and UX are useful references, but its Rust/Tauri core cannot be dropped directly into Electron. The project also documents configuration-dependent Whisper crashes on some Windows/Linux systems, reinforcing the need for an ADE hardware bake-off. [Repository and architecture](https://github.com/cjpais/Handy)
- **WhisperWriter** is a small Python reference implementation with continuous, VAD, toggle, and hold-to-record modes and faster-whisper. It demonstrates the UX cheaply, but its Python runtime has the same packaging downside as using faster-whisper directly. [Repository](https://github.com/savbell/whisper-writer)

These projects confirm that a free local alternative exists. There is not one universally accepted, polished "Wispr Flow SDK" to embed; the reusable part is generally an ASR engine, while ADE owns the microphone and composer experience.

## Suggested ADE design

Define a renderer-facing contract before choosing the engine:

```ts
interface VoiceTranscriber {
  prepare(options: { language: string; model: string }): Promise<void>
  start(): Promise<void>
  onPartial(listener: (text: string) => void): () => void
  stop(): Promise<{ text: string }>
  cancel(): Promise<void>
}
```

Then implement the feature in slices:

1. Add a microphone button to the composer. Tap/hold starts recording; stopping produces final text in the draft. Preserve existing text and selection, and never auto-send.
2. Request microphone access only from a user gesture. Add a restrictive Electron permission request/check handler that grants audio media only to ADE's main frame; Electron's security guide notes that unhandled permission behavior is overly permissive. [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
3. Keep audio local and in memory where practical. Show an explicit recording state, duration, cancel control, and error for no device/denied permission.
4. Run inference off the UI thread. Moonshine WASM should use its worker/WASM path; `whisper.cpp` should run as a long-lived child/helper process so model loading is amortized and a crash does not take down ADE.
5. Download models on demand to `app.getPath('userData')/models`, with a pinned version, checksum, source URL, license/provenance file, progress UI, and delete/re-download control. Bundling `base` directly adds about 142 MiB before installer compression; on-demand download keeps ADE's portable binary smaller. Offer a fully offline distribution later if needed.
6. Begin with `base`/`base.en` or a comparable quantized model and measure on representative Windows hardware. Do not default to a large model without latency and memory data.
7. Test English and German dictation, code identifiers, punctuation, background noise, a missing/denied microphone, repeated start/stop, cancellation during inference, model corruption, and packaged portable builds.

## Distribution and licensing checklist

- Track **engine license and model license separately**. An MIT/Apache runtime does not make arbitrary weights redistributable.
- For `whisper.cpp`, include its MIT notice plus the exact selected checkpoint's license/provenance. Official checkpoint metadata is not uniform (base is Apache-2.0; large-v3-turbo is MIT), so do not infer the weight license from the engine.
- For Moonshine, the English model is the clean option. Treat every non-English model as restricted unless ADE deliberately accepts the Community License conditions.
- For sherpa-onnx and Vosk, approve a specific model artifact, not merely the framework. Their catalogs contain weights under different terms.
- Include third-party notices and checksums in the packaged app or the model cache. If models are downloaded after install, show their license/source before or with the download.
- This is an engineering reading of the published terms, not legal advice; a commercial ADE release should run the final artifact list through its normal license review.

## Decision

**Proceed: the feature is very feasible.** Build the first spike with Moonshine WASM and compare it against a `whisper.cpp` base-model sidecar using the same short English/German recordings and the packaged ADE build. If multilingual support is a day-one requirement, expect `whisper.cpp` to win by default because its model licensing and language coverage are cleaner. If English-only live partial dictation is the goal, Moonshine is likely the shortest path.
