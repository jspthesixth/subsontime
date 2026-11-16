import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import nightOfTheLivingDead from "../../test/fixtures/audio/night-of-the-living-dead.json" with { type: "json" };
import type { Cue } from "../subtitles/cue.ts";
import { alignCues, scoreOf, speedRatioFromFPS } from "../timing/alass.ts";
import { cutsOf, deltasOf, median, splitWorthScore } from "../timing/retime.ts";
import { resegment, seededRandom, syntheticTrack, transform } from "../timing/test-tracks.ts";
import {
  alignToAudio,
  alignToSpeech,
  audioAcceptContrast,
  audioDecisionOf,
  audioMismatchContrast,
  contrastOf,
  decisionOf,
  plausibleSpeechShare,
  shortClipMs,
  speechProblemOf,
  minimumCues,
  windowAgreementMs,
  windowCount,
} from "./align-audio.ts";
import { exitError, pcmFrom, samplesFrom } from "./ffmpeg.ts";
import {
  ffmpeg,
  hasFFmpeg,
  writeBursts,
  writeBrownNoise,
  writeSilentAudio,
  writeSilentPicture,
} from "./test-video.ts";

const track = syntheticTrack(1, 30);
const trackEnd = track.at(-1)?.end ?? 0;
const introMs = 90_000;
const missingFFmpeg = "ffmpeg is needed for --audio. Install it and try again.";

const directory = await mkdtemp(join(tmpdir(), "subsontime-audio-"));
const bursts = join(directory, "bursts.mkv");
const intro = join(directory, "intro.mkv");
const pictureOnly = join(directory, "picture-only.mkv");
const silent = join(directory, "silent.mkv");
const noise = join(directory, "noise.mkv");
const shortClip = join(directory, "short.mkv");
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

const shortTrack = syntheticTrack(1, 5);
const second = (atSeconds: number) => ({
  start: atSeconds * 1000,
  end: atSeconds * 1000 + 1000,
  text: "",
});
const pattern = transform(
  [
    { start: 1000, end: 3000, text: "" },
    { start: 4000, end: 5500, text: "" },
    { start: 7000, end: 10_000, text: "" },
  ],
  (time) => time + 200_000,
);
const wrongShiftsSeconds = [-149, -113, -71, -37, 37, 71, 113, 149];

const sortedSpans = (spans: Cue[]) => spans.toSorted((a, b) => a.start - b.start);

const cuesOf = (pairs: number[][]) =>
  pairs.map(([start = 0, end = 0]) => ({ start, end, text: "" }));

const film = {
  audioMs: nightOfTheLivingDead.audioMs,
  speech: cuesOf(nightOfTheLivingDead.speech),
  cues: cuesOf(nightOfTheLivingDead.cues),
};

const patternWithin = (spans: Cue[]) => sortedSpans([second(0), ...pattern, ...spans, second(400)]);

const contrastOfPattern = (spans: Cue[]) => contrastOf(spans, pattern, scoreOf(spans, pattern));

const alignedTo = async (videoPath: string, cues: Cue[]) => {
  const result = await alignToAudio(videoPath, cues);

  if (result.kind !== "aligned") {
    throw new Error("Expected speech in the test video");
  }

  return result;
};

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

describe("speechProblemOf", () => {
  const cues = syntheticTrack(1, 3);

  it("names a soundtrack without speech", () => {
    expect(speechProblemOf({ spans: [], audioMs: 1000 }, cues)).toEqual({ kind: "no-speech" });
  });

  it("names an empty subtitle", () => {
    expect(
      speechProblemOf({ spans: [{ start: 0, end: 500, text: "" }], audioMs: 1000 }, []),
    ).toEqual({
      kind: "empty-subtitle",
    });
  });

  it("names speech in too much of the soundtrack", () => {
    expect(
      speechProblemOf({ spans: [{ start: 0, end: 1000, text: "" }], audioMs: 1000 }, cues),
    ).toEqual({
      kind: "implausible-speech",
      share: 1,
    });
  });
});

describe("contrastOf", () => {
  it("is high for a pattern that matches only at its true position", () => {
    expect(
      contrastOfPattern(patternWithin(transform(pattern, (time) => time + 55_000))),
    ).toBeGreaterThanOrEqual(audioAcceptContrast);
  });

  it.each(wrongShiftsSeconds)("is near 1 when a copy of the pattern sits %i s away", (shift) => {
    expect(
      contrastOfPattern(patternWithin(transform(pattern, (time) => time + shift * 1000))),
    ).toBeCloseTo(1, 1);
  });

  it.each([
    [0.085, false],
    [0.136, true],
  ])("judges a score of %f against a noise floor when no wrong shift scores", (score, accepted) => {
    const spans = patternWithin(transform(pattern, (time) => time + 55_000));

    expect((contrastOf(spans, pattern, score) ?? 0) >= audioAcceptContrast).toBe(accepted);
  });

  it("measures a short clip on the 4 shifts that stay on its speech", () => {
    expect(contrastOfPattern(sortedSpans([second(135), ...pattern, second(275)]))).toBeTypeOf(
      "number",
    );
  });

  it("gives no contrast for a short clip with 3 shifts on its speech", () => {
    expect(contrastOfPattern(sortedSpans([second(135), ...pattern, second(270)]))).toBeUndefined();
  });

  it("measures every shift once the subtitle spans 300 s", () => {
    const cues = [...pattern, second(501)];
    const spans = transform(pattern, (time) => time + 800_000);

    expect(contrastOf(spans, cues, scoreOf(spans, cues))).toBeTypeOf("number");
  });
});

describe("alignToSpeech on a full-length film", () => {
  it("keeps the subtitle inside the soundtrack instead of a faster copy hanging past its end", async () => {
    const result = await alignToSpeech({ spans: film.speech, audioMs: film.audioMs }, film.cues);

    expect(result).toMatchObject({ kind: "aligned", speedRatio: 1 });
    expect(
      median(deltasOf(film.cues, result.kind === "aligned" ? result.cues : [], 1)),
    ).toBeCloseTo(-5200, -3);
    expect(result).toHaveProperty(
      "contrast",
      expect.toSatisfy((value) => value >= audioMismatchContrast),
    );
  });
});

describe("alignToSpeech with a rigid gate", () => {
  const speech = syntheticTrack(3, 300);
  const heard = { spans: speech, audioMs: (speech.at(-1)?.end ?? 0) + 2000 };
  const movedBy = (offsetOf: (index: number) => number) =>
    speech.map((cue, index) => ({
      ...cue,
      start: cue.start + offsetOf(index),
      end: cue.end + offsetOf(index),
    }));

  it("does not accept a subtitle that only a split fit matches", async () => {
    const scattered = movedBy((index) => {
      const chunk = Math.floor(index / 20);

      return (((chunk * 7919) % 50) - 25) * 1000 + (chunk % 2) * 300;
    });
    const split = await alignCues(speech, scattered, { withinReference: true });

    expect(contrastOf(speech, split.cues, scoreOf(speech, split.cues))).toBeGreaterThanOrEqual(
      audioAcceptContrast,
    );
    expect(await alignToSpeech(heard, scattered)).toHaveProperty(
      "contrast",
      expect.toSatisfy((value) => value < audioAcceptContrast),
    );
  });

  it("accepts a subtitle one offset away with its rigid cues", async () => {
    const result = await alignToSpeech(
      heard,
      movedBy(() => 2000),
    );

    expect(result).toMatchObject({ kind: "aligned", decision: "accept" });
    expect(startsWithin(result.kind === "aligned" ? result.cues : [], speech)).toBeLessThanOrEqual(
      100,
    );
  });

  it.each([0.5, 0.25, 0.15, 0.1])(
    "does not accept a subtitle whose last %f of cues sit 1.5 s later",
    async (tail) => {
      const cut = Math.round(speech.length * (1 - tail));
      const result = await alignToSpeech(
        heard,
        movedBy((index) => (index < cut ? 2000 : 3500)),
      );

      expect(result).toMatchObject({
        kind: "aligned",
        contrast: expect.toSatisfy((value) => value >= audioAcceptContrast),
        decision: "not-clear",
      });
    },
  );

  it("does not accept the subtitle whose cues from 85 % on sit 1.5 s later", async () => {
    const cut = Math.floor(speech.length * 0.85);
    const result = await alignToSpeech(
      heard,
      movedBy((index) => (index < cut ? 2000 : 3500)),
    );

    expect(result).toMatchObject({ kind: "aligned", decision: "not-clear" });
  });
});

describe("alignToSpeech", () => {
  const speechMs = track.reduce((sum, cue) => sum + cue.end - cue.start, 0);
  const heardAt = (share: number) => ({ spans: track, audioMs: speechMs / share });

  it.each([0.1, 0.95])("calls speech in %f of the soundtrack implausible", async (share) => {
    expect(await alignToSpeech(heardAt(share), track)).toEqual({
      kind: "implausible-speech",
      share: expect.closeTo(share, 6),
    });
  });

  it.each([plausibleSpeechShare.min, plausibleSpeechShare.max])(
    "aligns with speech in %f of the soundtrack",
    async (share) => {
      expect(await alignToSpeech(heardAt(share), track)).not.toHaveProperty(
        "kind",
        "implausible-speech",
      );
    },
  );
});

const agreeing = {
  contrast: audioAcceptContrast,
  windowMs: shortClipMs,
  cues: minimumCues,
  offsetMs: 1000,
  windowOffsetsMs: Array.from(
    { length: windowCount },
    (_, index) => 1000 + (index % 2) * windowAgreementMs,
  ),
};

const withWindow = (index: number, offsetMs: number | null) => ({
  ...agreeing,
  windowOffsetsMs: agreeing.windowOffsetsMs.map((window, at) => (at === index ? offsetMs : window)),
});

describe("decisionOf", () => {
  it.each([
    ["a subtitle whose windows agree", agreeing, "accept"],
    [
      "a contrast just under the bar",
      { ...agreeing, contrast: audioAcceptContrast - 0.01 },
      "not-clear",
    ],
    ["a subtitle under 300 s", { ...agreeing, windowMs: shortClipMs - 1 }, "not-clear"],
    ["a subtitle with one cue too few", { ...agreeing, cues: minimumCues - 1 }, "not-clear"],
    ["one window 1 ms too late", withWindow(9, 1000 + windowAgreementMs + 1), "not-clear"],
    ["one window 1 ms too early", withWindow(0, 1000 - windowAgreementMs - 1), "not-clear"],
    ["a window without speech nearby", withWindow(4, null), "not-clear"],
    ["the mismatch bar", { ...agreeing, contrast: audioMismatchContrast }, "not-clear"],
    [
      "a contrast just under the mismatch bar",
      { ...agreeing, contrast: audioMismatchContrast - 0.01 },
      "mismatch",
    ],
    ["no contrast", undefined, "not-clear"],
  ])("decides %s", (_, evidence, decision) => {
    expect(decisionOf(evidence)).toBe(decision);
  });
});

const sparseTrack = (seed: number, count: number, fromMs: number, gapMs: [number, number]) => {
  const random = seededRandom(seed);
  const between = ([min, max]: [number, number]) => Math.round(min + random() * (max - min));

  return Array.from({ length: count }).reduce<Cue[]>((cues, _, index) => {
    const start = (cues.at(-1)?.end ?? fromMs) + between(gapMs);

    return [...cues, { start, end: start + between([1000, 4000]), text: `Sparse ${index}` }];
  }, []);
};

const after = (cues: Cue[], fromMs: number) => transform(cues, (time) => time + fromMs);

const endOf = (cues: Cue[]) => cues.at(-1)?.end ?? 0;

const denseThenSparse = (dense: number, sparse: number) => {
  const head = syntheticTrack(5, dense);

  return [...head, ...sparseTrack(7, sparse, endOf(head), [4000, 7000])];
};

const sparseThenDense = (sparse: number, dense: number) => {
  const lead = sparseTrack(9, sparse, 0, [4000, 7000]);

  return [...lead, ...after(syntheticTrack(5, dense), endOf(lead))];
};

const withDenseBurst = () => {
  const before = syntheticTrack(11, 120);
  const burst = sparseTrack(13, 70, endOf(before), [100, 300]).map((cue) => ({
    ...cue,
    end: cue.start + 300 + (cue.end - cue.start) / 10,
  }));

  return [...before, ...burst, ...after(syntheticTrack(17, 30), endOf(burst))];
};

const withShortBlock = (from: number, count: number) => {
  const random = seededRandom(21);
  const between = (min: number, max: number) => Math.round(min + random() * (max - min));

  return Array.from({ length: 300 }).reduce<Cue[]>((cues, _, index) => {
    const start = (cues.at(-1)?.end ?? 0) + between(300, 3000);
    const short = index >= from && index < from + count;

    return [
      ...cues,
      { start, end: start + (short ? between(400, 800) : between(2500, 4500)), text: `L${index}` },
    ];
  }, []);
};

const decisionFor = async (speech: Cue[], isMoved: (index: number) => boolean) => {
  const subtitle = speech.map((cue, index) => {
    const shift = isMoved(index) ? 3500 : 2000;

    return { ...cue, start: cue.start + shift, end: cue.end + shift };
  });
  const result = await alignToSpeech({ spans: speech, audioMs: endOf(speech) + 2000 }, subtitle);

  return result.kind === "aligned" ? result.decision : result.kind;
};

describe("alignToSpeech with a block of cues 1.5 s later", () => {
  it.each([
    [
      "the last 16 of 140 cues, spread thin",
      denseThenSparse(124, 16),
      (index: number) => index >= 124,
    ],
    [
      "the last 17 of 167 cues, spread thin",
      denseThenSparse(150, 17),
      (index: number) => index >= 150,
    ],
    [
      "the first 16 of 140 cues, spread thin",
      sparseThenDense(16, 124),
      (index: number) => index < 16,
    ],
    [
      "31 of 300 cues straddling two windows from cue 74",
      syntheticTrack(3, 300),
      (index: number) => index >= 74 && index < 105,
    ],
    [
      "31 of 300 cues straddling two windows from cue 164",
      syntheticTrack(3, 300),
      (index: number) => index >= 164 && index < 195,
    ],
    [
      "36 short cues of 300 straddling cue 150",
      withShortBlock(132, 36),
      (index: number) => index >= 132 && index < 168,
    ],
    [
      "28 of 220 cues inside a dense stretch",
      withDenseBurst(),
      (index: number) => index >= 162 && index < 190,
    ],
  ])("does not accept %s", async (_, speech, isMoved) => {
    expect(await decisionFor(speech, () => false)).toBe("accept");
    expect(await decisionFor(speech, isMoved)).toBe("not-clear");
  });
});

describe("alignToSpeech with a subtitle listed out of order", () => {
  it("does not accept a block of 31 cues 1.5 s later when the cues are shuffled", async () => {
    const speech = syntheticTrack(3, 300);
    const random = seededRandom(5);
    const shuffled = speech
      .map((cue, index) => {
        const shift = index >= 74 && index < 105 ? 3500 : 2000;

        return { cue: { ...cue, start: cue.start + shift, end: cue.end + shift }, key: random() };
      })
      .toSorted((a, b) => a.key - b.key)
      .map(({ cue }) => cue);
    const result = await alignToSpeech({ spans: speech, audioMs: endOf(speech) + 2000 }, shuffled);

    expect(result).toMatchObject({ kind: "aligned", decision: "not-clear" });
  });
});

describe("alignToSpeech with cues moved one by one", () => {
  it("accepts 20 % of the cues moved 1.5 s at random, a known limit outside the guarantee", async () => {
    const random = seededRandom(42);
    const moved = syntheticTrack(3, 300).map(() => random() < 0.2);

    expect(await decisionFor(syntheticTrack(3, 300), (index) => moved[index] === true)).toBe(
      "accept",
    );
  });
});

describe("audioDecisionOf", () => {
  it("reads the decision of an aligned subtitle", () => {
    expect(
      audioDecisionOf({
        kind: "aligned",
        cues: track,
        score: 0.5,
        offsetScore: 0.5,
        speedRatio: 1,
        contrast: 9,
        decision: "mismatch",
      }),
    ).toBe("mismatch");
  });

  it.each([
    { kind: "no-speech" as const },
    { kind: "implausible-speech" as const, share: 0.05 },
    { kind: "too-short" as const },
    { kind: "empty-subtitle" as const },
  ])("calls $kind not clear", (alignment) => {
    expect(audioDecisionOf(alignment)).toBe("not-clear");
  });
});

describe("alignToAudio without ffmpeg", () => {
  it("reports an empty subtitle without reading the video", async () => {
    expect(await alignToAudio(join(directory, "missing.mkv"), [])).toEqual({
      kind: "empty-subtitle",
    });
  });
});

describe("pcmFrom without ffmpeg", () => {
  it("asks for ffmpeg when it cannot be started", async () => {
    vi.stubEnv("SUBSONTIME_FFMPEG", join(directory, "no-such-ffmpeg"));

    const failure = drain(pcmFrom(bursts, new AbortController().signal));

    await expect(failure).rejects.toThrow(missingFFmpeg);
    await expect(failure).rejects.not.toHaveProperty("cause");
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
      writeSilentAudio(silent, 5000),
      writeBrownNoise(noise, 600_000),
      writeBursts(shortClip, shortTrack, (shortTrack.at(-1)?.end ?? 0) + 2000),
    ]);
  }, 60_000);

  it("brings a subtitle 2 s late back within 100 ms of the speech", async () => {
    const result = await alignedTo(
      bursts,
      transform(track, (time) => time + 2000),
    );

    expect(result.speedRatio).toBe(1);
    expect(result.contrast).toBeGreaterThanOrEqual(audioAcceptContrast);
    expect(startsWithin(result.cues, track)).toBeLessThanOrEqual(100);
  });

  it("recovers a subtitle timed for 25 fps on 23.976 fps audio", async () => {
    const speedRatio = speedRatioFromFPS(25, 23.976);

    const result = await alignedTo(
      bursts,
      transform(track, (time) => time * speedRatio + 2000),
    );

    expect(result.speedRatio).toBe(speedRatio);
    expect(startsWithin(result.cues, track)).toBeLessThanOrEqual(100);
  });

  it("keeps one offset across a 90 s silent intro", async () => {
    const subtitle = transform(resegment(track, 7), (time) => time + 2000);

    const result = await alignedTo(intro, subtitle);

    const deltas = deltasOf(subtitle, result.cues, result.speedRatio);

    expect(result.offsetScore).toBeLessThan(splitWorthScore);
    expect(cutsOf(deltas)).toBe(0);
    expect(Math.abs(median(deltas) - (introMs - 2000))).toBeLessThanOrEqual(100);
  });

  it("calls a soundtrack of brown noise implausible speech", async () => {
    const result = await alignToAudio(noise, track);

    expect(result).toEqual({ kind: "implausible-speech", share: expect.any(Number) });
    expect(result).toHaveProperty(
      "share",
      expect.toSatisfy((share) => share > plausibleSpeechShare.max),
    );
  });

  it("reports a clip too short to judge", async () => {
    expect(
      await alignToAudio(
        shortClip,
        transform(shortTrack, (time) => time + 2000),
      ),
    ).toEqual({ kind: "too-short" });
  });

  it("reads a file whose name looks like an ffmpeg protocol", async () => {
    const working = process.cwd();

    await copyFile(bursts, join(directory, "concat:x.mkv"));
    process.chdir(directory);

    try {
      expect(
        startsWithin((await alignedTo("concat:x.mkv", track)).cues, track),
      ).toBeLessThanOrEqual(100);
    } finally {
      process.chdir(working);
    }
  });

  it("reports no speech for a silent soundtrack", async () => {
    expect(await alignToAudio(silent, track)).toEqual({ kind: "no-speech" });
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
