import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import packageJSON from "../../package.json" with { type: "json" };
import gilmoreFixture from "../../test/fixtures/subtitles/gilmore-s05e17.json" with { type: "json" };
import familyFixture from "../../test/fixtures/subtitles/act-breaks-s01e24.json" with { type: "json" };
import restHashFixture from "../../test/fixtures/sources/opensubtitles-rest-hash-search.json" with { type: "json" };
import v3HashFixture from "../../test/fixtures/sources/opensubtitles-v3-hash-movie.json" with { type: "json" };
import { createApp, type AppDeps } from "../app.ts";
import type { Config } from "../config/config.ts";
import { defaultConfig } from "../config/default-config.ts";
import { seal } from "../config/seal.ts";
import { sourcesFromConfig, type SourceSet } from "../sources/from-config.ts";
import type { Source, VideoQuery } from "../sources/source.ts";
import { fakeSource, memoryTokenCache, type Entry } from "../sources/test-sources.ts";
import { memorySharedState } from "../jobs/shared-state.ts";
import { memorySingleFlight } from "../jobs/single-flight.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import { writeSRT } from "../subtitles/write.ts";
import { median, retime } from "../timing/retime.ts";
import { syntheticTrack, transform } from "../timing/test-tracks.ts";
import { decodeRef, encodeRef, refKey, type SubtitleRef } from "./refs.ts";

vi.mock("../timing/retime.ts", { spy: true });

type Listing = { subtitles: { id: string; lang: string; label: string; url: string }[] };

const secret = "a-test-secret-that-is-long-enough-1234";
const fileName = "Movie.2024.1080p.BluRay.x264-GROUP.mkv";
const track = syntheticTrack(1, 200);
const shifted = transform(track, (time) => time + 2000);
const unrelated = syntheticTrack(2, 200).map((cue) => ({ ...cue, text: `Wrong ${cue.text}` }));

const sealed = (overrides: Partial<Config> = {}) =>
  seal({ ...defaultConfig(["eng"]), ...overrides }, secret);

const appWith = (sources: SourceSet, deps: Partial<AppDeps> = {}) =>
  createApp({ secret, sourcesFor: () => sources, ...deps });

const list = async (app: ReturnType<typeof appWith>, token: string, path: string) => {
  const response = await app.request(`/${token}/subtitles/${path}`);

  return { response, body: (await response.json()) as Listing };
};

const refOf = (url: string) =>
  decodeRef(
    new URL(url).pathname
      .split("/")
      .at(-1)
      ?.replace(/\.srt$/, "") ?? "",
    refKey(secret),
  );

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("manifest", () => {
  it("describes the addon for a valid install link", async () => {
    const response = await appWith({ listed: [], references: [] }).request(
      `/${sealed()}/manifest.json`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual({
      id: "com.subsontime",
      version: packageJSON.version,
      name: "Subs On Time",
      description: "Subtitles that fit the file you are playing.",
      resources: ["subtitles"],
      types: ["movie", "series"],
      idPrefixes: ["tt"],
      catalogs: [],
      behaviorHints: { configurable: true, configurationRequired: false },
      logo: "http://localhost/logo.png",
    });
  });

  it("rejects a tampered install link without echoing it", async () => {
    const token = sealed();
    const tampered = `${token.slice(0, 20)}${token[20] === "A" ? "B" : "A"}${token.slice(21)}`;

    const response = await appWith({ listed: [], references: [] }).request(
      `/${tampered}/manifest.json`,
    );
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(JSON.parse(text)).toEqual({ error: "This install link is not valid. Set up again." });
    expect(text).not.toContain(tampered);
  });

  it("rejects an install link from a newer version", async () => {
    const token = Buffer.from([2, ...Array.from({ length: 40 }, () => 0)]).toString("base64url");

    const response = await appWith({ listed: [], references: [] }).request(
      `/${token}/manifest.json`,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "This install link is from a newer version" });
  });

  it("keeps the health route", async () => {
    const response = await appWith({ listed: [], references: [] }).request("/health");

    expect(await response.json()).toEqual({ ok: true });
  });

  it("answers 404 for a path that is not an install link", async () => {
    const response = await appWith({ listed: [], references: [] }).request("/nope");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("Not found");
  });

  it("treats a long base64url segment as an install link", async () => {
    const response = await appWith({ listed: [], references: [] }).request(`/${"A".repeat(60)}`);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "This install link is not valid. Set up again.",
    });
  });
});

describe("subtitle list", () => {
  it("rejects an unsupported video id", async () => {
    const { response, body } = await list(
      appWith({ listed: [], references: [] }),
      sealed(),
      "movie/kitsu:1.json",
    );

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "Unsupported video id" });
  });

  it.each([
    ["encoded", "videoHash%3Dabc%26videoSize%3D123%26filename%3DMovie%2526Co.mkv"],
    ["plain", "videoHash=abc&videoSize=123&filename=Movie%26Co.mkv"],
  ])("reads %s extras", async (_, extra) => {
    const source = fakeSource("Fake", []);

    await list(
      appWith({ listed: [source], references: [] }),
      sealed(),
      `movie/tt0111161/${extra}.json`,
    );

    expect(source.search.mock.calls[0]?.[0]).toEqual({
      type: "movie",
      imdbId: "tt0111161",
      videoHash: "abc",
      videoSize: 123,
      filename: "Movie&Co.mkv",
      languages: ["eng"],
    });
  });

  it.each([["tt0903747:1:2"], ["tt0903747%3A1%3A2"]])("reads the series id %s", async (id) => {
    const source = fakeSource("Fake", []);

    await list(appWith({ listed: [source], references: [] }), sealed(), `series/${id}.json`);

    expect(source.search.mock.calls[0]?.[0]).toMatchObject({
      type: "series",
      imdbId: "tt0903747",
      season: 1,
      episode: 2,
    });
  });

  it("lists every candidate without a hash or filename and serves each as it came", async () => {
    const source = fakeSource("Fake", [
      { ref: "a", cues: track },
      { ref: "b", cues: shifted },
    ]);
    const app = appWith({ listed: [source], references: [] });

    const { response, body } = await list(app, sealed({ bestOnly: false }), "movie/tt0111161.json");

    const served = await Promise.all(body.subtitles.map((entry) => app.request(entry.url)));

    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(body.subtitles.map((entry) => [entry.id, entry.lang])).toEqual([
      ["eng-1", "eng"],
      ["eng-2", "eng"],
    ]);
    expect(served.map((file) => file.headers.get("content-type"))).toEqual([
      "application/x-subrip; charset=utf-8",
      "application/x-subrip; charset=utf-8",
    ]);
    expect(served[0]?.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(await Promise.all(served.map((file) => file.text()))).toEqual([
      writeSRT(track),
      writeSRT(shifted),
    ]);
  });

  it("lists one best entry per language in the configured order", async () => {
    const source = fakeSource("Fake", [
      { ref: "e", lang: "eng" },
      { ref: "f", lang: "fra" },
      { ref: "h", lang: "hrv" },
    ]);

    const { body } = await list(
      appWith({ listed: [source], references: [] }),
      sealed({ languages: ["hrv", "eng"] }),
      "movie/tt0111161.json",
    );

    expect(body.subtitles.map((entry) => [entry.id, entry.lang])).toEqual([
      ["hrv-best", "hrv"],
      ["eng-best", "eng"],
    ]);
  });

  it("labels each candidate with its source and keeps the language code", async () => {
    const api = fakeSource("OpenSubtitles API", [{ ref: "hash", hashMatch: true }]);
    const subdl = fakeSource("SubDL", [{ ref: "plain" }]);
    const addon = fakeSource("subs.example.com", [{ ref: "addon" }]);

    const { body } = await list(
      appWith({ listed: [api, subdl, addon], references: [] }),
      sealed({ bestOnly: false }),
      "movie/tt0111161.json",
    );

    expect(body.subtitles.map((entry) => [entry.lang, entry.label])).toEqual([
      ["eng", "OpenSubtitles (made for this file)"],
      ["eng", "SubDL"],
      ["eng", "subs.example.com"],
    ]);
  });

  it.each([
    [[{ ref: "a", hashMatch: true }], [{ ref: "b" }], "OpenSubtitles, SubDL"],
    [[{ ref: "a", hashMatch: true }], [], "OpenSubtitles (made for this file)"],
    [[{ ref: "a" }, { ref: "b" }], [], "OpenSubtitles"],
  ])("labels a best entry with every source it can fall back to", async (open, subdl, label) => {
    const { body } = await list(
      appWith({
        listed: [fakeSource("OpenSubtitles", open), fakeSource("SubDL", subdl)],
        references: [],
      }),
      sealed(),
      "movie/tt0111161.json",
    );

    expect(body.subtitles.map((entry) => entry.label)).toEqual([label]);
  });

  it("lists at most ten candidates per language", async () => {
    const source = fakeSource(
      "Fake",
      Array.from({ length: 12 }, (_, index) => ({ ref: `r${index}` })),
    );

    const { body } = await list(
      appWith({ listed: [source], references: [] }),
      sealed({ bestOnly: false }),
      "movie/tt0111161.json",
    );

    expect(body.subtitles.map((entry) => entry.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `eng-${index + 1}`),
    );
  });

  it.each([
    [{ publicURL: "https://subs.example.com" }, {}, "https://subs.example.com/"],
    [
      {},
      { "x-forwarded-proto": "https", "x-forwarded-host": "proxy.example.com" },
      "https://proxy.example.com/",
    ],
    [{}, { "x-forwarded-proto": "https" }, "http://localhost/"],
    [
      {},
      { "x-forwarded-proto": "https, http", "x-forwarded-host": "edge.example.com, internal" },
      "https://edge.example.com/",
    ],
  ])("builds subtitle URLs from %o and headers %o", async (deps, headers, base) => {
    const token = sealed();
    const response = await appWith(
      { listed: [fakeSource("Fake", [{ ref: "a" }])], references: [] },
      deps,
    ).request(`/${token}/subtitles/movie/tt0111161.json`, { headers });
    const body = (await response.json()) as Listing;

    expect(body.subtitles[0]?.url.startsWith(`${base}${token}/sub/`)).toBe(true);
  });

  it("puts hash matches first, then the closest release, and keeps four in a slot", async () => {
    const source = fakeSource("Fake", [
      { ref: "plain" },
      { ref: "close", releaseName: "Movie.2024.1080p.BluRay.x264-GROUP" },
      { ref: "partial", releaseName: "Movie.2024.720p.BluRay.x264-OTHER" },
      { ref: "hash", hashMatch: true },
      { ref: "last" },
    ]);

    const { body } = await list(
      appWith({ listed: [source], references: [] }),
      sealed(),
      `movie/tt0111161/filename=${fileName}.json`,
    );

    expect(refOf(body.subtitles[0]?.url ?? "").c.map((candidate) => candidate.r)).toEqual([
      "hash",
      "close",
      "partial",
      "plain",
    ]);
  });

  it("carries reference-only candidates in the refs but never lists them", async () => {
    const listed = fakeSource("Fake", [{ ref: "a" }]);
    const references = fakeSource("Reference", [{ ref: "r", hashMatch: true }]);

    const { body } = await list(
      appWith({ listed: [listed], references: [references] }),
      sealed({ bestOnly: false }),
      "movie/tt0111161.json",
    );

    expect(body.subtitles).toHaveLength(1);
    expect(refOf(body.subtitles[0]?.url ?? "")).toEqual({
      v: 1,
      q: { t: "movie", i: "tt0111161" },
      c: [{ n: "Fake", r: "a", l: "eng" }],
      x: [{ n: "Reference", r: "r", l: "eng", h: 1 }],
    });
  });
});

const firstSlot = async (sources: SourceSet, overrides: Partial<Config> = {}) => {
  const app = appWith(sources);
  const { body } = await list(app, sealed(overrides), "movie/tt0111161.json");

  return { app, url: body.subtitles[0]?.url ?? "" };
};

const mismatchSources = () => ({
  listed: [
    fakeSource("Fake", [
      { ref: "wrong", cues: unrelated },
      { ref: "right", cues: shifted },
    ]),
  ],
  references: [fakeSource("Reference", [{ ref: "r", hashMatch: true, cues: track }])],
});

describe("subtitle file", () => {
  it("serves the next candidate when the first is a mismatch", async () => {
    const { app, url } = await firstSlot(mismatchSources());

    const response = await app.request(url);
    const cues = parseSubtitle(await response.text());

    expect(response.status).toBe(200);
    expect(cues[0]?.text).toBe("Line 0");
    expect(Math.abs((cues[0]?.start ?? 0) - (track[0]?.start ?? 0))).toBeLessThan(200);
  });

  it("serves a mismatch as it came when mismatches are not hidden", async () => {
    const { app, url } = await firstSlot(mismatchSources(), {
      extras: { ...defaultConfig(["eng"]).extras, hideMismatches: false },
    });

    const response = await app.request(url);

    expect(await response.text()).toBe(writeSRT(unrelated));
  });

  it("answers 404 when nothing in a best slot fits", async () => {
    const sources = {
      listed: [fakeSource("Fake", [{ ref: "wrong", cues: unrelated }])],
      references: [fakeSource("Reference", [{ ref: "r", hashMatch: true, cues: track }])],
    };
    const { app, url } = await firstSlot(sources);

    const response = await app.request(url);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("No subtitle fits this file");
  });

  it("answers an empty 200 for a single candidate that is a mismatch", async () => {
    const { app, url } = await firstSlot(mismatchSources(), { bestOnly: false });

    const response = await app.request(url);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("serves the subtitle without retiming when timing is off", async () => {
    const sources = mismatchSources();
    const { app, url } = await firstSlot(sources, { timing: "off" });

    const response = await app.request(url);

    expect(await response.text()).toBe(writeSRT(unrelated));
    expect(vi.mocked(retime)).not.toHaveBeenCalled();
    expect(sources.references[0]?.download).not.toHaveBeenCalled();
  });

  it("downloads once for two concurrent requests of one file", async () => {
    const source = fakeSource("Fake", [{ ref: "a", cues: track }]);
    const { app, url } = await firstSlot({ listed: [source], references: [] });

    const responses = await Promise.all([app.request(url), app.request(url)]);

    expect(await Promise.all(responses.map((response) => response.text()))).toEqual([
      writeSRT(track),
      writeSRT(track),
    ]);
    expect(source.download).toHaveBeenCalledTimes(1);
  });

  it("falls through to the next candidate when a download fails", async () => {
    const source = fakeSource("Fake", [{ ref: "broken" }, { ref: "a", cues: track }]);
    const { app, url } = await firstSlot({ listed: [source], references: [] });

    source.download.mockClear();

    const response = await app.request(url);

    expect(await response.text()).toBe(writeSRT(track));
    expect(source.download.mock.calls.map(([ref]) => ref)).toEqual(["broken", "a"]);
  });

  it("serves a hash match without waiting for the references", async () => {
    const { app, url } = await firstSlot({
      listed: [fakeSource("Fake", [{ ref: "a", hashMatch: true, cues: shifted }])],
      references: [fakeSource("Reference", [{ ref: "r", hashMatch: true, hang: true }])],
    });

    const response = await app.request(url);

    expect(await response.text()).toBe(writeSRT(shifted));
  });

  it("leaves the references alone when a hash match comes first", async () => {
    const sources = {
      listed: [fakeSource("Fake", [{ ref: "a", hashMatch: true, cues: shifted }])],
      references: [fakeSource("Reference", [{ ref: "r", hashMatch: true, cues: track }])],
    };
    const { app, url } = await firstSlot(sources);

    await app.request(url);

    expect(sources.references[0]?.download).not.toHaveBeenCalled();
  });

  it("downloads a candidate that is also a reference once", async () => {
    const source = fakeSource("Fake", [{ ref: "a", hashMatch: true, cues: track }]);
    const { app, url } = await firstSlot({ listed: [source], references: [] });

    expect(refOf(url).x.map((reference) => reference.r)).toEqual(["a"]);

    await app.request(url);

    expect(source.download).toHaveBeenCalledTimes(1);
  });

  it("falls through to the next candidate when retiming throws", async () => {
    vi.mocked(retime).mockRejectedValueOnce(new Error("Alignment failed"));

    const { app, url } = await firstSlot(mismatchSources());

    const response = await app.request(url);
    const cues = parseSubtitle(await response.text());

    expect(response.status).toBe(200);
    expect(cues[0]?.text).toBe("Line 0");
    expect(vi.mocked(retime)).toHaveBeenCalledTimes(2);
  });

  it("rejects a reference that does not decode", async () => {
    const response = await appWith({ listed: [], references: [] }).request(
      `/${sealed()}/sub/garbage.srt`,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("Invalid subtitle reference");
  });

  it("never fetches an unsigned or foreign-signed reference", async () => {
    const hits: string[] = [];
    const listener = createServer((request, response) => {
      hits.push(request.url ?? "");
      response.end(writeSRT(track));
    });

    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));

    const { port } = listener.address() as AddressInfo;

    const forged: SubtitleRef = {
      v: 1,
      q: { t: "movie", i: "tt0111161" },
      c: [{ n: "OpenSubtitles", r: `http://127.0.0.1:${port}/internal`, l: "eng" }],
      x: [],
    };
    const app = createApp({ secret });
    const token = sealed();

    try {
      const responses = await Promise.all(
        [
          Buffer.from(JSON.stringify(forged)).toString("base64url"),
          encodeRef(forged, refKey("another-secret-that-is-long-enough-12345")),
          encodeRef(forged, refKey(secret)),
        ].map((ref) => app.request(`/${token}/sub/${ref}.srt`)),
      );

      expect(responses.map((response) => response.status)).toEqual([400, 400, 404]);
    } finally {
      listener.close();
    }

    expect(hits).toEqual([]);
  });
});

const matchedByHash = new Map([
  ["3e0c5471cdc9cb0e", "disc"],
  ["0123456789abcdef", "broadcast"],
]);

const hashAware = (): SourceSet => {
  const source = fakeSource("Fake", [
    { ref: "broadcast", cues: shifted },
    { ref: "disc", cues: track },
  ]);

  return {
    listed: [
      {
        ...source,
        search: async (query, signal) =>
          (await source.search(query, signal)).map((candidate) => ({
            ...candidate,
            hashMatch: matchedByHash.get(query.videoHash ?? "") === candidate.ref,
          })),
      },
    ],
    references: [],
  };
};

describe("a hash from the other listing", () => {
  const episode = "series/tt1442437:1:23";
  const name = "Modern Family S01E23 Hawaii  (1080p x265 10bit Joy).mkv";
  const withoutHash = `${episode}/filename=${encodeURIComponent(name)}.json`;
  const withHash = `${episode}/filename=${encodeURIComponent(name)}&videoSize=227584187&videoHash=3e0c5471cdc9cb0e.json`;
  const otherRelease = `${episode}/filename=${encodeURIComponent(name)}&videoSize=227584188&videoHash=0123456789abcdef.json`;

  it("serves the hash match from a listing that came before the hash", async () => {
    const app = appWith(hashAware());
    const token = sealed();

    const first = await list(app, token, withoutHash);

    await list(app, token, withHash);

    const response = await app.request(first.body.subtitles[0]?.url ?? "");

    expect(response.status).toBe(200);
    expect(parseSubtitle(await response.text())).toEqual(track);
    expect(retime).not.toHaveBeenCalled();
  });

  it("lists the hash match without the hash once the other listing brought it", async () => {
    const app = appWith(hashAware());
    const token = sealed();

    await list(app, token, withHash);

    const { body } = await list(app, token, withoutHash);

    const ref = refOf(body.subtitles[0]?.url ?? "");

    expect(ref.c).toEqual([
      { n: "Fake", r: "disc", l: "eng" },
      { n: "Fake", r: "broadcast", l: "eng" },
    ]);
    expect(ref.w).toBeUndefined();
  });

  it("serves the newest release when another one with the same name came first", async () => {
    const app = appWith(hashAware());
    const token = sealed();

    await list(app, token, withHash);

    const second = await list(app, token, withoutHash);

    await list(app, token, otherRelease);

    const response = await app.request(second.body.subtitles[0]?.url ?? "");

    expect(parseSubtitle(await response.text())).toEqual(shifted);
    expect(retime).not.toHaveBeenCalled();
  });

  it("keeps the hash to the install that listed it", async () => {
    const app = appWith(hashAware());

    await list(app, sealed(), withHash);
    const { body } = await list(app, sealed(), withoutHash);

    expect(refOf(body.subtitles[0]?.url ?? "").c[0]?.r).toBe("broadcast");
  });
});

const timed = (spans: number[][]) =>
  spans.map(([start = 0, end = 0], index) => ({ start, end, text: `Line ${index}` }));

const broadcast = timed(familyFixture.subtitle);
const disc = timed(familyFixture.reference);

const byQuery = (entriesFor: (query: VideoQuery) => Entry[], name = "OpenSubtitles"): SourceSet => {
  const search: Source["search"] = async (query, signal) =>
    fakeSource(name, entriesFor(query)).search(query, signal);
  const download: Source["download"] = async (ref, signal) => {
    const episodes = [1, 23, 24].flatMap((episode) =>
      entriesFor({ type: "series", imdbId: "tt1442437", season: 1, episode, languages: [] }),
    );

    return fakeSource(name, episodes).download(ref, signal);
  };

  return { listed: [{ name, search, download }], references: [] };
};

const joy = (episode: number, title: string, group = "Joy") =>
  `filename=${encodeURIComponent(`Modern Family S01E${episode} ${title}  (1080p x265 10bit ${group}).mkv`)}`;

const hashOf = (episode: number) => `${episode}`.padStart(16, "0");

const withHashOf = (episode: number) =>
  `&videoSize=${200_000_000 + episode}&videoHash=${hashOf(episode)}`;

const familyEntries =
  ({ discLang = "hrv", matched = "dvd", discRelease = "dvdrip.xvid-clerks" } = {}) =>
  (query: VideoQuery): Entry[] => [
    {
      ref: `e${query.episode ?? 0}-hdtv`,
      lang: "hrv",
      releaseName: `Modern.Family.S01E${query.episode ?? 0}.HDTV.XviD-LOL`,
      hashMatch: query.videoHash === hashOf(query.episode ?? 0) && matched === "hdtv",
      cues: broadcast,
    },
    {
      ref: `e${query.episode ?? 0}-dvd`,
      lang: discLang,
      releaseName: `modern.family.s01e${query.episode ?? 0}.${discRelease}`,
      hashMatch:
        query.videoHash === hashOf(query.episode ?? 0) && matched === "dvd" && query.episode !== 24,
      cues: disc,
    },
  ];

const firstRefAt = async (app: ReturnType<typeof appWith>, token: string, path: string) => {
  const { body } = await list(app, token, path);

  return { url: body.subtitles[0]?.url ?? "", ref: refOf(body.subtitles[0]?.url ?? "") };
};

const film = (hash: string) =>
  `movie/tt0111161/${joy(1, "Film")}&videoSize=1&videoHash=${hash}.json`;

const namedFilm = (hash: string) =>
  `movie/tt0111161/filename=${encodeURIComponent("Film (1080p HDTV x265 10bit Joy).mkv")}&videoSize=1&videoHash=${hash}.json`;

const episode23 = `series/tt1442437:1:23/${joy(23, "Hawaii")}${withHashOf(23)}.json`;

const namedEpisode = (season: number) =>
  `series/tt1442437:${season}:24/filename=${encodeURIComponent(`Modern Family S0${season}E24 Family Portrait  (1080p HDTV x265 10bit Joy).mkv`)}${withHashOf(24)}.json`;

const familyWrites = (state: ReturnType<typeof memorySharedState>) => {
  const set = vi.spyOn(state, "set");

  return () => set.mock.calls.filter(([key]) => key.startsWith("fam:"));
};

describe("release families", () => {
  it("learns from a hash match only through OpenSubtitles", async () => {
    const state = memorySharedState();
    const writes = familyWrites(state);

    await list(appWith(byQuery(familyEntries(), "addon.example"), { state }), sealed(), episode23);

    expect(writes()).toEqual([]);
  });

  it("learns nothing from a matched release without a source", async () => {
    const state = memorySharedState();
    const writes = familyWrites(state);

    await list(
      appWith(byQuery(familyEntries({ discRelease: "xvid-clerks" })), { state }),
      sealed(),
      episode23,
    );

    expect(writes()).toEqual([]);
  });

  it("learns nothing from a file name without a group", async () => {
    const state = memorySharedState();
    const writes = familyWrites(state);
    const weak = `series/tt1442437:1:23/filename=${encodeURIComponent("Show.S01E23.1080p.WEB-DL.mkv")}${withHashOf(23)}.json`;

    await list(appWith(byQuery(familyEntries()), { state }), sealed(), weak);

    expect(writes()).toEqual([]);
  });

  it("learns nothing when the install does not share", async () => {
    const state = memorySharedState();
    const writes = familyWrites(state);

    await list(appWith(byQuery(familyEntries()), { state }), sealed({ share: false }), episode23);

    expect(writes()).toEqual([]);
  });

  it("keeps a learned family to its season", async () => {
    const app = appWith(byQuery(familyEntries()));
    const token = sealed({ languages: ["hrv"] });

    await list(app, token, episode23);

    const sameSeason = await firstRefAt(app, token, namedEpisode(1));
    const nextSeason = await firstRefAt(app, token, namedEpisode(2));

    expect(sameSeason.ref.c[0]?.r).toBe("e24-dvd");
    expect(nextSeason.ref.c[0]?.r).toBe("e24-hdtv");
  });

  it("reads no learned family when the install does not use shared data", async () => {
    const app = appWith(byQuery(familyEntries()));

    await list(app, sealed(), episode23);

    const { ref } = await firstRefAt(
      app,
      sealed({ languages: ["hrv"], useShared: false }),
      namedEpisode(1),
    );

    expect(ref.c[0]?.r).toBe("e24-hdtv");
  });

  it("lets a hash match of the file win over a learned family", async () => {
    const state = memorySharedState();
    const token = sealed({ languages: ["hrv"] });

    await list(appWith(byQuery(familyEntries()), { state }), token, episode23);

    const { ref } = await firstRefAt(
      appWith(byQuery(familyEntries({ matched: "hdtv" })), { state }),
      token,
      namedEpisode(1),
    );

    expect(ref.c[0]?.r).toBe("e24-hdtv");
  });

  it("downloads no reference for an entry that is all of the learned family", async () => {
    const app = appWith(byQuery(familyEntries()));
    const token = sealed({ languages: ["hrv"], bestOnly: false });

    await list(app, token, episode23);

    const { body } = await list(app, token, namedEpisode(1));

    expect(body.subtitles.map(({ url }) => refOf(url).x.map(({ r }) => r))).toEqual([
      [],
      ["e24-dvd"],
    ]);
  });

  it("serves the release family an earlier episode of the same release matched", async () => {
    const app = appWith(byQuery(familyEntries()));
    const token = sealed({ languages: ["hrv"] });

    await list(app, token, `series/tt1442437:1:23/${joy(23, "Hawaii")}${withHashOf(23)}.json`);

    const { url, ref } = await firstRefAt(
      app,
      token,
      `series/tt1442437:1:24/${joy(24, "Family Portrait")}${withHashOf(24)}.json`,
    );

    const served = parseSubtitle(await (await app.request(url)).text());

    expect(ref.c.map(({ r }) => r)).toEqual(["e24-dvd", "e24-hdtv"]);
    expect(served.map(({ start }) => start)).toEqual(disc.map(({ start }) => start));
  });

  it("retimes against the release family in another language", async () => {
    const app = appWith(byQuery(familyEntries({ discLang: "eng" })));
    const token = sealed({ languages: ["hrv"] });

    await list(app, token, `series/tt1442437:1:23/${joy(23, "Hawaii")}${withHashOf(23)}.json`);

    const { url, ref } = await firstRefAt(
      app,
      token,
      `series/tt1442437:1:24/${joy(24, "Family Portrait")}${withHashOf(24)}.json`,
    );

    const served = parseSubtitle(await (await app.request(url)).text());
    const close = disc
      .slice(0, -1)
      .filter((cue, index) => Math.abs((served[index]?.start ?? 0) - cue.start) <= 300);

    expect(ref.c[0]?.r).toBe("e24-hdtv");
    expect(ref.x.map(({ r }) => r)).toEqual(["e24-dvd"]);
    expect(close.length / disc.length).toBeGreaterThan(0.8);
  });

  it("leaves a release with another signature alone", async () => {
    const app = appWith(byQuery(familyEntries()));
    const token = sealed({ languages: ["hrv"] });

    await list(app, token, `series/tt1442437:1:23/${joy(23, "Hawaii")}${withHashOf(23)}.json`);

    const { ref } = await firstRefAt(
      app,
      token,
      `series/tt1442437:1:24/filename=${encodeURIComponent("Modern Family S01E24 Family Portrait  (1080p HDTV x265 10bit Other).mkv")}${withHashOf(24)}.json`,
    );

    expect(ref.c[0]?.r).toBe("e24-hdtv");
    expect(ref.x).toEqual([]);
  });

  it("keeps the newest observation of a release family", async () => {
    const token = sealed({ languages: ["hrv"] });
    const shared = memorySharedState();
    const observe = (matched: string) =>
      list(
        appWith(byQuery(familyEntries({ matched })), { state: shared }),
        token,
        `series/tt1442437:1:23/${joy(23, "Hawaii")}${withHashOf(23)}.json`,
      );

    await observe("dvd");
    await observe("hdtv");
    const { ref } = await firstRefAt(
      appWith(byQuery(familyEntries()), { state: shared }),
      token,
      `series/tt1442437:1:24/${joy(24, "Family Portrait")}${withHashOf(24)}.json`,
    );

    expect(ref.c[0]?.r).toBe("e24-hdtv");
  });

  it("learns no family from films", async () => {
    const app = appWith(byQuery(familyEntries()));
    const token = sealed({ languages: ["hrv"] });

    await list(app, token, namedFilm(hashOf(0)));

    const { ref } = await firstRefAt(app, token, namedFilm("ffffffffffffffff"));

    expect(ref.c[0]?.r).toBe("e0-hdtv");
  });
});

const episode24 = (filename: string) =>
  `series/tt1442437:1:24/filename=${encodeURIComponent(filename)}${withHashOf(24)}.json`;

describe("a file that looks like a disc or web rip", () => {
  it("serves the disc subtitle over the broadcast one without anything learned", async () => {
    const app = appWith(byQuery(familyEntries()));
    const token = sealed({ languages: ["hrv"] });

    const { url, ref } = await firstRefAt(
      app,
      token,
      `series/tt1442437:1:24/${joy(24, "Family Portrait")}${withHashOf(24)}.json`,
    );

    const served = parseSubtitle(await (await app.request(url)).text());

    expect(ref.c.map(({ r }) => r)).toEqual(["e24-dvd", "e24-hdtv"]);
    expect(served.map(({ start }) => start)).toEqual(disc.map(({ start }) => start));
  });

  it("retimes a broadcast subtitle against two agreeing disc ones in another language", async () => {
    const source = fakeSource("OpenSubtitles", [
      {
        ref: "e24-hdtv",
        lang: "hrv",
        releaseName: "Modern.Family.S01E24.HDTV.XviD-LOL",
        cues: broadcast,
      },
      {
        ref: "e24-dvd",
        lang: "eng",
        releaseName: "modern.family.s01e24.dvdrip.xvid-clerks",
        cues: disc,
      },
      {
        ref: "e24-dvd-again",
        lang: "eng",
        releaseName: "Modern.Family.S01E24.DVDRip.XviD-REWARD",
        cues: disc,
      },
    ]);
    const app = appWith({ listed: [source], references: [] });

    const { url, ref } = await firstRefAt(
      app,
      sealed({ languages: ["hrv", "eng"] }),
      `series/tt1442437:1:24/${joy(24, "Family Portrait")}${withHashOf(24)}.json`,
    );

    const served = parseSubtitle(await (await app.request(url)).text());
    const close = disc
      .slice(0, -1)
      .filter((cue, index) => Math.abs((served[index]?.start ?? 0) - cue.start) <= 100);

    expect(ref.x.map(({ r }) => r)).toEqual(["e24-dvd", "e24-dvd-again"]);
    expect(close.length / (disc.length - 1)).toBeGreaterThan(0.95);
  });

  it("keeps the exact-release ranking for a file that names its source", async () => {
    const { ref } = await firstRefAt(
      appWith(byQuery(familyEntries())),
      sealed({ languages: ["hrv"] }),
      episode24("Modern.Family.S01E24.1080p.HDTV.x265-LOL.mkv"),
    );

    expect(ref.c[0]?.r).toBe("e24-hdtv");
  });

  it("leaves a 720p file without rip signals alone", async () => {
    const { ref } = await firstRefAt(
      appWith(byQuery(familyEntries())),
      sealed({ languages: ["hrv"] }),
      episode24("Modern Family S01E24 720p.mkv"),
    );

    expect(ref.c[0]?.r).toBe("e24-hdtv");
    expect(ref.x).toEqual([]);
  });

  it("lets a hash match win over the guess", async () => {
    const { ref } = await firstRefAt(
      appWith(byQuery(familyEntries({ matched: "hdtv" }))),
      sealed({ languages: ["hrv"] }),
      `series/tt1442437:1:23/${joy(23, "Hawaii")}${withHashOf(23)}.json`,
    );

    expect(ref.c[0]?.r).toBe("e23-hdtv");
  });

  it("guesses for films the same way", async () => {
    const { ref } = await firstRefAt(
      appWith(byQuery(familyEntries())),
      sealed({ languages: ["hrv"] }),
      film("ffffffffffffffff"),
    );

    expect(ref.c[0]?.r).toBe("e0-dvd");
  });
});

describe("minimum score", () => {
  const episodePath =
    "series/tt1442437:1:24/filename=Modern.Family.S01E24.720p.HDTV.x264-LOL.mkv.json";

  it("keeps a subtitle named after another episode out of the best slot", async () => {
    const source = fakeSource("OpenSubtitles", [
      { ref: "other-episode", releaseName: "Modern.Family.S01E25.1080p.WEB-DL.x265-NTb" },
      { ref: "this-episode", releaseName: "Modern.Family.S01E24.HDTV.XviD-2HD" },
    ]);

    const { ref } = await firstRefAt(
      appWith({ listed: [source], references: [] }),
      sealed(),
      episodePath,
    );

    expect(ref.c.map(({ r }) => r)).toEqual(["this-episode"]);
  });

  it("still offers a subtitle under the minimum score when nothing else exists", async () => {
    const source = fakeSource("OpenSubtitles", [
      { ref: "other-episode", releaseName: "Modern.Family.S01E25.1080p.WEB-DL.x265-NTb" },
    ]);

    const { body } = await list(
      appWith({ listed: [source], references: [] }),
      sealed(),
      episodePath,
    );

    expect(body.subtitles.map(({ label }) => label)).toEqual(["OpenSubtitles"]);
    expect(refOf(body.subtitles[0]?.url ?? "").c.map(({ r }) => r)).toEqual(["other-episode"]);
  });
});

const filmCues = syntheticTrack(5, 600);
const filmWithActBreaks = filmCues.map((cue, index) => {
  const shift = (index >= 200 ? 1200 : 0) + (index >= 400 ? 1200 : 0);

  return { ...cue, start: cue.start + shift, end: cue.end + shift };
});

const deferred = () => {
  const work: Promise<unknown>[] = [];

  return {
    defer: (promise: Promise<unknown>) => work.push(promise),
    settled: () => Promise.all(work),
  };
};

const entriesOf = (body: Listing) =>
  body.subtitles.map(({ id, label, url }) => ({
    id,
    label,
    c: refOf(url).c.map(({ r }) => r),
    x: refOf(url).x.map(({ r }) => r),
  }));

const portrait = `series/tt1442437:1:24/filename=${encodeURIComponent("Modern Family S01E24 Family Portrait  (1080p x265 10bit Joy).mkv")}.json`;

const gilmoreSpans = (key: keyof typeof gilmoreFixture) => timed(gilmoreFixture[key]);

const episodeFamilies = (): Entry[] => [
  {
    ref: "broadcast",
    lang: "hrv",
    releaseName: "Modern.Family.S01E24.HDTV.XviD-LOL",
    cues: broadcast,
  },
  {
    ref: "broadcast-again",
    lang: "hrv",
    releaseName: "Modern.Family.S01E24.720p.HDTV.X264-DIMENSION",
    cues: transform(broadcast, (time) => time - 90),
  },
  { ref: "disc", lang: "hrv", releaseName: "modern.family.s01e24.dvdrip.xvid-clerks", cues: disc },
  {
    ref: "disc-again",
    lang: "hrv",
    releaseName: "Modern.Family.S01E24.DVDRip.XviD-REWARD",
    cues: transform(disc, (time) => time + 120),
  },
];

const familyCacheSecondsOf = async (entries: Entry[]) => {
  const state = memorySharedState();
  const set = vi.spyOn(state, "set");

  await list(
    appWith({ listed: [fakeSource("OpenSubtitles", entries)], references: [] }, { state }),
    sealed({ languages: ["hrv"] }),
    portrait,
  );

  return set.mock.calls.find(([key]) => key.startsWith("tfam:"))?.[2];
};

describe("timing families", () => {
  it("offers one entry per timing family when the candidates disagree", async () => {
    const { body } = await list(
      appWith({ listed: [fakeSource("OpenSubtitles", episodeFamilies())], references: [] }),
      sealed({ languages: ["hrv"] }),
      portrait,
    );

    expect(entriesOf(body)).toEqual([
      {
        id: "hrv-best",
        label: "OpenSubtitles, DVD/Blu-ray timing",
        c: ["disc", "disc-again", "broadcast", "broadcast-again"],
        x: ["disc"],
      },
      {
        id: "hrv-best-2",
        label: "OpenSubtitles, TV timing",
        c: ["broadcast", "broadcast-again", "disc", "disc-again"],
        x: ["broadcast"],
      },
    ]);
  });

  it("retimes a language without its own family to two agreeing subtitles of another", async () => {
    const source = fakeSource("OpenSubtitles", [
      {
        ref: "broadcast",
        lang: "hrv",
        releaseName: "Modern.Family.S01E24.HDTV.XviD-LOL",
        cues: broadcast,
      },
      {
        ref: "disc",
        lang: "eng",
        releaseName: "modern.family.s01e24.dvdrip.xvid-clerks",
        cues: disc,
      },
      {
        ref: "disc-again",
        lang: "eng",
        releaseName: "Modern.Family.S01E24.DVDRip.XviD-REWARD",
        cues: transform(disc, (time) => time + 120),
      },
    ]);

    const { body } = await list(
      appWith({ listed: [source], references: [] }),
      sealed({ languages: ["hrv", "eng"] }),
      portrait,
    );

    expect(entriesOf(body).filter(({ id }) => id.startsWith("hrv"))).toEqual([
      { id: "hrv-best", label: "OpenSubtitles", c: ["broadcast"], x: ["disc", "disc-again"] },
    ]);
  });

  it("needs two agreeing subtitles before a family in another language becomes a reference", async () => {
    const source = fakeSource("OpenSubtitles", [
      {
        ref: "broadcast",
        lang: "hrv",
        releaseName: "Modern.Family.S01E24.HDTV.XviD-LOL",
        cues: broadcast,
      },
      {
        ref: "disc",
        lang: "eng",
        releaseName: "modern.family.s01e24.dvdrip.xvid-clerks",
        cues: disc,
      },
    ]);

    const { body } = await list(
      appWith({ listed: [source], references: [] }),
      sealed({ languages: ["hrv", "eng"] }),
      portrait,
    );

    expect(entriesOf(body).filter(({ id }) => id.startsWith("hrv"))).toEqual([
      { id: "hrv-best", label: "OpenSubtitles", c: ["broadcast"], x: [] },
    ]);
  });

  it("retimes to the disc family alone when the file names a disc source", async () => {
    const source = fakeSource("OpenSubtitles", [
      {
        ref: "broadcast",
        lang: "hrv",
        releaseName: "Modern.Family.S01E24.HDTV.XviD-LOL",
        cues: broadcast,
      },
      {
        ref: "disc",
        lang: "eng",
        releaseName: "modern.family.s01e24.dvdrip.xvid-clerks",
        cues: disc,
      },
    ]);

    const { body } = await list(
      appWith({ listed: [source], references: [] }),
      sealed({ languages: ["hrv", "eng"] }),
      "series/tt1442437:1:24/filename=Modern.Family.S01E24.1080p.BluRay.x264-GRP.mkv.json",
    );

    expect(entriesOf(body)).toEqual([
      { id: "hrv-best", label: "OpenSubtitles", c: ["broadcast"], x: ["disc"] },
      { id: "eng-best", label: "OpenSubtitles", c: ["disc"], x: ["disc"] },
    ]);
  });

  it("serves Gilmore Girls S05E17 retimed to its DVD family, plain captions first", async () => {
    const hrvBroadcast = gilmoreSpans("hrvBroadcast");
    const source = fakeSource("OpenSubtitles", [
      {
        ref: "hrv-broadcast",
        lang: "hrv",
        releaseName: "gilmore.girls.517.hdtv-lol.[BT]-hrv",
        cues: hrvBroadcast,
      },
      {
        ref: "eng-dvd-hi",
        lang: "eng",
        releaseName: "Gilmore Girls S05E17 Pulp Friction.DVDRip.HI.cc.en.WB",
        cues: gilmoreSpans("engDvdHearingImpaired"),
      },
      {
        ref: "eng-dvd-plain",
        lang: "eng",
        releaseName: "Gilmore Girls S05E17 Pulp Friction.DVDRip.NonHI.cc.en.WB",
        cues: gilmoreSpans("engDvdPlain"),
      },
      {
        ref: "eng-dvd",
        lang: "eng",
        releaseName: "Gilmore Girls s05e17 Pulp Friction Dvdrip Xvid-Topaz",
        cues: gilmoreSpans("engDvd"),
      },
      {
        ref: "eng-broadcast",
        lang: "eng",
        releaseName: "Gilmore Girls [5x17] - Pulp Friction - LOL -",
        cues: gilmoreSpans("engBroadcast"),
      },
    ]);
    const app = appWith({ listed: [source], references: [] }, { timingFamilyTimeBoxMs: 60_000 });

    const { body } = await list(
      app,
      sealed({ languages: ["hrv", "eng"] }),
      `series/tt0238784:5:17/filename=${encodeURIComponent("Gilmore Girls (2000) - S05E17 - Pulp Friction (1080p BluRay x265 Celdra).mkv")}.json`,
    );

    const entries = entriesOf(body);
    const served = parseSubtitle(await (await app.request(body.subtitles[0]?.url ?? "")).text());
    const shifts = served.map((cue, index) => cue.start - (hrvBroadcast[index]?.start ?? 0));

    expect(entries).toEqual([
      {
        id: "hrv-best",
        label: "OpenSubtitles",
        c: ["hrv-broadcast"],
        x: ["eng-dvd-plain", "eng-dvd", "eng-dvd-hi"],
      },
      {
        id: "eng-best",
        label: "OpenSubtitles",
        c: ["eng-dvd-plain", "eng-dvd", "eng-dvd-hi", "eng-broadcast"],
        x: ["eng-dvd-plain"],
      },
    ]);
    expect(median(shifts.slice(0, 60))).toBeGreaterThan(700);
    expect(median(shifts.slice(0, 60))).toBeLessThan(1900);
    expect(median(shifts.slice(-60))).toBeGreaterThan(2700);
    expect(median(shifts.slice(-60))).toBeLessThan(3800);
  }, 60_000);

  it("keeps a family entry's references when the hashed listing matches nothing", async () => {
    const source = fakeSource("OpenSubtitles", [
      {
        ref: "broadcast",
        lang: "hrv",
        releaseName: "Modern.Family.S01E24.HDTV.XviD-LOL",
        cues: broadcast,
      },
      {
        ref: "broadcast-again",
        lang: "hrv",
        releaseName: "Modern.Family.S01E24.720p.HDTV.X264-DIMENSION",
        cues: broadcast,
      },
      {
        ref: "disc",
        lang: "hrv",
        releaseName: "modern.family.s01e24.dvdrip.xvid-clerks",
        cues: disc,
      },
      {
        ref: "disc-again",
        lang: "hrv",
        releaseName: "Modern.Family.S01E24.DVDRip.XviD-REWARD",
        cues: disc,
      },
    ]);
    const app = appWith({ listed: [source], references: [] });
    const token = sealed({ languages: ["hrv"] });
    const name = encodeURIComponent(
      "Modern Family S01E24 Family Portrait  (1080p x265 10bit Joy).mkv",
    );
    const first = await list(app, token, `series/tt1442437:1:24/filename=${name}.json`);

    await list(
      app,
      token,
      `series/tt1442437:1:24/filename=${name}&videoSize=224510816&videoHash=b3a7165fd6717684.json`,
    );

    const television = first.body.subtitles.find(({ label }) => label.endsWith("TV timing"));
    const served = parseSubtitle(await (await app.request(television?.url ?? "")).text());

    expect(served.map(({ start }) => start)).toEqual(broadcast.map(({ start }) => start));
  });

  it("keeps one entry when every candidate agrees", async () => {
    const source = fakeSource("OpenSubtitles", [
      {
        ref: "disc",
        lang: "hrv",
        releaseName: "modern.family.s01e24.dvdrip.xvid-clerks",
        cues: disc,
      },
      {
        ref: "disc-again",
        lang: "hrv",
        releaseName: "Modern.Family.S01E24.DVDRip.XviD-REWARD",
        cues: transform(disc, (time) => time + 120),
      },
    ]);

    const { body } = await list(
      appWith({ listed: [source], references: [] }),
      sealed({ languages: ["hrv"] }),
      portrait,
    );

    expect(entriesOf(body).map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "hrv-best", label: "OpenSubtitles" },
    ]);
  });

  it("splits a film cut for television from the cinema cut", async () => {
    const source = fakeSource("OpenSubtitles", [
      { ref: "cinema", releaseName: "Film.1999.1080p.BluRay.x264-AAA", cues: filmCues },
      {
        ref: "cinema-again",
        releaseName: "Film.1999.720p.BluRay.x264-DDD",
        cues: transform(filmCues, (time) => time - 90),
      },
      { ref: "television", releaseName: "Film.1999.HDTV.x264-BBB", cues: filmWithActBreaks },
      {
        ref: "television-again",
        releaseName: "Film.1999.HDTV.XviD-EEE",
        cues: transform(filmWithActBreaks, (time) => time + 60),
      },
    ]);

    const { body } = await list(
      appWith({ listed: [source], references: [] }),
      sealed(),
      "movie/tt0111161/filename=Film.1999.1080p.x265-CCC.mkv.json",
    );

    expect(entriesOf(body).map(({ label, c }) => ({ label, c: c.slice(0, 2) }))).toEqual([
      { label: "OpenSubtitles, DVD/Blu-ray timing", c: ["cinema", "cinema-again"] },
      { label: "OpenSubtitles, TV timing", c: ["television", "television-again"] },
    ]);
  });

  it("serves today's entry past the time box and offers the families next time", async () => {
    const source = fakeSource(
      "OpenSubtitles",
      episodeFamilies().map((entry) => ({ ...entry, delayMs: 200 })),
    );
    const { defer, settled } = deferred();

    const app = appWith({ listed: [source], references: [] }, { defer, timingFamilyTimeBoxMs: 20 });
    const token = sealed({ languages: ["hrv"] });

    const first = await list(app, token, portrait);

    await settled();

    const second = await list(app, token, portrait);

    expect(entriesOf(first.body).map(({ id }) => id)).toEqual(["hrv-best"]);
    expect(first.response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(entriesOf(second.body).map(({ id }) => id)).toEqual(["hrv-best", "hrv-best-2"]);
    expect(second.response.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("clusters once for installs that list their languages in another order", async () => {
    const source = fakeSource("OpenSubtitles", episodeFamilies());
    const app = appWith({ listed: [source], references: [] });

    await list(app, sealed({ languages: ["hrv", "eng"] }), portrait);
    await list(app, sealed({ languages: ["eng", "hrv"] }), portrait);

    expect(source.download).toHaveBeenCalledTimes(4);
  });

  it("runs one clustering at a time for the same candidates", async () => {
    const source = fakeSource(
      "OpenSubtitles",
      episodeFamilies().map((entry) => ({ ...entry, delayMs: 200 })),
    );
    const { defer, settled } = deferred();

    const app = appWith({ listed: [source], references: [] }, { defer, timingFamilyTimeBoxMs: 20 });
    const token = sealed({ languages: ["hrv"] });

    await Promise.all([list(app, token, portrait), list(app, token, portrait)]);
    await settled();

    expect(source.download).toHaveBeenCalledTimes(4);
  });

  it("serves today's entry without clustering when shared state fails", async () => {
    const state = memorySharedState();
    const source = fakeSource("OpenSubtitles", episodeFamilies());

    vi.spyOn(state, "get").mockRejectedValue(new TypeError("fetch failed"));

    const { body } = await list(
      appWith({ listed: [source], references: [] }, { state }),
      sealed({ languages: ["hrv"] }),
      portrait,
    );

    expect(entriesOf(body).map(({ id }) => id)).toEqual(["hrv-best"]);
    expect(source.download).not.toHaveBeenCalled();
  });

  it("keeps a complete clustering for 30 days and a partial one for ten minutes", async () => {
    expect(await familyCacheSecondsOf(episodeFamilies())).toBe(30 * 24 * 60 * 60);
    expect(
      await familyCacheSecondsOf(
        episodeFamilies().map((entry, index) =>
          index === 3 ? { ...entry, cues: undefined } : entry,
        ),
      ),
    ).toBe(10 * 60);
  });

  it("offers the dialogue-only copy of the first timing family", async () => {
    const { body } = await list(
      appWith({ listed: [fakeSource("OpenSubtitles", episodeFamilies())], references: [] }),
      sealed({
        languages: ["hrv"],
        extras: { hideMismatches: true, dialogueOnly: true, foreignParts: false },
      }),
      portrait,
    );

    expect(entriesOf(body).find(({ id }) => id === "hrv-dialogue")).toEqual({
      id: "hrv-dialogue",
      label: "OpenSubtitles (dialogue only), DVD/Blu-ray timing",
      c: ["disc", "disc-again", "broadcast", "broadcast-again"],
      x: ["disc"],
    });
  });

  it("downloads nothing when a candidate matches the file's hash", async () => {
    const source = fakeSource("OpenSubtitles", [
      { ref: "broadcast", lang: "hrv", hashMatch: true, cues: broadcast },
      {
        ref: "disc",
        lang: "hrv",
        releaseName: "modern.family.s01e24.dvdrip.xvid-clerks",
        cues: disc,
      },
    ]);

    const { body } = await list(
      appWith({ listed: [source], references: [] }),
      sealed({ languages: ["hrv"] }),
      portrait,
    );

    expect(entriesOf(body).map(({ id }) => id)).toEqual(["hrv-best"]);
    expect(source.download).not.toHaveBeenCalled();
  });
});

describe("refs", () => {
  const key = refKey(secret);
  const ref: SubtitleRef = {
    v: 1,
    q: { t: "series", i: "tt0903747", s: 1, e: 2 },
    c: [{ n: "Fake", r: "a", l: "eng", p: 23.976 }],
    x: [{ n: "Reference", r: "r", l: "eng", h: 1 }],
  };

  it("round-trips a reference", () => {
    expect(decodeRef(encodeRef(ref, key), key)).toEqual(ref);
  });

  it("rejects a reference signed with another secret", () => {
    expect(() => decodeRef(encodeRef(ref, refKey("another-secret")), key)).toThrow(
      "Invalid subtitle reference",
    );
  });

  it("rejects a reference whose payload changed", () => {
    const [payload = "", signature = ""] = encodeRef(ref, key).split(".");

    const flipped = Buffer.from(payload, "base64url")
      .toString("utf8")
      .replace("tt0903747", "tt0903748");
    const tampered = `${Buffer.from(flipped).toString("base64url")}.${signature}`;

    expect(() => decodeRef(tampered, key)).toThrow("Invalid subtitle reference");
  });

  it.each([
    ["garbage"],
    [Buffer.from(JSON.stringify(ref)).toString("base64url")],
    [`${encodeRef(ref, key).split(".")[0]}.`],
  ])("rejects %s", (text) => {
    expect(() => decodeRef(text, key)).toThrow("Invalid subtitle reference");
  });
});

describe("singleFlight", () => {
  it("runs one job for concurrent callers and forgets it once settled", async () => {
    const singleFlight = memorySingleFlight();
    const run = vi.fn<() => Promise<string>>(async () => "done");
    const fail = vi.fn<() => Promise<string>>(async () => {
      throw new Error("failed");
    });

    const first = await Promise.all([singleFlight("key", run), singleFlight("key", run)]);

    await singleFlight("key", run);
    await expect(singleFlight("failing", fail)).rejects.toThrow("failed");
    await expect(singleFlight("failing", fail)).rejects.toThrow("failed");

    expect(first).toEqual(["done", "done"]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(fail).toHaveBeenCalledTimes(2);
  });
});

const names = (sources: { name: string }[]) => sources.map((source) => source.name);

describe("sourcesFromConfig", () => {
  const config: Config = {
    ...defaultConfig(["eng"]),
    sources: [
      { kind: "stremio-addon", url: "https://opensubtitles-v3.strem.io/manifest.json" },
      { kind: "stremio-addon", url: "https://subs.example.com/manifest.json" },
      { kind: "titlovi", username: "user", password: "pass" },
      { kind: "subdl", apiKey: "key" },
      { kind: "subsource", apiKey: "key" },
    ],
  };

  it("lists every configured source and needs no reference next to the v3 addon", () => {
    const sources = sourcesFromConfig(config, {
      tokens: memoryTokenCache(),
      state: memorySharedState(),
      openSubtitlesAppKey: "app-key",
    });

    expect(names(sources.listed)).toEqual([
      "OpenSubtitles",
      "subs.example.com",
      "Titlovi.com",
      "SubDL",
      "SubSource",
    ]);
    expect(sources.references).toEqual([]);
  });

  it("adds the OpenSubtitles API as a reference when the v3 addon is not listed", () => {
    const sources = sourcesFromConfig(
      { ...config, sources: [{ kind: "subdl", apiKey: "key" }] },
      { tokens: memoryTokenCache(), state: memorySharedState(), openSubtitlesAppKey: "app-key" },
    );

    expect(names(sources.references)).toEqual(["OpenSubtitles API"]);
  });

  it("lists an OpenSubtitles login under its own name next to the v3 addon", () => {
    const sources = sourcesFromConfig(
      {
        ...config,
        sources: [
          { kind: "stremio-addon", url: "https://opensubtitles-v3.strem.io/manifest.json" },
          { kind: "opensubtitles", username: "user", password: "pass" },
        ],
      },
      { tokens: memoryTokenCache(), state: memorySharedState(), openSubtitlesAppKey: "app-key" },
    );

    expect(names(sources.listed)).toEqual(["OpenSubtitles", "OpenSubtitles API"]);
    expect(sources.references).toEqual([]);
  });

  it("skips the OpenSubtitles API without an app key", () => {
    const sources = sourcesFromConfig(
      { ...config, sources: [{ kind: "opensubtitles", username: "user", password: "pass" }] },
      { tokens: memoryTokenCache(), state: memorySharedState() },
    );

    expect(sources).toEqual({ listed: [], references: [] });
  });

  it("asks only the v3 addon for a hashed file without an app key", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ subtitles: [] })),
    );

    vi.stubGlobal("fetch", fetchMock);

    const [openSubtitles] = sourcesFromConfig(defaultConfig(["eng"]), {
      tokens: memoryTokenCache(),
      state: memorySharedState(),
    }).listed;

    await openSubtitles?.search(
      { type: "movie", imdbId: "tt0046183", videoHash: "466d8f728dbe2142", languages: ["eng"] },
      AbortSignal.timeout(1000),
    );

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://opensubtitles-v3.strem.io/subtitles/movie/tt0046183/videoHash=466d8f728dbe2142.json",
    ]);
  });

  it("lists each OpenSubtitles match once next to a login, through v3 where it can", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      String(input).startsWith("https://api.opensubtitles.com")
        ? new Response(JSON.stringify(restHashFixture))
        : new Response(JSON.stringify(v3HashFixture)),
    );

    vi.stubGlobal("fetch", fetchMock);

    const { listed } = sourcesFromConfig(
      {
        ...defaultConfig(["eng", "hrv"]),
        sources: [
          { kind: "stremio-addon", url: "https://opensubtitles-v3.strem.io/manifest.json" },
          { kind: "opensubtitles", username: "user", password: "pass" },
        ],
      },
      { tokens: memoryTokenCache(), state: memorySharedState(), openSubtitlesAppKey: "app-key" },
    );

    const query: VideoQuery = {
      type: "movie",
      imdbId: "tt0046183",
      videoHash: "466d8f728dbe2142",
      languages: ["eng", "hrv"],
    };
    const found = await Promise.all(
      listed.map((source) => source.search(query, AbortSignal.timeout(1000))),
    );

    expect(
      found.flat().map(({ sourceName, ref, hashMatch }) => [sourceName, ref.slice(-10), hashMatch]),
    ).toEqual([
      ["OpenSubtitles", "1953294863", false],
      ["OpenSubtitles", "1953315756", true],
      ["OpenSubtitles", "enc=cp1250", false],
      ["OpenSubtitles API", "735363", true],
      ["OpenSubtitles API", "12038440", false],
    ]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("strem.io"))).toHaveLength(
      1,
    );
  });

  it("names the OpenSubtitles API candidates after the wrapped source", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ attributes: { language: "en", files: [{ file_id: 7 }] } }],
          }),
        ),
    );

    vi.stubGlobal("fetch", fetchMock);

    const [reference] = sourcesFromConfig(
      { ...defaultConfig(["eng"]), sources: [] },
      { tokens: memoryTokenCache(), state: memorySharedState(), openSubtitlesAppKey: "app-key" },
    ).references;

    const candidates = await reference?.search(
      { type: "movie", imdbId: "tt0111161", languages: ["eng"] },
      AbortSignal.timeout(1000),
    );

    expect(candidates?.map((candidate) => [candidate.sourceName, candidate.ref])).toEqual([
      ["OpenSubtitles API", "7"],
    ]);
  });
});
