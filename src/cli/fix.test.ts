import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { alignToSpeech, type AudioAlignment } from "../audio/align-audio.ts";
import { hasFFmpeg, writeBursts } from "../audio/test-video.ts";
import type { SourceSet } from "../sources/from-config.ts";
import { fakeSource } from "../sources/test-sources.ts";
import { appWith } from "../stremio/test-app.ts";
import type { Cue } from "../subtitles/cue.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import { writeSRT } from "../subtitles/write.ts";
import { syntheticTrack, transform } from "../timing/test-tracks.ts";
import { memoryStore, type TimingsStore } from "../timings/db.ts";
import { toFixCues } from "../timings/fingerprint.ts";
import { openSubtitlesHash } from "../video-hash.ts";
import { findVideos } from "./fix.ts";
import { identify } from "./identify.ts";
import { configDirOf } from "./install-id.ts";
import { main, type CliDeps } from "./main.ts";

vi.mock("../audio/align-audio.ts", { spy: true });
vi.mock("node:fs/promises", { spy: true });

type Recorded = { method: string; path: string; body: unknown };

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
const servers: { close: () => void }[] = [];
let work = "";
let configDir = "";

const startTimings = async (store: TimingsStore = memoryStore()) => {
  const app = appWith({ listed: [], references: [] }, store);
  const requests: Recorded[] = [];
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request: Request) => {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: request.method === "POST" ? await request.clone().json() : undefined,
      });

      return app.fetch(request);
    },
  });

  await once(server, "listening");
  servers.push(server);

  const { port } = server.address() as AddressInfo;

  return { url: `http://127.0.0.1:${port}`, requests, store };
};

const posts = (requests: Recorded[]) => requests.filter((request) => request.method === "POST");

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

const videoKeyOf = async (path: string) => {
  const bytes = await readFile(path);

  return {
    hash: await openSubtitlesHash(bytes.length, async (start, length) =>
      bytes.subarray(start, start + length),
    ),
    size: bytes.length,
  };
};

const confirmFix = async (
  store: TimingsStore,
  video: { hash: string; size: number },
  cues: Cue[],
) => {
  const fix = toFixCues(cues);
  const row = { video, subtitleHashes: fix.map((cue) => cue.h), cues: fix };

  await store.putFix({ ...row, method: "audio", submitter: "s1", origin: "o1" });
  await store.putFix({ ...row, method: "audio", submitter: "s2", origin: "o2" });
};

const retimedSources = (): SourceSet => ({
  listed: [fakeSource("Fake", [{ ref: "a", cues: shifted, releaseName: movieName }])],
  references: [fakeSource("Reference", [{ ref: "r", hashMatch: true, cues: track }])],
});

const run = async (argv: string[], deps: Partial<CliDeps> = {}) => {
  const printed: string[] = [];
  const code = await main(argv, {
    print: (text) => printed.push(text),
    env: {},
    configDir,
    locales: ["en-US"],
    ...deps,
  });

  return { code, output: printed.join("") };
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
  servers.splice(0).forEach((server) => server.close());
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("languages", () => {
  it("accepts ISO 639-1 and 639-2 codes", async () => {
    const { url } = await startTimings();
    const video = await writeVideo(`${movieName}.mkv`);
    const source = fakeSource("Fake", [
      { ref: "h", lang: "hrv", cues: track },
      { ref: "e", lang: "eng", cues: track },
    ]);

    const { code } = await run(
      ["fix", video, "--lang", "hr,eng", "--imdb", "tt0111161", "--private", "--api", url],
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
    const { url } = await startTimings();
    const video = await writeVideo(`${movieName}.mkv`);
    const source = fakeSource("Fake", []);

    await run(["fix", video, "--imdb", "tt0111161", "--api", url], {
      sources: { listed: [source], references: [] },
      locales: ["hr-HR"],
    });

    expect(source.search.mock.calls[0]?.[0].languages).toEqual(["hrv", "eng"]);
  });

  it("rejects an unknown language code", async () => {
    const video = await writeVideo(`${movieName}.mkv`);

    const { code, output } = await run(["fix", video, "--lang", "xx", "--offline"]);

    expect(code).toBe(2);
    expect(output).toContain("Unknown language code xx");
  });
});

describe("findVideos", () => {
  it("walks a folder one level deep and skips samples and small files", async () => {
    await mkdir(join(work, "Extras"));
    await Promise.all([
      sized(join(work, "Film.2001.1080p.mkv"), 60_000_000),
      sized(join(work, "Film.2001.1080p.Sample.mkv"), 60_000_000),
      sized(join(work, "Short.2001.mp4"), 1000),
      sized(join(work, "notes.txt"), 60_000_000),
      sized(join(work, "Show.S01E02.webm"), 60_000_000),
      sized(join(work, "Extras", "Inside.mkv"), 60_000_000),
    ]);

    expect(await findVideos(work, false)).toEqual([
      join(work, "Film.2001.1080p.mkv"),
      join(work, "Show.S01E02.webm"),
    ]);
    expect(await findVideos(work, true)).toEqual([
      join(work, "Extras", "Inside.mkv"),
      join(work, "Film.2001.1080p.mkv"),
      join(work, "Show.S01E02.webm"),
    ]);
  });

  it("keeps a named file whatever its size", async () => {
    const video = await writeVideo("tiny.mkv", 10);

    expect(await findVideos(video, false)).toEqual([video]);
  });
});

describe("identify", () => {
  it("finds a film by its cleaned name and year", async () => {
    const fetched = catalog([
      { id: "tt0316396", name: "Peter Pan", releaseInfo: "2003" },
      { id: "tt0046183", name: "Peter Pan", releaseInfo: "1953" },
    ]);

    vi.stubGlobal("fetch", fetched);

    expect(await identify("Peter.Pan.1953.1080p.BluRay.x264.YIFY.mp4")).toEqual({
      type: "movie",
      imdbId: "tt0046183",
    });
    expect(String(fetched.mock.calls[0]?.[0])).toBe(
      "https://v3-cinemeta.strem.io/catalog/movie/top/search=Peter%20Pan.json",
    );
  });

  it("finds an episode by its series name", async () => {
    const fetched = catalog([{ id: "tt0903747", name: "Example Show", releaseInfo: "2008-2013" }]);

    vi.stubGlobal("fetch", fetched);

    expect(await identify("Example.Show.S01E02.720p.HDTV.x264-GROUP.mkv")).toEqual({
      type: "series",
      imdbId: "tt0903747",
      season: 1,
      episode: 2,
    });
    expect(String(fetched.mock.calls[0]?.[0])).toBe(
      "https://v3-cinemeta.strem.io/catalog/series/top/search=Example%20Show.json",
    );
  });

  it("skips a file whose title is not in the catalog", async () => {
    const { url } = await startTimings();
    const video = await writeVideo("Unknown.Title.2024.1080p.mkv");

    vi.stubGlobal("fetch", catalog([{ id: "tt1", name: "Something Else", releaseInfo: "2024" }]));

    const { code, output } = await run(["fix", video, "--lang", "en", "--api", url], {
      sources: retimedSources(),
    });

    expect(code).toBe(1);
    expect(output).toContain("Skipped      Could not identify this title");
  });
});

describe("Open Timings", () => {
  it("shares a retimed fix and reuses one install id created with mode 0600", async () => {
    const { url, requests } = await startTimings();
    const video = await writeVideo(`${movieName}.mkv`);
    const args = ["fix", video, "--lang", "en", "--imdb", "tt0111161", "--api", url];

    await run(args, { sources: retimedSources() });
    await rm(join(work, `${movieName}.en.srt`));
    await run(args, { sources: retimedSources() });

    const installIdFile = join(configDir, "install-id");
    const installId = await readFile(installIdFile, "utf8");
    const sent = posts(requests);

    expect((await stat(installIdFile)).mode & 0o777).toBe(0o600);
    expect(installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.map((request) => request.path)).toEqual(["/api/v1/fixes", "/api/v1/fixes"]);
    expect(sent.map((request) => request.body)).toEqual([
      expect.objectContaining({ method: "reference", installId }),
      expect.objectContaining({ method: "reference", installId }),
    ]);
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
    expect(output).toContain("Not shared (--private)");
    await expect(stat(join(configDir, "install-id"))).rejects.toThrow("ENOENT");
  });

  it("keeps going when Open Timings does not answer", async () => {
    const video = await writeVideo(`${movieName}.mkv`);

    const { code, output } = await run(
      ["fix", video, "--lang", "en", "--imdb", "tt0111161", "--api", "http://127.0.0.1:1"],
      { sources: retimedSources() },
    );

    expect(code).toBe(0);
    expect(output).toContain("Not shared, Open Timings did not answer");
  });
});

describe.skipIf(!hasFFmpeg)("with ffmpeg", () => {
  it("applies a confirmed shared fix without alignment or references", async () => {
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
    expect(output).toContain("Shared fix, confirmed · 2 agree · from audio");
    expect(output).toContain(
      "Shared fix, confirmed · 2 agree · from audio\n               audio not used: confirmed shared fix\n",
    );
    expect(await cuesIn(join(work, `${movieName}.en.srt`))).toEqual(spoken);
    expect(reference.download).not.toHaveBeenCalled();
    expect(vi.mocked(alignToSpeech)).not.toHaveBeenCalled();
    expect(posts(requests)).toEqual([]);
  });

  it("writes and shares an audio fix whose contrast clears 3.5", async () => {
    const video = await copyBursts(`${movieName}.mkv`);
    const { url, requests } = await startTimings();

    const { code, output } = await run(
      ["fix", video, "--lang", "en", "--imdb", "tt0111161", "--audio", "--api", url],
      {
        sources: { listed: [fakeSource("Fake", [{ ref: "a", cues: lateSpoken }])], references: [] },
      },
    );

    expect(code).toBe(0);
    expect(output).toMatch(/Aligned to the soundtrack · -(1\.9|2\.0)\d s · contrast \d+\.\d/);
    expect(startsWithin(await cuesIn(join(work, `${movieName}.en.srt`)), spoken)).toBeLessThan(100);
    expect(posts(requests)).toEqual([
      expect.objectContaining({
        path: "/api/v1/fixes",
        body: expect.objectContaining({ method: "audio" }),
      }),
    ]);
  });

  it("skips a subtitle whose contrast is under 1.5 and reports it as a mismatch", async () => {
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
    expect(output).toContain("English · Fake · First");
    expect(output).toContain(
      "Made for another video. Its dialogue does not line up with the soundtrack.",
    );
    expect((await cuesIn(join(work, `${movieName}.en.srt`)))[0]?.text).toBe("Other Line 0");
    expect(posts(requests).map((request) => request.path)).toEqual([
      "/api/v1/mismatches",
      "/api/v1/fixes",
    ]);
  });

  it.each<[string, AudioAlignment, string]>([
    ["no speech", { kind: "no-speech" }, "audio not used: no speech found"],
    ["a short clip", { kind: "too-short" }, "audio not used: clip too short"],
    ["an empty subtitle", { kind: "empty-subtitle" }, "audio not used: empty subtitle"],
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
      "audio not used: not clear enough (contrast 2.1)",
    ],
  ])(
    "keeps the reference timing and says why audio was not used after %s",
    async (_, audio, note) => {
      const video = await copyBursts(`${movieName}.mkv`);

      vi.mocked(alignToSpeech).mockResolvedValueOnce(audio);

      const { code, output } = await run(
        ["fix", video, "--lang", "en", "--imdb", "tt0111161", "--audio", "--private"],
        { sources: retimedSources() },
      );

      expect(code).toBe(0);
      expect(output).toContain(`               Retimed · -2.00 s\n               ${note}\n`);
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
    expect(output).toMatch(/\n {15}audio not used: ffmpeg exited with code \d+: .+\n/);
    expect(vi.mocked(alignToSpeech)).not.toHaveBeenCalled();
  });

  it("makes no network call with --offline and aligns a local subtitle", async () => {
    const video = await copyBursts(`${movieName}.mkv`);
    const subtitle = join(work, "local.srt");
    const fetched = vi.fn<typeof fetch>(async () => {
      throw new Error("No network");
    });
    const source = fakeSource("Fake", []);

    await writeFile(subtitle, writeSRT(lateSpoken));
    vi.stubGlobal("fetch", fetched);

    const { code, output } = await run(
      ["fix", video, "--lang", "en", "--offline", "--audio", "--subtitle", subtitle],
      { sources: { listed: [source], references: [] } },
    );

    expect(code).toBe(0);
    expect(output).toContain("Not shared (--offline)");
    expect(startsWithin(await cuesIn(join(work, `${movieName}.en.srt`)), spoken)).toBeLessThan(100);
    expect(fetched).not.toHaveBeenCalled();
    expect(source.search).not.toHaveBeenCalled();
  });
});

describe("writing", () => {
  it("never overwrites an existing subtitle", async () => {
    const { url } = await startTimings();
    const video = await writeVideo(`${movieName}.mkv`);
    const args = ["fix", video, "--lang", "en", "--imdb", "tt0111161", "--private", "--api", url];

    await writeFile(join(work, `${movieName}.en.srt`), "mine");

    const first = await run(args, { sources: retimedSources() });
    const second = await run(args, { sources: retimedSources() });

    expect(first.code).toBe(0);
    expect(first.output).toContain(`Wrote ${movieName}.en.subsontime.srt`);
    expect(await readFile(join(work, `${movieName}.en.srt`), "utf8")).toBe("mine");
    expect(await cuesIn(join(work, `${movieName}.en.subsontime.srt`))).toEqual(track);
    expect(second.code).toBe(1);
    expect(second.output).toContain(
      `Not written: ${movieName}.en.srt and ${movieName}.en.subsontime.srt already exist`,
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
    expect(output).toContain("               Not written: no space left on device\n");
    expect(await readdir(work)).toEqual([`${movieName}.mkv`]);
  });

  it("writes UTF-8 without a byte order mark into --out", async () => {
    const { url } = await startTimings();
    const video = await writeVideo(`${movieName}.mkv`);
    const out = join(work, "out");

    await mkdir(out);
    await run(
      [
        "fix",
        video,
        "--lang",
        "en",
        "--imdb",
        "tt0111161",
        "--private",
        "--api",
        url,
        "--out",
        out,
      ],
      { sources: retimedSources() },
    );

    const bytes = await readFile(join(out, `${movieName}.en.srt`));

    expect(bytes.subarray(0, 3)).toEqual(Buffer.from("1\n0"));
    expect(await readdir(out)).toEqual([`${movieName}.en.srt`]);
  });
});

describe("exit codes", () => {
  it("is 1 when no subtitle was written", async () => {
    const { url } = await startTimings();
    const video = await writeVideo(`${movieName}.mkv`);

    const { code, output } = await run(
      ["fix", video, "--lang", "en", "--imdb", "tt0111161", "--api", url],
      { sources: { listed: [fakeSource("Fake", [])], references: [] } },
    );

    expect(code).toBe(1);
    expect(output).toContain("English      No subtitles found");
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
  ])("is 2 for the usage error %j", async (argv) => {
    expect((await run(argv)).code).toBe(2);
  });

  it("is 3 when --audio is given and ffmpeg is missing", async () => {
    const video = await writeVideo(`${movieName}.mkv`);

    vi.stubEnv("SUBSONTIME_FFMPEG", join(work, "no-such-ffmpeg"));

    const { code, output } = await run(["fix", video, "--lang", "en", "--audio", "--private"]);

    expect(code).toBe(3);
    expect(output).toContain(missingFFmpeg);
  });

  it("prints help and the version with 0", async () => {
    expect(await run(["--help"])).toEqual({
      code: 0,
      output: expect.stringContaining("subsontime fix <file-or-folder>"),
    });
    expect(await run(["--version"])).toEqual({ code: 0, output: "0.0.0\n" });
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
  ] as const)("on %s with %j is %s", (platform, env, expected) => {
    expect(configDirOf(platform, env, "/home/someone")).toBe(expected);
  });
});

describe("summary", () => {
  it("prints the fingerprint, the search, each language and what was skipped", async () => {
    const { url } = await startTimings();
    const video = await writeVideo(`${movieName}.mkv`);
    const { hash } = await videoKeyOf(video);

    const { output } = await run(
      ["fix", video, "--lang", "hr,en", "--imdb", "tt0111161", "--api", url],
      {
        sources: {
          listed: [
            fakeSource("Fake", [
              { ref: "h", lang: "hrv", cues: shifted, releaseName: movieName },
              { ref: "e", cues: unrelated, releaseName: "Example.Movie.2024.720p.HDTV-OTHER" },
            ]),
          ],
          references: [fakeSource("Reference", [{ ref: "r", hashMatch: true, cues: track }])],
        },
      },
    );

    expect(output.replace(/in \d+\.\d s/, "in <time>")).toBe(
      [
        `${movieName}.mkv`,
        `  Fingerprint  ${hash} · 0.10 MB`,
        "  Searched     2 sources in <time>",
        `  Hrvatski     Fake · ${movieName}`,
        "               Retimed · -2.00 s",
        `               Wrote ${movieName}.hr.srt`,
        "               Shared with Open Timings",
        "  English      No subtitle fits this file",
        "  Skipped      English · Fake · Example.Movie.2024.720p.HDTV-OTHER",
        "               Made for another video. Its dialogue does not line up with this file anywhere.",
        "",
        "",
      ].join("\n"),
    );
  });
});
