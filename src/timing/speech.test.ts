import { describe, expect, it, vi } from "vitest";
import { SpeechDetector } from "../../wasm/alass_wasm.js";
import { detectSpeech } from "./speech.ts";
import {
  burst,
  chunked,
  concat,
  once,
  rms,
  sampleRate,
  silence,
  tone,
  whiteNoise,
} from "./test-audio.ts";

const failing = async function* () {
  yield silence(100);
  throw new Error("ffmpeg exited");
};

const detected = (parts: Int16Array[]) => detectSpeech(once(concat(parts)), sampleRate);

const gapped = (ms: number) =>
  detected([silence(500), burst(600), silence(ms), burst(600), silence(500)]);

const lone = (ms: number) => detected([silence(500), burst(ms), silence(1000)]);

const speechLevel = rms(burst(1000));

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

  it("finds nothing in white noise at the speech level", async () => {
    expect(
      await detected([silence(500), whiteNoise(1000, speechLevel * Math.sqrt(3), 1), silence(500)]),
    ).toEqual([]);
  });

  it("marks white noise at half the speech level as speech", async () => {
    expect(
      await detected([
        silence(500),
        whiteNoise(1000, (speechLevel * Math.sqrt(3)) / 2, 1),
        silence(500),
      ]),
    ).toHaveLength(1);
  });

  it("marks a pure 300 Hz tone at the speech level as speech", async () => {
    expect(
      await detected([silence(500), tone(1000, 300, speechLevel * Math.SQRT2), silence(500)]),
    ).toHaveLength(1);
  });

  it("gives the same spans for 4 KB chunks, odd chunks and one push", async () => {
    const whole = await detectSpeech(once(speech), sampleRate);

    expect(await detectSpeech(chunked(speech, 2048), sampleRate)).toEqual(whole);
    expect(await detectSpeech(chunked(speech, 1000), sampleRate)).toEqual(whole);
    expect(await detectSpeech(chunked(speech, 37), sampleRate)).toEqual(whole);
  });

  it("merges speech across a 192 ms gap and splits it at 208 ms", async () => {
    const split = await gapped(260);

    expect(await gapped(250)).toHaveLength(1);
    expect(split).toHaveLength(2);
    expect((split[1]?.start ?? 0) - (split[0]?.end ?? 0)).toBe(208);
  });

  it("keeps a 304 ms span and drops a 288 ms one", async () => {
    const kept = await lone(250);

    expect(kept).toHaveLength(1);
    expect((kept[0]?.end ?? 0) - (kept[0]?.start ?? 0)).toBe(304);
    expect(await lone(240)).toEqual([]);
  });

  it("keeps the end of speech that stops inside the last partial frame", async () => {
    const [cue] = await detected([silence(500), burst(1000)]);

    expect(Math.abs((cue?.end ?? 0) - 1500)).toBeLessThanOrEqual(16);
  });

  it("frees the detector when the audio stream fails", async () => {
    const free = vi.spyOn(SpeechDetector.prototype, "free");

    await expect(detectSpeech(failing(), sampleRate)).rejects.toThrow("ffmpeg exited");
    expect(free).toHaveBeenCalledOnce();
    free.mockRestore();
  });

  it("rejects a sample rate other than 16 kHz", async () => {
    await expect(detectSpeech(once(silence(100)), 8000)).rejects.toThrow("16000");
  });
});
