import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  alignToAudio,
  audioAcceptContrast,
  audioMismatchContrast,
  decisionOf,
  shortClipMs,
  type AudioAlignment,
} from "../audio/align-audio.ts";
import { ffmpegFound } from "../audio/ffmpeg.ts";
import { hasFFmpeg, writeBursts } from "../audio/test-video.ts";
import type { Cue } from "../subtitles/cue.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import { writeSRT } from "../subtitles/write.ts";
import { syntheticTrack, transform } from "../timing/test-tracks.ts";
import { memoryStore } from "../timings/db.ts";
import { main } from "./main.ts";
import {
  confirmFix,
  noNetwork,
  posts,
  startTimings,
  stopTimings,
  videoKeyOf,
} from "./test-timings.ts";

vi.mock("../audio/align-audio.ts", { spy: true });
vi.mock("../audio/ffmpeg.ts", { spy: true });

const spoken = syntheticTrack(1, 90);
const spokenEnd = spoken.at(-1)?.end ?? 0;
const lateSpoken = transform(spoken, (time) => time + 2000);
const track = syntheticTrack(1, 200);
const shiftedBy = (ms: number) => transform(track, (time) => time + ms);

const directory = await mkdtemp(join(tmpdir(), "subsontime-bazarr-"));
const burstsVideo = join(directory, "bursts.mkv");
let work = "";
let configDir = "";

const aligned = (cues: Cue[], contrast: number, speedRatio = 1): AudioAlignment => ({
  kind: "aligned",
  cues,
  score: 0.9,
  offsetScore: 0.9,
  speedRatio,
  contrast,
  decision: decisionOf({ contrast, windowMs: shortClipMs, thirdOffsetsMs: [0, 0, 0] }),
});

const crlfWithBOM = (cues: Cue[]) => `﻿${writeSRT(cues).replaceAll("\n", "\r\n")}`;

const prepare = async (subtitleText = crlfWithBOM(track), name = "Film.2001.en.srt") => {
  const video = join(work, "Film.2001.mkv");
  const subtitle = join(work, name);

  await writeFile(video, Buffer.alloc(100_000, 7));
  await writeFile(subtitle, subtitleText);

  return { video, subtitle };
};

const run = async (argv: string[]) => {
  const printed: string[] = [];
  const errors: string[] = [];
  const code = await main(["bazarr", ...argv], {
    print: (text) => printed.push(text),
    printError: (text) => errors.push(text),
    color: false,
    env: {},
    configDir,
    locales: ["en-US"],
  });

  return { code, output: printed.join(""), errors: errors.join("") };
};

const argsFor = ({ video, subtitle }: { video: string; subtitle: string }, ...extra: string[]) => [
  "--video",
  video,
  "--subtitle",
  subtitle,
  "--lang",
  "eng",
  ...extra,
];

const cuesIn = async (path: string) => parseSubtitle(await readFile(path, "utf8"));

const origOf = (subtitle: string) => subtitle.replace(/\.srt$/, ".orig.srt");

beforeAll(async () => {
  if (hasFFmpeg) {
    await writeBursts(burstsVideo, spoken, spokenEnd + 2000);
  }
}, 60_000);

beforeEach(async () => {
  work = await mkdtemp(join(directory, "work-"));
  configDir = join(work, "config");
  vi.clearAllMocks();
});

afterEach(() => {
  stopTimings();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(ffmpegFound).mockRestore();
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("with the audio measured", () => {
  beforeEach(() => {
    vi.mocked(ffmpegFound).mockReturnValue(true);
  });

  it("overwrites the subtitle, keeps the original and shares nothing", async () => {
    const paths = await prepare();
    const original = await readFile(paths.subtitle);
    const { url, requests } = await startTimings();

    vi.mocked(alignToAudio).mockResolvedValueOnce(aligned(shiftedBy(1200), 9.43));

    const { code, output, errors } = await run(argsFor(paths, "--api", url));

    expect(code).toBe(0);
    expect(errors).toBe("");
    expect(output).toBe(
      "subsontime: synced to the audio +1.20 s · contrast 9.4 · not shared, audio check not reliable enough yet\n",
    );
    expect(await cuesIn(paths.subtitle)).toEqual(shiftedBy(1200));
    expect(await readFile(origOf(paths.subtitle))).toEqual(original);
    expect(posts(requests)).toEqual([]);
  });

  it.each([
    ["a median shift of 100 ms", aligned(shiftedBy(100), 9.4)],
    ["a median shift of -100 ms", aligned(shiftedBy(-100), 9.4)],
  ])(
    "leaves a subtitle already in sync byte-identical and shares nothing at %s",
    async (_, alignment) => {
      const paths = await prepare();
      const original = await readFile(paths.subtitle);
      const { url, requests } = await startTimings();

      vi.mocked(alignToAudio).mockResolvedValueOnce(alignment);

      const { code, output } = await run(argsFor(paths, "--api", url));

      expect(code).toBe(0);
      expect(output).toBe(
        "subsontime: already in sync with the audio · contrast 9.4 · not shared, audio check not reliable enough yet\n",
      );
      expect(await readFile(paths.subtitle)).toEqual(original);
      expect(await readdir(work)).not.toContain("Film.2001.en.orig.srt");
      expect(posts(requests)).toEqual([]);
    },
  );

  it.each([
    ["a median shift of 101 ms", shiftedBy(101), 1, /\+0\.10 s/],
    [
      "a speed change",
      transform(track, (time) => Math.round(time / 1.001)),
      1.001,
      /\+0\.00 s · ×1\.0010/,
    ],
    [
      "a cut",
      transform(track, (time) => (time < 600_000 ? time : time + 5000)),
      1,
      /\+0\.00 s · cuts at 00:\d\d:\d\d/,
    ],
  ])("rewrites a subtitle with %s", async (_, cues, speedRatio, shift) => {
    const paths = await prepare();

    vi.mocked(alignToAudio).mockResolvedValueOnce(aligned(cues, 9.4, speedRatio));

    const { output } = await run(argsFor(paths, "--private"));

    expect(output).toMatch(
      new RegExp(
        `^subsontime: synced to the audio ${shift.source} · contrast 9\\.4 · not shared, --private\n$`,
      ),
    );
    expect(await cuesIn(paths.subtitle)).toEqual(cues);
  });

  it("rewrites at a contrast of exactly 3.5 and shares nothing", async () => {
    const paths = await prepare();
    const { url, requests } = await startTimings();

    vi.mocked(alignToAudio).mockResolvedValueOnce(aligned(shiftedBy(1200), audioAcceptContrast));

    const { output } = await run(argsFor(paths, "--api", url));

    expect(output).toBe(
      "subsontime: synced to the audio +1.20 s · contrast 3.5 · not shared, audio check not reliable enough yet\n",
    );
    expect(posts(requests)).toEqual([]);
  });

  it("leaves the subtitle and shares nothing at a contrast of exactly 1", async () => {
    const paths = await prepare();
    const original = await readFile(paths.subtitle);
    const { url, requests } = await startTimings();

    vi.mocked(alignToAudio).mockResolvedValueOnce(aligned(shiftedBy(1200), audioMismatchContrast));

    const { output } = await run(argsFor(paths, "--api", url));

    expect(output).toBe("subsontime: left as it is · not clear enough (contrast 1.0)\n");
    expect(await readFile(paths.subtitle)).toEqual(original);
    expect(posts(requests)).toEqual([]);
  });

  it("leaves a subtitle for another video and reports nothing", async () => {
    const paths = await prepare();
    const original = await readFile(paths.subtitle);
    const { url, requests } = await startTimings();

    vi.mocked(alignToAudio).mockResolvedValueOnce(aligned(shiftedBy(30_000), 0.9));

    const { code, output } = await run(argsFor(paths, "--api", url));

    expect(code).toBe(0);
    expect(output).toBe(
      "subsontime: left as it is · made for another video (contrast 0.9) · not shared, audio check not reliable enough yet\n",
    );
    expect(await readFile(paths.subtitle)).toEqual(original);
    expect(await readdir(work)).not.toContain("Film.2001.en.orig.srt");
    expect(posts(requests)).toEqual([]);
  });

  it.each<[string, AudioAlignment, string]>([
    [
      "a contrast between the two thresholds",
      aligned(shiftedBy(1200), 2.1),
      "not clear enough (contrast 2.1)",
    ],
    ["no speech", { kind: "no-speech" }, "no speech found"],
    [
      "speech in 95 % of the soundtrack",
      { kind: "implausible-speech", share: 0.95 },
      "not clear enough (speech in 95 % of the soundtrack)",
    ],
    ["a short clip", { kind: "too-short" }, "clip too short"],
    ["an empty subtitle", { kind: "empty-subtitle" }, "empty subtitle"],
  ])("leaves the subtitle and shares nothing after %s", async (_, alignment, reason) => {
    const paths = await prepare();
    const original = await readFile(paths.subtitle);
    const { url, requests } = await startTimings();

    vi.mocked(alignToAudio).mockResolvedValueOnce(alignment);

    const { code, output } = await run(argsFor(paths, "--api", url));

    expect(code).toBe(0);
    expect(output).toBe(`subsontime: left as it is · ${reason}\n`);
    expect(await readFile(paths.subtitle)).toEqual(original);
    expect(posts(requests)).toEqual([]);
  });

  it("keeps the subtitle's file mode", async () => {
    const paths = await prepare();

    await chmod(paths.subtitle, 0o600);
    vi.mocked(alignToAudio).mockResolvedValueOnce(aligned(shiftedBy(1200), 9.4));

    await run(argsFor(paths, "--private"));

    expect((await stat(paths.subtitle)).mode & 0o777).toBe(0o600);
    expect(await cuesIn(paths.subtitle)).toEqual(shiftedBy(1200));
  });

  it("replaces the original when Bazarr downloads a different subtitle", async () => {
    const paths = await prepare();
    const other = track.map((cue) => ({ ...cue, text: `Other ${cue.text}` }));

    vi.mocked(alignToAudio)
      .mockResolvedValueOnce(aligned(shiftedBy(1200), 9.4))
      .mockResolvedValueOnce(
        aligned(
          transform(other, (time) => time + 1200),
          9.4,
        ),
      );

    await run(argsFor(paths, "--private"));
    await writeFile(paths.subtitle, crlfWithBOM(other));

    const download = await readFile(paths.subtitle);

    await run(argsFor(paths, "--private"));

    expect(await readFile(origOf(paths.subtitle))).toEqual(download);
  });

  it("keeps the original when it runs again on its own output", async () => {
    const paths = await prepare();
    const original = await readFile(paths.subtitle);

    vi.mocked(alignToAudio)
      .mockResolvedValueOnce(aligned(shiftedBy(1200), 9.4))
      .mockResolvedValueOnce(aligned(shiftedBy(2400), 9.4));

    await run(argsFor(paths, "--private"));
    await run(argsFor(paths, "--private"));

    expect(await readFile(origOf(paths.subtitle))).toEqual(original);
    expect(await cuesIn(paths.subtitle)).toEqual(shiftedBy(2400));
    expect((await readdir(work)).toSorted()).toEqual([
      "Film.2001.en.orig.srt",
      "Film.2001.en.srt",
      "Film.2001.mkv",
    ]);
  });

  it("decodes the subtitle in the code page of its language", async () => {
    const cyrillic = track.map((cue) => ({ ...cue, text: `Привет ${cue.text}` }));
    const paths = await prepare();

    await writeFile(paths.subtitle, iconv.encode(writeSRT(cyrillic), "windows-1251"));
    vi.mocked(alignToAudio).mockImplementationOnce(async (_, cues) =>
      aligned(
        transform(cues, (time) => time + 1200),
        9.4,
      ),
    );

    await run(["--video", paths.video, "--subtitle", paths.subtitle, "--lang", "rus", "--private"]);

    expect((await cuesIn(paths.subtitle))[0]?.text).toBe("Привет Line 0");
  });

  it("makes no contact with Open Timings with --private", async () => {
    const paths = await prepare();
    const { url, requests } = await startTimings();
    const fetched = noNetwork();

    vi.stubGlobal("fetch", fetched);
    vi.mocked(alignToAudio).mockResolvedValueOnce(aligned(shiftedBy(1200), 9.4));

    const { output } = await run(argsFor(paths, "--private", "--api", url));

    expect(output).toBe(
      "subsontime: synced to the audio +1.20 s · contrast 9.4 · not shared, --private\n",
    );
    expect(requests).toEqual([]);
    expect(fetched).not.toHaveBeenCalled();
    await expect(stat(join(configDir, "install-id"))).rejects.toThrow("ENOENT");
  });

  it("exits 0 with one line when anything throws", async () => {
    const paths = await prepare();

    vi.mocked(alignToAudio).mockRejectedValueOnce(new Error("Something broke\n    at secret"));

    const { code, output, errors } = await run(argsFor(paths, "--private"));

    expect(code).toBe(0);
    expect(output).toBe("subsontime: left as it is · Something broke\n");
    expect(errors).toBe("");
  });
});

describe("without the audio", () => {
  it("applies a confirmed shared fix in place without ffmpeg", async () => {
    const store = memoryStore();
    const paths = await prepare(crlfWithBOM(shiftedBy(2000)));
    const original = await readFile(paths.subtitle);
    const { url, requests } = await startTimings(store);

    await confirmFix(store, await videoKeyOf(paths.video), track);
    vi.stubEnv("SUBSONTIME_FFMPEG", join(work, "no-such-ffmpeg"));

    const { code, output } = await run(argsFor(paths, "--api", url));

    expect(code).toBe(0);
    expect(output).toBe("subsontime: shared fix, confirmed -2.00 s · 2 agree · from audio\n");
    expect(await cuesIn(paths.subtitle)).toEqual(track);
    expect(await readFile(origOf(paths.subtitle))).toEqual(original);
    expect(vi.mocked(alignToAudio)).not.toHaveBeenCalled();
    expect(posts(requests)).toEqual([]);
  });

  it("leaves a subtitle already in sync with a confirmed shared fix byte-identical", async () => {
    const store = memoryStore();
    const paths = await prepare(crlfWithBOM(shiftedBy(80)));
    const original = await readFile(paths.subtitle);
    const { url, requests } = await startTimings(store);

    await confirmFix(store, await videoKeyOf(paths.video), track);
    vi.stubEnv("SUBSONTIME_FFMPEG", join(work, "no-such-ffmpeg"));

    const { code, output } = await run(argsFor(paths, "--api", url));

    expect(code).toBe(0);
    expect(output).toBe(
      "subsontime: already in sync with the shared fix, confirmed -0.08 s · 2 agree · from audio\n",
    );
    expect(await readFile(paths.subtitle)).toEqual(original);
    expect(await readdir(work)).not.toContain("Film.2001.en.orig.srt");
    expect(posts(requests)).toEqual([]);
  });

  it("says ffmpeg is needed when no shared fix applies", async () => {
    const paths = await prepare();
    const original = await readFile(paths.subtitle);

    vi.stubEnv("SUBSONTIME_FFMPEG", join(work, "no-such-ffmpeg"));

    const { code, output } = await run(argsFor(paths, "--private"));

    expect(code).toBe(0);
    expect(output).toBe(
      "subsontime: left as it is · ffmpeg is needed to sync to the audio. Install it and try again.\n",
    );
    expect(await readFile(paths.subtitle)).toEqual(original);
  });

  it("leaves a subtitle that is not .srt", async () => {
    const paths = await prepare("[Script Info]\n", "Film.2001.en.ass");
    const fetched = noNetwork();

    vi.stubGlobal("fetch", fetched);

    const { code, output } = await run(argsFor(paths));

    expect(code).toBe(0);
    expect(output).toBe("subsontime: left as it is · only .srt subtitles are retimed\n");
    expect(await readFile(paths.subtitle, "utf8")).toBe("[Script Info]\n");
    expect(fetched).not.toHaveBeenCalled();
    expect(vi.mocked(alignToAudio)).not.toHaveBeenCalled();
  });

  it.each([
    [[]],
    [["--video", "film.mkv"]],
    [["--video", "film.mkv", "--subtitle", "film.srt", "--colour"]],
    [["--video", "film.mkv", "--subtitle", "film.srt", "--api", "nowhere"]],
    [["--video", "film.mkv", "--subtitle", "film.srt", "extra"]],
    [["--video", "film.mkv", "--subtitle", "film.srt", "two\nlines"]],
  ])("exits 0 with one line for the usage error %j", async (argv) => {
    const { code, output, errors } = await run(argv);

    expect(code).toBe(0);
    expect(output).toMatch(
      /^subsontime: [^\n]* · usage: subsontime bazarr --video <path> --subtitle <path> --lang <code3>\n$/,
    );
    expect(errors).toBe("");
  });

  it("exits 0 with one line when the subtitle is missing", async () => {
    const paths = await prepare();

    await rm(paths.subtitle);

    const { code, output } = await run(argsFor(paths, "--private"));

    expect(code).toBe(0);
    expect(output).toMatch(/^subsontime: left as it is · ENOENT[^\n]*\n$/);
  });
});

describe.skipIf(!hasFFmpeg)("with ffmpeg", () => {
  it("handles paths with spaces, quotes and čćž", async () => {
    const folder = join(work, `Film's "Cut" čćž`);
    const video = join(folder, `Film's "Cut" čćž.mkv`);
    const subtitle = join(folder, `Film's "Cut" čćž.hr.srt`);

    await mkdir(folder);
    await writeFile(video, await readFile(burstsVideo));
    await writeFile(subtitle, writeSRT(lateSpoken));

    const { code, output } = await run([
      "--video",
      video,
      "--subtitle",
      subtitle,
      "--lang",
      "hrv",
      "--private",
    ]);
    const starts = (await cuesIn(subtitle)).map((cue, index) =>
      Math.abs(cue.start - (spoken[index]?.start ?? 0)),
    );

    expect(code).toBe(0);
    expect(output).toMatch(
      /^subsontime: synced to the audio -(1\.9|2\.0)\d s · contrast \d+\.\d · not shared, --private\n$/,
    );
    expect(Math.max(...starts)).toBeLessThan(100);
    expect(await readFile(origOf(subtitle), "utf8")).toBe(writeSRT(lateSpoken));
  });

  it("leaves a subtitle already in sync byte-identical and shares nothing", async () => {
    const video = join(work, "Film.2001.mkv");
    const subtitle = join(work, "Film.2001.en.srt");
    const { url, requests } = await startTimings();

    await writeFile(video, await readFile(burstsVideo));
    await writeFile(subtitle, crlfWithBOM(spoken));

    const original = await readFile(subtitle);
    const { output } = await run(argsFor({ video, subtitle }, "--api", url));

    expect(output).toMatch(
      /^subsontime: already in sync with the audio · contrast \d+\.\d · not shared, audio check not reliable enough yet\n$/,
    );
    expect(await readFile(subtitle)).toEqual(original);
    expect(posts(requests)).toEqual([]);
  });
});
