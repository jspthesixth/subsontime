import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hear } from "./align-audio.ts";
import { audioStreamOf, chooseAudioStream, pcmFrom, type AudioStream } from "./ffmpeg.ts";
import { hasFFmpeg, run, writeBursts } from "./test-video.ts";

const stream = (language: string | undefined, extra: Partial<AudioStream> = {}): AudioStream => ({
  tags: { language },
  ...extra,
});

const cue = (start: number, end: number) => ({ start, end, text: "x" });

describe("chooseAudioStream", () => {
  const dubFirst = [stream("hrv"), stream("eng")];

  it("picks the stream in the subtitle language", () => {
    expect(chooseAudioStream(dubFirst, "en")).toBe(1);
    expect(chooseAudioStream(dubFirst, "eng")).toBe(1);
    expect(chooseAudioStream(dubFirst, "hr")).toBe(0);
    expect(chooseAudioStream([stream("fra"), stream("ger")], "de")).toBe(1);
  });

  it("falls back to the original flag, then the default flag, then the first", () => {
    const original = [
      stream("hrv"),
      stream("fra", { disposition: { comment: 0, original: 1, default: 0 } }),
    ];
    const flagged = [
      stream("hrv"),
      stream("fra", { disposition: { comment: 0, original: 0, default: 1 } }),
    ];

    expect(chooseAudioStream(original, "eng")).toBe(1);
    expect(chooseAudioStream(flagged, "eng")).toBe(1);
    expect(chooseAudioStream(dubFirst, undefined)).toBe(0);
  });

  it("never picks a commentary track", () => {
    const titled = [
      stream("eng", { tags: { language: "eng", title: "Director's Commentary" } }),
      stream("hrv"),
    ];
    const flagged = [
      stream("eng", { disposition: { comment: 1, original: 0, default: 0 } }),
      stream("eng"),
    ];

    expect(chooseAudioStream(titled, "en")).toBe(1);
    expect(chooseAudioStream(flagged, "en")).toBe(1);
  });

  it("gives 0 for an empty list", () => {
    expect(chooseAudioStream([], "en")).toBe(0);
  });
});

describe.skipIf(!hasFFmpeg)("audioStreamOf", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("decodes the track tagged with the subtitle language", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subsontime-stream-"));
    const first = join(directory, "first.mkv");
    const second = join(directory, "second.mkv");
    const both = join(directory, "both.mkv");

    await writeBursts(first, [cue(2000, 4000), cue(6000, 8000)], 20_000);
    await writeBursts(second, [cue(10_000, 12_000), cue(14_000, 16_000)], 20_000);
    await run([
      "-i",
      first,
      "-i",
      second,
      "-map",
      "0:v",
      "-map",
      "0:a",
      "-map",
      "1:a",
      "-c",
      "copy",
      "-metadata:s:a:0",
      "language=hrv",
      "-metadata:s:a:1",
      "language=eng",
      both,
    ]);

    const signal = new AbortController().signal;
    const english = await audioStreamOf(both, "en", signal);
    const croatian = await audioStreamOf(both, "hr", signal);
    const { spans } = await hear(pcmFrom(both, signal, english));

    expect([english, croatian]).toEqual([1, 0]);
    expect(Math.abs((spans[0]?.start ?? 0) - 10_000)).toBeLessThan(500);
  });

  it("uses the first stream when ffprobe is missing", async () => {
    vi.stubEnv("SUBSONTIME_FFPROBE", "/no/such/ffprobe");

    expect(await audioStreamOf("film.mkv", "en", new AbortController().signal)).toBe(0);
  });
});
