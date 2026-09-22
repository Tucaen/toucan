/**
 * The pinned speech engine and checkpoint, one home for both.
 *
 * Dictation decodes with whisper.cpp's `whisper-server` and the official `large-v3-turbo`
 * checkpoint (both MIT; the checkpoint's card at
 * https://huggingface.co/openai/whisper-large-v3-turbo states its license, and the GGML conversion
 * below is ggerganov's own). Neither is in the installer: the host downloads both on first use into
 * userData, and every byte is verified against the
 * SHA-256 pinned here - the engine is an executable, so a pin is not optional hygiene but the
 * difference between running what was reviewed and running whatever a CDN answered with.
 *
 * `scripts/whisper-files.mjs` reads these very constants out of `.test-out`, so the WER harness
 * cannot measure a different engine than the one Toucan dictates with.
 */

/** The whisper.cpp release build the Windows CPU binaries are taken from. */
export const WHISPER_ENGINE_BUILD = 'b5130'

export const WHISPER_ENGINE_ZIP = {
  name: 'whisper-bin-x64.zip',
  url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_ENGINE_BUILD}/whisper-bin-x64.zip`,
  size: 8573270,
  sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c'
} as const

/** OpenAI Whisper large-v3-turbo (MIT), converted to GGML by ggerganov/whisper.cpp on Hugging Face. */
export const WHISPER_MODEL = {
  name: 'ggml-large-v3-turbo.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
  size: 1624555275,
  sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69'
} as const

/**
 * What is taken out of the engine zip, and nothing else. The zip ships two dozen demo and test
 * executables; the server decodes dictations, the CLI is what `voice:wer` scores models with, and
 * the DLLs are the runtime both load (ggml picks the widest `ggml-cpu-*` variant this CPU runs).
 */
export const WHISPER_ENGINE_ENTRIES: readonly string[] = [
  'whisper-server.exe',
  'whisper-cli.exe',
  'whisper.dll',
  'ggml.dll',
  'ggml-base.dll',
  'ggml-cpu-alderlake.dll',
  'ggml-cpu-cannonlake.dll',
  'ggml-cpu-cascadelake.dll',
  'ggml-cpu-haswell.dll',
  'ggml-cpu-icelake.dll',
  'ggml-cpu-sandybridge.dll',
  'ggml-cpu-skylakex.dll',
  'ggml-cpu-sse42.dll',
  'ggml-cpu-x64.dll'
]

/** Directory names under `<userData>/models/whisper/`: the extracted engine, beside the checkpoint. */
export const WHISPER_ENGINE_DIRECTORY = 'bin'

/** The size the downloading button names, derived so the label cannot drift from the pins. */
export const WHISPER_DOWNLOAD_GIGABYTES = `${((WHISPER_ENGINE_ZIP.size + WHISPER_MODEL.size) / 1e9).toFixed(1)} GB`

/**
 * Written beside the downloaded assets as `NOTICE.txt`: the licensing checklist in
 * `docs/research/voice-input.md` asks for third-party notices and provenance in the model cache.
 */
export const WHISPER_NOTICE = `Speech assets downloaded by Toucan on first use of dictation.

Engine: whisper.cpp ${WHISPER_ENGINE_BUILD} Windows x64 CPU binaries
  Source:  ${WHISPER_ENGINE_ZIP.url}
  SHA-256: ${WHISPER_ENGINE_ZIP.sha256}
  License: MIT (https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE)

Model: OpenAI Whisper large-v3-turbo, GGML conversion by ggerganov/whisper.cpp
  Source:  ${WHISPER_MODEL.url}
  SHA-256: ${WHISPER_MODEL.sha256}
  License: MIT (https://huggingface.co/openai/whisper-large-v3-turbo)
`
