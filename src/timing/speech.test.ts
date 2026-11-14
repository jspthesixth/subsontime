import { describe, expect, it, vi } from "vitest";
import { SpeechDetector } from "../../wasm/alass_wasm.js";
import { detectSpeech } from "./speech.ts";

const sampleRate = 16000;
const fundamental = 140;
const formants = [
  { frequency: 700, gain: 1 },
  { frequency: 1200, gain: 0.6 },
  { frequency: 2500, gain: 0.3 },
];

const harmonicGain = (frequency: number) =>
  formants
    .map((formant) => formant.gain / (1 + ((frequency - formant.frequency) / 150) ** 2))
    .reduce((sum, gain) => sum + gain, 0);

const harmonics = Array.from({ length: 25 }, (_, index) => ({
  multiple: index + 1,
  gain: harmonicGain(fundamental * (index + 1)),
}));

const voiced = (time: number) => {
  const phase =
    2 *
    Math.PI *
    (fundamental * time - (30 / (2 * Math.PI * 3)) * (Math.cos(2 * Math.PI * 3 * time) - 1));
  const envelope = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * time);

  return (
    harmonics
      .map((harmonic) => Math.sin(phase * harmonic.multiple) * harmonic.gain)
      .reduce((sum, value) => sum + value, 0) *
    0.3 *
    envelope *
    8000
  );
};

const samples = (ms: number) => Math.round((ms * sampleRate) / 1000);

const burst = (ms: number) =>
  Int16Array.from({ length: samples(ms) }, (_, index) => voiced(index / sampleRate));

const silence = (ms: number) => new Int16Array(samples(ms));

const concat = (parts: Int16Array[]) => {
  const joined = new Int16Array(parts.reduce((length, part) => length + part.length, 0));

  parts.reduce((offset, part) => {
    joined.set(part, offset);

    return offset + part.length;
  }, 0);

  return joined;
};

const chunked = async function* (pcm: Int16Array, size: number) {
  for (let offset = 0; offset < pcm.length; offset += size) {
    yield pcm.subarray(offset, offset + size);
  }
};

const once = async function* (pcm: Int16Array) {
  yield pcm;
};

const failing = async function* () {
  yield silence(100);
  throw new Error("ffmpeg exited");
};

const gapped = (ms: number) =>
  detectSpeech(
    once(concat([silence(500), burst(600), silence(ms), burst(600), silence(500)])),
    sampleRate,
  );

const bursts = [
  { start: 500, end: 1500 },
  { start: 2300, end: 3300 },
  { start: 4100, end: 5100 },
];

const speech = concat([
  silence(500),
  burst(1000),
  silence(800),
  burst(1000),
  silence(800),
  burst(1000),
  silence(500),
]);

describe("detectSpeech", () => {
  it("finds harmonic bursts within 60 ms of their edges", async () => {
    const cues = await detectSpeech(once(speech), sampleRate);

    expect(cues).toHaveLength(bursts.length);
    cues.forEach((cue, index) => {
      expect(Math.abs(cue.start - (bursts[index]?.start ?? 0))).toBeLessThanOrEqual(60);
      expect(Math.abs(cue.end - (bursts[index]?.end ?? 0))).toBeLessThanOrEqual(60);
      expect(cue.text).toBe("");
    });
  });

  it("finds nothing in silence", async () => {
    expect(await detectSpeech(once(silence(5000)), sampleRate)).toEqual([]);
  });

  it("gives the same spans for 4 KB chunks, odd chunks and one push", async () => {
    const whole = await detectSpeech(once(speech), sampleRate);

    expect(await detectSpeech(chunked(speech, 2048), sampleRate)).toEqual(whole);
    expect(await detectSpeech(chunked(speech, 1000), sampleRate)).toEqual(whole);
    expect(await detectSpeech(chunked(speech, 37), sampleRate)).toEqual(whole);
  });

  it("merges speech across a gap under 200 ms and keeps a longer gap", async () => {
    expect(await gapped(150)).toHaveLength(1);
    expect(await gapped(600)).toHaveLength(2);
  });

  it("drops a burst shorter than 300 ms", async () => {
    const cues = await detectSpeech(
      once(concat([silence(500), burst(150), silence(1000), burst(1000), silence(500)])),
      sampleRate,
    );

    expect(cues).toHaveLength(1);
    expect(Math.abs((cues[0]?.start ?? 0) - 1650)).toBeLessThanOrEqual(60);
  });

  it("frees the detector when the audio stream fails", async () => {
    const dispose = vi.spyOn(SpeechDetector.prototype, Symbol.dispose);

    await expect(detectSpeech(failing(), sampleRate)).rejects.toThrow("ffmpeg exited");
    expect(dispose).toHaveBeenCalledOnce();
    dispose.mockRestore();
  });

  it("rejects a sample rate other than 16 kHz", async () => {
    await expect(detectSpeech(once(silence(100)), 8000)).rejects.toThrow("16000");
  });
});
