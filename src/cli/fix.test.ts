import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { alignToSpeech, type AudioAlignment } from "../audio/align-audio.ts";
import { hasFFmpeg, writeBursts } from "../audio/test-video.ts";
import type { SourceSet } from "../sources/from-config.ts";
import { fakeSource } from "../sources/test-sources.ts";
import type { Cue } from "../subtitles/cue.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import { writeSRT } from "../subtitles/write.ts";
import { syntheticTrack, transform } from "../timing/test-tracks.ts";
import { memoryStore } from "../timings/db.ts";
import { abandonWrites, findVideos, shareLinesFor, shiftText } from "./fix.ts";
import { cleanName, identify } from "./identify.ts";
import { configDirOf, fallbackConfigDir, installIdFrom, installIdIn } from "./install-id.ts";
import { main, type CLIDeps } from "./main.ts";
import {
  confirmFix,
  noNetwork,
  posts,
  startTimings,
  stopTimings,
  videoKeyOf,
} from "./test-timings.ts";

vi.mock("../audio/align-audio.ts", { spy: true });
vi.mock("node:fs/promises", { spy: true });

const track = syntheticTrack(1, 200);
const shifted = transform(track, (time) => time + 2000);
const unrelated = syntheticTrack(2, 200).map((cue) => ({ ...cue, text: `Wrong ${cue.text}` }));
const spoken = syntheticTrack(1, 30);
const spokenEnd = spoken.at(-1)?.end ?? 0;
const lateSpoken = transform(spoken, (time) => time + 2000);
const otherSpoken = transform(spoken, (time) => time + 3000).map((cue) => ({
  ...cue,
  text: `Other ${cue.text}`,
}));
const movieName = "Example.Movie.2024.1080p.WEB-DL-GROUP";
const missingFFmpeg = "ffmpeg is needed for --audio. Install it and try again.";

const directory = await mkdtemp(join(tmpdir(), "subsontime-cli-"));
const burstsVideo = join(directory, "bursts.mkv");
let work = "";
let configDir = "";

const writeVideo = async (name: string, bytes = 100_000) => {
  const path = join(work, name);

  await writeFile(path, Buffer.alloc(bytes, 7));

  return path;
};

const sized = async (path: string, bytes: number) => {
  await writeFile(path, "");
  await truncate(path, bytes);
};

const catalog = (metas: { id: string; name: string; releaseInfo?: string }[]) =>
  vi.fn<typeof fetch>(async () => Response.json({ metas }));

const copyBursts = async (name: string) => {
  const path = join(work, name);

  await writeFile(path, await readFile(burstsVideo));

  return path;
};

const retimedSources = (): SourceSet => ({
  listed: [fakeSource("Fake", [{ ref: "a", cues: shifted, releaseName: movieName }])],
  references: [fakeSource("Reference", [{ ref: "r", hashMatch: true, cues: track }])],
});

const detailLine = (label: string, value: string) => `      ${label.padEnd(28)}${value}`;

const run = async (argv: string[], deps: Partial<CLIDeps> = {}) => {
  const printed: string[] = [];
  const errors: string[] = [];
  const code = await main(argv, {
    print: (text) => printed.push(text),
    printError: (text) => errors.push(text),
    color: false,
    env: {},
    configDir,
    locales: ["en-US"],
    ...deps,
  });

  return { code, output: printed.join(""), errors: errors.join("") };
};

const cuesIn = async (path: string) => parseSubtitle(await readFile(path, "utf8"));

const startsWithin = (aligned: Cue[], expected: Cue[]) =>
  Math.max(...aligned.map((cue, index) => Math.abs(cue.start - (expected[index]?.start ?? 0))));

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
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("languages", () => {
  it("accepts ISO 639-1 and 639-2 codes", async () => {
    const video = await writeVideo(`${movieName}.mkv`);
    const source = fakeSource("Fake", [
      { ref: "h", lang: "hrv", cues: track },
      { ref: "e", lang: "eng", cues: track },
    ]);

    const { code } = await run(
      ["fix", video, "--lang", "hr,eng", "--imdb", "tt0111161", "--private"],
      { sources: { listed: [source], references: [] } },
    );

    expect(code).toBe(0);
    expect(source.search.mock.calls[0]?.[0].languages).toEqual(["hrv", "eng"]);
    expect((await readdir(work)).toSorted()).toEqual([
      `${movieName}.en.srt`,
      `${movieName}.hr.srt`,
      `${movieName}.mkv`,
    ]);
  });

  it("defaults to the system language plus English", async () => {
    const video = await writeVideo(`${movieName}.mkv`);
    const source = fakeSource("Fake", []);

    await run(["fix", video, "--imdb", "tt0111161", "--private"], {
      sources: { listed: [source], references: [] },
      locales: ["hr-HR"],
    });

    expect(source.search.mock.calls[0]?.[0].languages).toEqual(["hrv", "eng"]);
  });

  it("rejects an unknown language code on stderr", async () => {
    const video = await writeVideo(`${movieName}.mkv`);

    const { code, output, errors } = await run(["fix", video, "--lang", "xx", "--offline"]);

    expect(code).toBe(2);
    expect(output).toBe("");
    expect(errors).toContain("Unknown language code xx");
  });
});

describe("findVideos", () => {
  it("walks a folder one level deep and skips samples, small files and links", async () => {
    await mkdir(join(work, "Extras"));
    await Promise.all([
      sized(join(work, "Film.2001.1080p.mkv"), 60_000_000),
      sized(join(work, "Film.2001.1080p.Sample.mkv"), 60_000_000),
      sized(join(work, "Short.2001.mp4"), 1000),
      sized(join(work, "notes.txt"), 60_000_000),
      sized(join(work, "Show.S01E02.webm"), 60_000_000),
      sized(join(work, "Extras", "Inside.mkv"), 60_000_000),
    ]);
    await symlink(join(work, "Film.2001.1080p.mkv"), join(work, "Linked.mkv"));

    expect(await findVideos(work, false)).toEqual({
      videos: [join(work, "Film.2001.1080p.mkv"), join(work, "Show.S01E02.webm")],
      links: [join(work, "Linked.mkv")],
    });
    expect((await findVideos(work, true)).videos).toEqual([
      join(work, "Extras", "Inside.mkv"),
      join(work, "Film.2001.1080p.mkv"),
      join(work, "Show.S01E02.webm"),
    ]);
  });

  it("keeps a named file whatever its size", async () => {
    const video = await writeVideo("tiny.mkv", 10);

    expect(await findVideos(video, false)).toEqual({ videos: [video], links: [] });
  });

  it("names a skipped symbolic link in the summary", async () => {
    await sized(join(work, "Real.mkv"), 1000);
    await symlink(join(work, "Real.mkv"), join(work, "Film.2001.mkv"));

    const { code, output } = await run(["fix", work, "--lang", "en", "--private"], {
      sources: retimedSources(),
    });

    expect(code).toBe(1);
    expect(output).toBe("  skipped     Film.2001.mkv · a symbolic link\n\n");
  });
});

describe("identify", () => {
  it.each([
    ["Blade.Runner.2049.2017.1080p.BluRay.x264.mkv", "Blade Runner 2049", "2017"],
    ["Death.Race.2000.1975.720p.BluRay.mkv", "Death Race 2000", "1975"],
    ["Peter.Pan.1953.1080p.BluRay.x264.YIFY.mp4", "Peter Pan", "1953"],
    ["Peter.Pan.1080p.BluRay.mp4", "Peter Pan", undefined],
    ["2001.A.Space.Odyssey.1968.2160p.mkv", "2001 A Space Odyssey", "1968"],
  ])("cleans %s to %s and %s", (fileName, title, year) => {
    expect(cleanName(fileName)).toMatchObject({ title, year });
  });

  it.each([
    ["Blade.Runner.2049.2017.1080p.BluRay.x264.mkv", "tt1856101", "Blade Runner 2049"],
    ["Death.Race.2000.1975.720p.BluRay.mkv", "tt0072856", "Death Race 2000"],
    ["Peter.Pan.1953.1080p.BluRay.x264.YIFY.mp4", "tt0046183", "Peter Pan"],
  ])("finds %s by its name and year", async (fileName, imdbId, name) => {
    const fetched = catalog([
      { id: "tt0083658", name: "Blade Runner", releaseInfo: "1982" },
      { id: "tt1856101", name: "Blade Runner 2049", releaseInfo: "2017" },
      { id: "tt0072856", name: "Death Race 2000", releaseInfo: "1975" },
      { id: "tt0452608", name: "Death Race", releaseInfo: "2008" },
      { id: "tt0316396", name: "Peter Pan", releaseInfo: "2003" },
      { id: "tt0046183", name: "Peter Pan", releaseInfo: "1953" },
    ]);

    vi.stubGlobal("fetch", fetched);

    expect(await identify(fileName)).toEqual({
      kind: "found",
      title: { type: "movie", imdbId },
      name,
      year: cleanName(fileName).year,
    });
    expect(String(fetched.mock.calls[0]?.[0])).toBe(
      `https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(name)}.json`,
    );
  });

  it("asks for --imdb when a name without a year matches several titles", async () => {
    vi.stubGlobal(
      "fetch",
      catalog([
        { id: "tt0316396", name: "Peter Pan", releaseInfo: "2003" },
        { id: "tt0046183", name: "Peter Pan", releaseInfo: "1953" },
      ]),
    );

    expect(await identify("Peter.Pan.1080p.BluRay.mp4")).toEqual({
      kind: "skipped",
      reason: "Several titles match; use --imdb",
    });
  });

  it("takes the one title a name without a year matches", async () => {
    vi.stubGlobal("fetch", catalog([{ id: "tt0046183", name: "Peter Pan", releaseInfo: "1953" }]));

    expect(await identify("Peter.Pan.1080p.BluRay.mp4")).toMatchObject({
      kind: "found",
      title: { imdbId: "tt0046183" },
    });
  });

  it("rejects the only match when its year differs from the file's", async () => {
    vi.stubGlobal("fetch", catalog([{ id: "tt0046183", name: "Peter Pan", releaseInfo: "1953" }]));

    expect(await identify("Peter.Pan.2003.1080p.BluRay.mp4")).toEqual({
      kind: "skipped",
      reason: "Could not identify this title",
    });
  });

  it("finds an episode by its series name", async () => {
    const fetched = catalog([{ id: "tt0903747", name: "Example Show", releaseInfo: "2008-2013" }]);

    vi.stubGlobal("fetch", fetched);

    expect(await identify("Example.Show.S01E02.720p.HDTV.x264-GROUP.mkv")).toEqual({
      kind: "found",
      title: { type: "series", imdbId: "tt0903747", season: 1, episode: 2 },
      name: "Example Show",
      year: "2008",
    });
    expect(String(fetched.mock.calls[0]?.[0])).toBe(
      "https://v3-cinemeta.strem.io/catalog/series/top/search=Example%20Show.json",
    );
  });

  it("names the catalog when it cannot be reached", async () => {
    vi.stubGlobal("fetch", noNetwork());

    expect(await identify("Peter.Pan.1953.1080p.mp4")).toEqual({
      kind: "skipped",
      reason: "Could not reach Stremio's catalog to identify this title",
    });
  });

  it("prints the title row and skips a file the catalog does not know", async () => {
    const video = await writeVideo("Peter.Pan.1953.1080p.BluRay.mp4");
    const unknown = await writeVideo("Unknown.Title.2024.1080p.mkv");

    vi.stubGlobal("fetch", catalog([{ id: "tt0046183", name: "Peter Pan", releaseInfo: "1953" }]));

    const found = await run(["fix", video, "--lang", "en", "--private"], {
      sources: retimedSources(),
    });
    const missing = await run(["fix", unknown, "--lang", "en", "--private"], {
      sources: retimedSources(),
    });

    expect(found.output).toContain("\n  title       Peter Pan · 1953 · tt0046183\n");
    expect(missing.code).toBe(1);
    expect(missing.output).toContain("\n  skipped     Could not identify this title\n");
  });
});

describe("Open Timings", () => {
  it("shares a retimed fix and reuses one install id created with mode 0600", async () => {
    const { url, requests } = await startTimings();
    const video = await writeVideo(`${movieName}.mkv`);
    const args = ["fix", video, "--lang", "en", "--imdb", "tt0111161", "--api", url];

    const first = await run(args, { sources: retimedSources() });

    await rm(join(work, `${movieName}.en.srt`));
    await run(args, { sources: retimedSources() });

    const installIdFile = join(configDir, "install-id");
    const installId = await readFile(installIdFile, "utf8");
    const sent = posts(requests);

    expect(first.output).toContain(
      `${detailLine("shared with Open Timings", "numbers and fingerprints only")}\n`,
    );
    expect((await stat(installIdFile)).mode & 0o777).toBe(0o600);
    expect(installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.map((request) => request.path)).toEqual(["/api/v1/fixes", "/api/v1/fixes"]);
    expect(sent.map((request) => request.body)).toEqual([
      expect.objectContaining({ method: "reference", installId }),
      expect.objectContaining({ method: "reference", installId }),
    ]);
  });

  it("replaces an install id file that does not hold a UUID", async () => {
    const installIdFile = join(configDir, "install-id");

    await mkdir(configDir);
    await writeFile(installIdFile, "not an id", { mode: 0o644 });

    const installId = await installIdIn(configDir);

    expect(installId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await readFile(installIdFile, "utf8")).toBe(installId);
    expect((await stat(installIdFile)).mode & 0o777).toBe(0o600);
    expect(await installIdIn(configDir)).toBe(installId);
  });

  it("makes no contact with Open Timings with --private", async () => {
    const { url, requests } = await startTimings();
    const video = await writeVideo(`${movieName}.mkv`);

    const { code, output } = await run(
      ["fix", video, "--lang", "en", "--imdb", "tt0111161", "--private", "--api", url],
      { sources: retimedSources() },
    );

    expect(code).toBe(0);
    expect(requests).toEqual([]);
    expect(output).toContain(`${detailLine("not shared", "--private")}\n`);
    await expect(stat(join(configDir, "install-id"))).rejects.toThrow("ENOENT");
  });

  it("keeps going when Open Timings does not answer", async () => {
    const video = await writeVideo(`${movieName}.mkv`);

    const { code, output } = await run(
      ["fix", video, "--lang", "en", "--imdb", "tt0111161", "--api", "http://127.0.0.1:1"],
      { sources: retimedSources() },
    );

    expect(code).toBe(0);
    expect(output).toContain(`${detailLine("not shared", "Open Timings did not answer")}\n`);
  });

  it("says when no folder can hold the install id", async () => {
    const { url, requests } = await startTimings();
    const video = await writeVideo(`${movieName}.mkv`);
    const home = join(work, "home");

    await mkdir(home, { mode: 0o500 });

    const { code, output } = await run(
      ["fix", video, "--lang", "en", "--imdb", "tt0111161", "--api", url],
      { sources: retimedSources(), configDir: join(home, ".config", "subsontime") },
    );

    expect(code).toBe(0);
    expect(output).toContain(
      `${detailLine("not shared", "could not save the install id: EACCES")}\n`,
    );
    expect(posts(requests)).toEqual([]);
  });
});

describe.skipIf(!hasFFmpeg)("with ffmpeg", () => {
  it("applies a confirmed shared fix without references and checks it against the audio", async () => {
    const store = memoryStore();
    const video = await copyBursts(`${movieName}.mkv`);
    const { url, requests } = await startTimings(store);
    const reference = fakeSource("Reference", [{ ref: "r", hashMatch: true, cues: spoken }]);

    await confirmFix(store, await videoKeyOf(video), spoken);

    const { code, output } = await run(
      ["fix", video, "--lang", "en", "--imdb", "tt0111161", "--audio", "--api", url],
      {
        sources: {
          listed: [fakeSource("Fake", [{ ref: "a", cues: lateSpoken }])],
          references: [reference],
        },
      },
    );

    expect(code).toBe(0);
    expect(output).toContain(
      `${detailLine("shared fix, confirmed", "-2.00 s · 2 agree · from audio")}\n`,
    );
    expect(output).toMatch(/\n {6}checked against the audio {3}contrast \d+\.\d\n/);
    expect(await cuesIn(join(work, `${movieName}.en.srt`))).toEqual(spoken);
    expect(reference.download).not.toHaveBeenCalled();
    expect(vi.mocked(alignToSpeech)).not.toHaveBeenCalled();
    expect(posts(requests)).toEqual([]);
  });

  it("writes an audio fix whose contrast clears 3.5 and shares nothing", async () => {
    const video = await copyBursts(`${movieName}.mkv`);
    const { url, requests } = await startTimings();

    const { code, output } = await run(
      ["fix", video, "--lang", "en", "--imdb", "tt0111161", "--audio", "--api", url],
      {
        sources: { listed: [fakeSource("Fake", [{ ref: "a", cues: lateSpoken }])], references: [] },
      },
    );

    expect(code).toBe(0);
    expect(output).toMatch(/\n {6}synced against the audio {4}-(1\.9|2\.0)\d s\n/);
    expect(output).toContain(
      `${detailLine("not shared", "audio check not reliable enough yet")}\n`,
    );
    expect(startsWithin(await cuesIn(join(work, `${movieName}.en.srt`)), spoken)).toBeLessThan(100);
    expect(posts(requests)).toEqual([]);
  });

  it("skips a subtitle whose contrast is under 1.5 and reports no mismatch", async () => {
    const video = await copyBursts(`${movieName}.mkv`);
    const { url, requests } = await startTimings();

    vi.mocked(alignToSpeech).mockResolvedValueOnce({
      kind: "aligned",
      cues: lateSpoken,
      score: 0.2,
      offsetScore: 0.2,
      speedRatio: 1,
      contrast: 1.1,
    });

    const { code, output } = await run(
      ["fix", video, "--lang", "en", "--imdb", "tt0111161", "--audio", "--api", url],
      {
        sources: {
          listed: [
            fakeSource("Fake", [
              { ref: "a", cues: lateSpoken, releaseName: "First" },
              { ref: "b", cues: otherSpoken, releaseName: "Second" },
            ]),
          ],
          references: [],
        },
      },
    );

    expect(code).toBe(0);
    expect(output).toContain("\n  en  Fake · Second\n");
    expect(output).toContain("\n  skipped     en · Fake · made for another video\n");
    expect((await cuesIn(join(work, `${movieName}.en.srt`)))[0]?.text).toBe("Other Line 0");
    expect(posts(requests)).toEqual([]);
  });

  it.each<[string, AudioAlignment, string]>([
    ["no speech", { kind: "no-speech" }, "no speech found"],
    [
      "speech in 95 % of the soundtrack",
      { kind: "implausible-speech", share: 0.95 },
      "not clear enough (speech in 95 % of the soundtrack)",
    ],
    ["a short clip", { kind: "too-short" }, "clip too short"],
    ["an empty subtitle", { kind: "empty-subtitle" }, "empty subtitle"],
    [
      "a contrast of 2.1",
      {
        kind: "aligned",
        cues: lateSpoken,
        score: 0.3,
        offsetScore: 0.3,
        speedRatio: 1,
        contrast: 2.1,
      },
      "not clear enough (contrast 2.1)",
    ],
  ])(
    "keeps the reference timing and says why audio was not used after %s",
    async (_, audio, reason) => {
      const video = await copyBursts(`${movieName}.mkv`);

      vi.mocked(alignToSpeech).mockResolvedValueOnce(audio);

      const { code, output } = await run(
        ["fix", video, "--lang", "en", "--imdb", "tt0111161", "--audio", "--private"],
        { sources: retimedSources() },
      );

      expect(code).toBe(0);
      expect(output).toContain(
        `${detailLine("retimed", "-2.00 s")}\n${detailLine("audio not used", reason)}\n`,
      );
      expect(await cuesIn(join(work, `${movieName}.en.srt`))).toEqual(track);
    },
  );

  it("says why audio was not used when ffmpeg cannot read the video", async () => {
    const video = await writeVideo(`${movieName}.mkv`);

    const { code, output } = await run(
      ["fix", video, "--lang", "en", "--imdb", "tt0111161", "--audio", "--private"],
      { sources: retimedSources() },
    );

    expect(code).toBe(0);
    expect(output).toMatch(/\n {6}audio not used {14}ffmpeg exited with code \d+: .+\n/);
    expect(vi.mocked(alignToSpeech)).not.toHaveBeenCalled();
  });

  it("makes no network call with --offline and aligns a local subtitle", async () => {
    const video = await copyBursts(`${movieName}.mkv`);
    const subtitle = join(work, "local.srt");
    const fetched = noNetwork();
    const source = fakeSource("Fake", []);

    await writeFile(subtitle, writeSRT(lateSpoken));
    vi.stubGlobal("fetch", fetched);

    const { code, output } = await run(
      ["fix", video, "--lang", "en", "--offline", "--audio", "--subtitle", subtitle],
      { sources: { listed: [source], references: [] } },
    );

    expect(code).toBe(0);
    expect(output).toContain("\n  subtitle    local.srt\n");
    expect(output).toContain(`${detailLine("not shared", "--offline")}\n`);
    expect(startsWithin(await cuesIn(join(work, `${movieName}.en.srt`)), spoken)).toBeLessThan(100);
    expect(fetched).not.toHaveBeenCalled();
    expect(source.search).not.toHaveBeenCalled();
  });
});

describe("writing", () => {
  it("never overwrites an existing subtitle", async () => {
    const video = await writeVideo(`${movieName}.mkv`);
    const args = ["fix", video, "--lang", "en", "--imdb", "tt0111161", "--private"];

    await writeFile(join(work, `${movieName}.en.srt`), "mine");

    const first = await run(args, { sources: retimedSources() });
    const second = await run(args, { sources: retimedSources() });

    expect(first.code).toBe(0);
    expect(first.output).toContain(`\n      wrote ${movieName}.en.subsontime.srt\n`);
    expect(await readFile(join(work, `${movieName}.en.srt`), "utf8")).toBe("mine");
    expect(await cuesIn(join(work, `${movieName}.en.subsontime.srt`))).toEqual(track);
    expect(second.code).toBe(1);
    expect(second.output).toContain(
      detailLine(
        "not written",
        `${movieName}.en.srt and ${movieName}.en.subsontime.srt already exist`,
      ),
    );
  });

  it("removes the reserved subtitle when the write fails", async () => {
    const video = await writeVideo(`${movieName}.mkv`);

    vi.mocked(rename).mockRejectedValueOnce(new Error("no space left on device"));

    const { code, output } = await run(
      ["fix", video, "--lang", "en", "--imdb", "tt0111161", "--private"],
      { sources: retimedSources() },
    );

    expect(code).toBe(1);
    expect(output).toContain(`${detailLine("not written", "no space left on device")}\n`);
    expect(await readdir(work)).toEqual([`${movieName}.mkv`]);
  });

  it("removes a write in flight when the run is stopped", async () => {
    const video = await writeVideo(`${movieName}.mkv`);

    vi.mocked(rename).mockImplementationOnce(() => new Promise(() => {}));

    void run(["fix", video, "--lang", "en", "--imdb", "tt0111161", "--private"], {
      sources: retimedSources(),
    });

    await vi.waitFor(async () => expect((await readdir(work)).length).toBe(3));

    abandonWrites();

    expect(await readdir(work)).toEqual([`${movieName}.mkv`]);
  });

  it("writes UTF-8 without a byte order mark into --out", async () => {
    const video = await writeVideo(`${movieName}.mkv`);
    const out = join(work, "out");

    await mkdir(out);
    await run(["fix", video, "--lang", "en", "--imdb", "tt0111161", "--private", "--out", out], {
      sources: retimedSources(),
    });

    const bytes = await readFile(join(out, `${movieName}.en.srt`));

    expect(bytes.subarray(0, 3)).toEqual(Buffer.from("1\n0"));
    expect(await readdir(out)).toEqual([`${movieName}.en.srt`]);
  });
});

describe("exit codes", () => {
  it("is 1 when no subtitle was written", async () => {
    const video = await writeVideo(`${movieName}.mkv`);

    const { code, output } = await run(
      ["fix", video, "--lang", "en", "--imdb", "tt0111161", "--private"],
      { sources: { listed: [fakeSource("Fake", [])], references: [] } },
    );

    expect(code).toBe(1);
    expect(output).toContain("\n  en  no subtitles found\n");
  });

  it("leaves the OpenSubtitles download limit alone without the OpenSubtitles source", async () => {
    const video = await writeVideo(`${movieName}.mkv`);

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ status: true, results: [] }))),
    );

    const { code, errors } = await run(
      ["fix", video, "--lang", "en", "--imdb", "tt0111161", "--private", "--sources", "subdl"],
      { env: { OPENSUBTITLES_DAILY_DOWNLOADS: "four", SUBDL_API_KEY: "key" } },
    );

    expect(errors).not.toContain("OPENSUBTITLES_DAILY_DOWNLOADS");
    expect(code).toBe(1);
  });

  it.each([
    [["fix"]],
    [["unknown"]],
    [["fix", "film.mkv", "--colour"]],
    [["fix", "film.mkv", "--offline", "--audio"]],
    [["fix", "film.mkv", "--offline", "--subtitle", "film.srt", "--lang", "en"]],
    [["fix", "film.mkv", "--subtitle", "film.srt", "--lang", "hr,en"]],
    [["fix", "film.mkv", "--imdb", "123"]],
    [["fix", "film.mkv", "--sources", "nowhere"]],
    [["fix", "folder", "--recursive", "--out", "folder"]],
  ])("is 2 for the usage error %j", async (argv) => {
    const { code, output, errors } = await run(argv);

    expect(code).toBe(2);
    expect(output).toBe("");
    expect(errors).toContain("Usage: subsontime fix");
  });

  it.each([[["--imdb", "tt0111161"]], [["--subtitle", "local.srt"]]])(
    "is 2 for %j with a folder",
    async (extra) => {
      await writeFile(join(work, "local.srt"), writeSRT(track));

      const { code, errors } = await run([
        "fix",
        work,
        "--lang",
        "en",
        "--private",
        ...extra.map((each) => (each === "local.srt" ? join(work, each) : each)),
      ]);

      expect(code).toBe(2);
      expect(errors).toContain("--imdb and --subtitle need one video, not a folder");
    },
  );

  it("is 3 when --audio is given and ffmpeg is missing", async () => {
    const video = await writeVideo(`${movieName}.mkv`);

    vi.stubEnv("SUBSONTIME_FFMPEG", join(work, "no-such-ffmpeg"));

    const { code, errors } = await run(["fix", video, "--lang", "en", "--audio", "--private"]);

    expect(code).toBe(3);
    expect(errors).toContain(missingFFmpeg);
  });

  it("is 3 with no network call for --offline when ffmpeg is missing", async () => {
    const video = await writeVideo(`${movieName}.mkv`);
    const subtitle = join(work, "local.srt");
    const fetched = noNetwork();

    await writeFile(subtitle, writeSRT(track));
    vi.stubGlobal("fetch", fetched);
    vi.stubEnv("SUBSONTIME_FFMPEG", join(work, "no-such-ffmpeg"));

    const { code } = await run([
      "fix",
      video,
      "--lang",
      "en",
      "--offline",
      "--audio",
      "--subtitle",
      subtitle,
    ]);

    expect(code).toBe(3);
    expect(fetched).not.toHaveBeenCalled();
  });

  it("is 1 with one line on stderr for an unexpected error", async () => {
    const folder = join(work, "locked");

    await mkdir(folder);
    await chmod(folder, 0o000);

    try {
      const { code, errors } = await run(["fix", folder, "--lang", "en", "--private"], {
        sources: retimedSources(),
      });

      expect(code).toBe(1);
      expect(errors).toMatch(/^subsontime: EACCES[^\n]*\n$/);
    } finally {
      await chmod(folder, 0o700);
    }
  });

  it("prints help and the version with 0", async () => {
    expect(await run(["--help"])).toEqual({
      code: 0,
      output: expect.stringContaining("subsontime fix <file-or-folder>"),
      errors: "",
    });
    expect(await run(["--version"])).toEqual({ code: 0, output: "0.0.0\n", errors: "" });
  });
});

describe("shareLinesFor", () => {
  it("says only that an audio pick is not shared when other fixes were", () => {
    expect(shareLinesFor(true, "on", { shared: true })).toEqual([
      { label: "not shared", value: "audio check not reliable enough yet", tone: "dim" },
    ]);
  });

  it("says that the other fixes were shared for a pick that is not from the audio", () => {
    expect(shareLinesFor(false, "on", { shared: true })).toEqual([
      { label: "shared with Open Timings", value: "numbers and fingerprints only", tone: "dim" },
    ]);
  });
});

describe("install id location", () => {
  it.each([
    ["linux", { XDG_CONFIG_HOME: "/xdg" }, "/xdg/subsontime"],
    ["linux", {}, "/home/someone/.config/subsontime"],
    ["darwin", {}, "/home/someone/Library/Application Support/subsontime"],
    [
      "win32",
      { APPDATA: "C:\\Users\\someone\\AppData\\Roaming" },
      "C:\\Users\\someone\\AppData\\Roaming\\subsontime",
    ],
    [
      "linux",
      { SUBSONTIME_CONFIG_DIR: "/config/subsontime", XDG_CONFIG_HOME: "/xdg" },
      "/config/subsontime",
    ],
    ["win32", { SUBSONTIME_CONFIG_DIR: "D:\\subsontime" }, "D:\\subsontime"],
  ] as const)("on %s with %j is %s", (platform, env, expected) => {
    expect(configDirOf(platform, env, "/home/someone")).toBe(expected);
  });

  it("falls back to a folder named after the user", () => {
    expect(fallbackConfigDir("/tmp", 911)).toBe("/tmp/subsontime-911");
  });

  it("keeps the install id in the config folder when it can", async () => {
    const configured = join(work, "config");
    const fallback = join(work, "fallback");
    const installId = await installIdFrom(configured, fallback);

    expect(await readFile(join(configured, "install-id"), "utf8")).toBe(installId);
    await expect(stat(fallback)).rejects.toThrow("ENOENT");
  });

  it("keeps the install id in the fallback folder when the home is read-only", async () => {
    const home = join(work, "home");
    const fallback = join(work, "fallback");

    await mkdir(home, { mode: 0o500 });

    const installId = await installIdFrom(join(home, ".config", "subsontime"), fallback);

    expect(installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readFile(join(fallback, "install-id"), "utf8")).toBe(installId);
    expect((await stat(fallback)).mode & 0o777).toBe(0o700);
    expect(await installIdFrom(join(home, ".config", "subsontime"), fallback)).toBe(installId);
  });

  it("refuses a fallback folder that other users can open", async () => {
    const home = join(work, "home");
    const fallback = join(work, "fallback");

    await mkdir(home, { mode: 0o500 });
    await mkdir(fallback);
    await chmod(fallback, 0o755);

    await expect(installIdFrom(join(home, "config"), fallback)).rejects.toThrow(
      "the fallback folder is open to other users",
    );
    expect(await readdir(fallback)).toEqual([]);
  });

  it("refuses a fallback that is not a folder of its own", async () => {
    const home = join(work, "home");
    const fallback = join(work, "fallback");

    await mkdir(home, { mode: 0o500 });
    await mkdir(join(work, "elsewhere"));
    await symlink(join(work, "elsewhere"), fallback);

    await expect(installIdFrom(join(home, "config"), fallback)).rejects.toThrow(
      "the fallback folder is not this user's",
    );
    expect(await readdir(join(work, "elsewhere"))).toEqual([]);
  });

  it("fails with the cause when no folder can be written", async () => {
    const home = join(work, "home");

    await mkdir(home, { mode: 0o500 });

    await expect(installIdFrom(join(home, "config"), undefined)).rejects.toThrow(
      expect.objectContaining({ code: "EACCES" }),
    );
  });
});

const boardSources = (): SourceSet => ({
  listed: [
    fakeSource("Fake", [
      { ref: "h", lang: "hrv", cues: shifted, releaseName: movieName },
      { ref: "e", cues: unrelated, releaseName: "Example.Movie.2024.720p.HDTV-OTHER" },
    ]),
  ],
  references: [fakeSource("Reference", [{ ref: "r", hashMatch: true, cues: track }])],
});

describe("summary", () => {
  it("follows the board: file, search, a block per language and one-line skips", async () => {
    const { url } = await startTimings();
    const video = await writeVideo(`${movieName}.mkv`);
    const { hash } = await videoKeyOf(video);

    const { output } = await run(
      ["fix", video, "--lang", "hr,en", "--imdb", "tt0111161", "--api", url],
      { sources: boardSources() },
    );

    expect(output.replace(/· \d+\.\d s/, "· <time>")).toBe(
      [
        `  file        ${hash} · 0.10 MB`,
        "  title       tt0111161",
        "  searching   Fake, Reference · <time>",
        "",
        `  hr  Fake · ${movieName}`,
        "      retimed                     -2.00 s",
        `      wrote ${movieName}.hr.srt`,
        "      shared with Open Timings    numbers and fingerprints only",
        "",
        "  en  no subtitle fits this file",
        "",
        "  skipped     en · Fake · made for another video",
        "",
        "",
      ].join("\n"),
    );
  });

  it("colors labels and values only when asked", async () => {
    const video = await writeVideo(`${movieName}.mkv`);

    const { output } = await run(
      ["fix", video, "--lang", "hr", "--imdb", "tt0111161", "--private"],
      { sources: boardSources(), color: true },
    );

    expect(output).toContain("\u001B[90m  file        \u001B[39m");
    expect(output).toContain("\u001B[33m  hr\u001B[39m  Fake");
    expect(output).toContain("retimed                     \u001B[33m-2.00 s\u001B[39m");
  });

  it("lists only the sources that answered", async () => {
    const video = await writeVideo(`${movieName}.mkv`);
    const failing = fakeSource("Down", []);

    failing.search.mockRejectedValue(new Error("offline"));

    const { output } = await run(
      ["fix", video, "--lang", "hr", "--imdb", "tt0111161", "--private"],
      { sources: { ...boardSources(), listed: [...boardSources().listed, failing] } },
    );

    expect(output).toMatch(/\n {2}searching {3}Fake, Reference · \d+\.\d s\n/);
  });

  it("shows when the cuts fall", async () => {
    const video = await writeVideo(`${movieName}.mkv`);
    const cut = transform(track, (time) => (time < 200_000 ? time + 2000 : time + 12_000));

    const { output } = await run(
      ["fix", video, "--lang", "en", "--imdb", "tt0111161", "--private"],
      {
        sources: {
          listed: [fakeSource("Fake", [{ ref: "a", cues: cut }])],
          references: [fakeSource("Reference", [{ ref: "r", hashMatch: true, cues: track }])],
        },
      },
    );

    expect(output).toMatch(/\n {6}retimed {21}-12\.00 s · cuts at 00:03:20\n/);
  });

  it("names each video when a folder holds several", async () => {
    await Promise.all([
      sized(join(work, "First.Film.2001.mkv"), 60_000_000),
      sized(join(work, "Second.Film.2002.mkv"), 60_000_000),
    ]);
    vi.stubGlobal("fetch", catalog([]));

    const { output } = await run(["fix", work, "--lang", "en", "--private"], {
      sources: retimedSources(),
    });

    expect(output).toMatch(/^First\.Film\.2001\.mkv\n {2}file {8}/);
    expect(output).toContain("\n\nSecond.Film.2002.mkv\n  file        ");
  });
});

describe("shiftText", () => {
  it("names the frame rates a 25 fps subtitle moves between", () => {
    const pal = transform(track, (time) => (time * 23.976) / 25);

    expect(shiftText(pal, track, 23.976 / 25, 25)).toBe("+0.00 s · 25 to 23.976");
  });
});
