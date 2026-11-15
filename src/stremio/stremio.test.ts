import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import packageJSON from "../../package.json" with { type: "json" };
import restHashFixture from "../../test/fixtures/sources/opensubtitles-rest-hash-search.json" with { type: "json" };
import v3HashFixture from "../../test/fixtures/sources/opensubtitles-v3-hash-movie.json" with { type: "json" };
import { createApp, type AppDeps } from "../app.ts";
import type { Config } from "../config/config.ts";
import { defaultConfig } from "../config/default-config.ts";
import { seal } from "../config/seal.ts";
import { sourcesFromConfig, type SourceSet } from "../sources/from-config.ts";
import type { VideoQuery } from "../sources/source.ts";
import { fakeSource, memoryTokenCache } from "../sources/test-sources.ts";
import { memorySharedState } from "../jobs/shared-state.ts";
import { memorySingleFlight } from "../jobs/single-flight.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import { writeSRT } from "../subtitles/write.ts";
import { retime } from "../timing/retime.ts";
import { syntheticTrack, transform } from "../timing/test-tracks.ts";
import { decodeRef, encodeRef, refKey, type SubtitleRef } from "./refs.ts";

vi.mock("../timing/retime.ts", { spy: true });

type Listing = { subtitles: { id: string; lang: string; url: string }[] };

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
