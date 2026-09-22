import { downmixToMono, REMOTE_VOICE_MAX_SECONDS, REMOTE_VOICE_SAMPLE_RATE, resampleLinear } from './remote-voice'

/**
 * Capturing a dictation off a microphone, for every browser Toucan runs one in.
 *
 * Browser-only by construction - it reaches for `navigator.mediaDevices` and `AudioContext` and
 * nothing else - which is what lets the desktop renderer and the phone client share it. Both were
 * carrying the same forty lines, down to the comment about `ScriptProcessorNode` (#230), and both
 * feed the same contract: `remote-voice.ts` fixes the rate and the cap, so what the phone sends the
 * host and what the renderer hands the local decoder are the same bytes by the same arithmetic.
 *
 * A `ScriptProcessorNode` rather than an `AudioWorklet`: it is deprecated but it runs everywhere
 * without a second bundle entry, and a dictation is short enough that its main-thread cost does not
 * show. Samples are kept at the device rate and resampled once at the end, so a long recording pays
 * for the conversion once rather than per block.
 */

/** One recording in progress: the microphone, the graph, and what has been heard so far. */
export interface PcmRecording {
  /** Stops the graph, releases the device, and returns the whole utterance as 16 kHz mono samples. */
  finish(): Promise<Float32Array>
  /** Stops the graph and releases the device, keeping nothing. */
  discard(): void
}

export interface PcmRecorderEvents {
  /**
   * The recording reached `REMOTE_VOICE_MAX_SECONDS` and has stopped capturing. The caller decides
   * what that means - keeping what was said is the usual answer - but nothing more will arrive.
   */
  onLimit(): void
  /**
   * Every processed block: seconds captured so far, and that block's peak amplitude in [0, 1].
   * Optional because a surface that shows neither an elapsed count nor a level meter should not
   * pay for the scan - the phone's fallback recorder does not.
   */
  onPeak?(elapsedSeconds: number, peak: number): void
}

/** Opens the microphone and starts capturing. Rejects if the device is refused or unavailable. */
export async function startPcmRecording(events: PcmRecorderEvents): Promise<PcmRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const context = new AudioContext()
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  let captured = 0
  const limit = context.sampleRate * REMOTE_VOICE_MAX_SECONDS
  let stopped = false

  processor.onaudioprocess = (event) => {
    if (stopped) return
    const channels: Float32Array[] = []
    for (let channel = 0; channel < event.inputBuffer.numberOfChannels; channel += 1) {
      channels.push(new Float32Array(event.inputBuffer.getChannelData(channel)))
    }
    const mono = downmixToMono(channels)
    chunks.push(mono)
    captured += mono.length
    if (events.onPeak) {
      let peak = 0
      for (const sample of mono) peak = Math.max(peak, Math.abs(sample))
      events.onPeak(captured / context.sampleRate, peak)
    }
    if (captured >= limit) {
      stopped = true
      events.onLimit()
    }
  }
  source.connect(processor)
  // A ScriptProcessorNode only runs while it is connected to the graph's output.
  processor.connect(context.destination)

  const release = async (): Promise<void> => {
    stopped = true
    processor.disconnect()
    source.disconnect()
    for (const track of stream.getTracks()) track.stop()
    await context.close()
  }

  return {
    finish: async () => {
      await release()
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const samples = new Float32Array(total)
      let offset = 0
      for (const chunk of chunks) {
        samples.set(chunk, offset)
        offset += chunk.length
      }
      return resampleLinear(samples, context.sampleRate, REMOTE_VOICE_SAMPLE_RATE)
    },
    discard: () => void release()
  }
}
