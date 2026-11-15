import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Cue } from "../subtitles/cue.ts";
import { speedRatioFromFPS } from "../timing/alass.ts";
import { cutsOf, deltasOf, median, splitWorthScore } from "../timing/retime.ts";
import { resegment, syntheticTrack, transform } from "../timing/test-tracks.ts";
import { alignToAudio } from "./align-audio.ts";
import { exitError, pcmFrom, samplesFrom } from "./ffmpeg.ts";
import { ffmpeg, hasFFmpeg, writeBursts, writeSilentPicture } from "./test-video.ts";

const track = syntheticTrack(1, 30);
const trackEnd = track.at(-1)?.end ?? 0;
const introMs = 90_000;
const missingFFmpeg = "ffmpeg is needed for --audio. Install it and try again.";

const directory = await mkdtemp(join(tmpdir(), "subsontime-audio-"));
const bursts = join(directory, "bursts.mkv");
const intro = join(directory, "intro.mkv");
const pictureOnly = join(directory, "picture-only.mkv");
const pidFile = join(directory, "ffmpeg.pid");
const wrapper = join(directory, "ffmpeg-wrapper.sh");

const drain = async (pcm: AsyncIterable<Int16Array>) => {
  const chunks: Int16Array[] = [];

  for await (const chunk of pcm) {
    chunks.push(chunk);
  }

  return chunks.flatMap((chunk) => Array.from(chunk));
};

const bytesIn = async function* (bytes: Uint8Array, sizes: number[]) {
  let offset = 0;

  for (const size of sizes) {
    yield bytes.subarray(offset, offset + size);
    offset += size;
  }
};

const startsWithin = (aligned: Cue[], expected: Cue[]) =>
  Math.max(...aligned.map((cue, index) => Math.abs(cue.start - (expected[index]?.start ?? 0))));

const ffmpegIsGone = async () => {
  const pid = Number(await readFile(pidFile, "utf8"));

  expect(() => process.kill(pid, 0)).toThrow("ESRCH");
};

if (!hasFFmpeg) {
  process.stderr.write(
    "ffmpeg not found: skipping the audio alignment tests. Set SUBSONTIME_FFMPEG to run them.\n",
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("samplesFrom", () => {
  it("joins samples split across odd chunk boundaries", async () => {
    const samples = Int16Array.from([1, -2, 300, -32768, 32767, 0, -1]);
    const bytes = new Uint8Array(samples.buffer);

    expect(await drain(samplesFrom(bytesIn(bytes, [1, 3, 1, 4, 1, 1, 3])))).toEqual(
      Array.from(samples),
    );
  });

  it("reads samples from a chunk that starts at an odd byte offset", async () => {
    const samples = Int16Array.from([1234, -4321]);
    const shifted = new Uint8Array(samples.byteLength + 1);

    shifted.set(new Uint8Array(samples.buffer), 1);

    expect(await drain(samplesFrom(bytesIn(shifted.subarray(1), [4])))).toEqual([1234, -4321]);
  });
});

describe("pcmFrom without ffmpeg", () => {
  it("asks for ffmpeg when it cannot be started", async () => {
    vi.stubEnv("SUBSONTIME_FFMPEG", join(directory, "no-such-ffmpeg"));

    await expect(drain(pcmFrom(bursts, new AbortController().signal))).rejects.toThrow(
      missingFFmpeg,
    );
  });
});

describe("exitError", () => {
  it("names the exit code and the last stderr line without the video path", () => {
    const videoPath = "/media/films/Some Film (2001)/film.mkv";

    expect(
      exitError(1, null, `warning\n${videoPath}: No such file or directory\n`, videoPath).message,
    ).toBe("ffmpeg exited with code 1: the video: No such file or directory");
  });

  it("names the signal when ffmpeg was killed", () => {
    expect(exitError(null, "SIGKILL", "Killed\n", "film.mkv").message).toBe(
      "ffmpeg exited with SIGKILL: Killed",
    );
  });
});

describe.skipIf(!hasFFmpeg)("with ffmpeg", () => {
  beforeAll(async () => {
    await writeFile(wrapper, `#!/bin/sh\necho $$ > '${pidFile}'\nexec '${ffmpeg}' "$@"\n`);
    await chmod(wrapper, 0o755);
    await Promise.all([
      writeBursts(bursts, track, trackEnd + 2000),
      writeBursts(
        intro,
        transform(track, (time) => time + introMs),
        introMs + trackEnd + 2000,
      ),
      writeSilentPicture(pictureOnly, 2000),
    ]);
  }, 60_000);

  it("brings a subtitle 2 s late back within 100 ms of the speech", async () => {
    const result = await alignToAudio(
      bursts,
      transform(track, (time) => time + 2000),
    );

    expect(result.speedRatio).toBe(1);
    expect(startsWithin(result.cues, track)).toBeLessThanOrEqual(100);
  });

  it("recovers a subtitle timed for 25 fps on 23.976 fps audio", async () => {
    const speedRatio = speedRatioFromFPS(25, 23.976);

    const result = await alignToAudio(
      bursts,
      transform(track, (time) => time * speedRatio + 2000),
    );

    expect(result.speedRatio).toBe(speedRatio);
    expect(startsWithin(result.cues, track)).toBeLessThanOrEqual(100);
  });

  it("keeps one offset across a 90 s silent intro", async () => {
    const subtitle = transform(resegment(track, 7), (time) => time + 2000);

    const result = await alignToAudio(intro, subtitle);

    const deltas = deltasOf(subtitle, result.cues, result.speedRatio);

    expect(result.offsetScore).toBeLessThan(splitWorthScore);
    expect(cutsOf(deltas)).toBe(0);
    expect(Math.abs(median(deltas) - (introMs - 2000))).toBeLessThanOrEqual(100);
  });

  it("names a video without an audio track", async () => {
    await expect(alignToAudio(pictureOnly, track)).rejects.toThrow("The video has no audio track");
  });

  it("reports ffmpeg's exit code and last error line", async () => {
    const failure = drain(pcmFrom(join(directory, "missing.mkv"), new AbortController().signal));

    await expect(failure).rejects.toThrow(/^ffmpeg exited with code \d+: .+/);
    await expect(failure).rejects.not.toThrow(directory);
  });

  it("stops ffmpeg when the read is aborted", async () => {
    const controller = new AbortController();

    vi.stubEnv("SUBSONTIME_FFMPEG", wrapper);

    await expect(
      (async () => {
        for await (const chunk of pcmFrom(intro, controller.signal)) {
          expect(chunk.length).toBeGreaterThan(0);
          controller.abort();
        }
      })(),
    ).rejects.toMatchObject({ name: "AbortError" });
    await ffmpegIsGone();
  });

  it("stops ffmpeg when the reader stops early", async () => {
    vi.stubEnv("SUBSONTIME_FFMPEG", wrapper);

    for await (const chunk of pcmFrom(intro, new AbortController().signal)) {
      expect(chunk.length).toBeGreaterThan(0);
      break;
    }

    await ffmpegIsGone();
  });

  it("rejects a read aborted before it starts", async () => {
    await expect(alignToAudio(intro, track, { signal: AbortSignal.abort() })).rejects.toMatchObject(
      { name: "AbortError" },
    );
  });
});
