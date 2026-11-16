import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import packageJSON from "../../package.json" with { type: "json" };
import gilmoreFixture from "../../test/fixtures/subtitles/gilmore-s05e17.json" with { type: "json" };
import familyFixture from "../../test/fixtures/subtitles/act-breaks-s01e24.json" with { type: "json" };
import santaFixture from "../../test/fixtures/subtitles/santa-clause-2-pal.json" with { type: "json" };
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

  it("lists one best entry per source, each serving only that source", async () => {
    const { body } = await list(
      appWith({
        listed: [
          fakeSource("OpenSubtitles", [{ ref: "a", hashMatch: true }, { ref: "b" }]),
          fakeSource("SubDL", [{ ref: "c" }]),
        ],
        references: [],
      }),
      sealed(),
      "movie/tt0111161.json",
    );

    expect(
      body.subtitles.map(({ id, label, url }) => [id, label, refOf(url).c.map(({ r }) => r)]),
    ).toEqual([
      ["eng-best", "OpenSubtitles", ["a", "b"]],
      ["eng-best-2", "SubDL", ["c"]],
    ]);
  });

  it("orders the best entries by each source's best candidate", async () => {
    const { body } = await list(
      appWith({
        listed: [
          fakeSource("OpenSubtitles", [{ ref: "a" }]),
          fakeSource("SubDL", [{ ref: "b", hashMatch: true }]),
          fakeSource("Titlovi.com", [{ ref: "c" }]),
        ],
        references: [],
      }),
      sealed(),
      "movie/tt0111161.json",
    );

    expect(body.subtitles.map(({ id, label }) => [id, label])).toEqual([
      ["eng-best", "SubDL (made for this file)"],
      ["eng-best-2", "OpenSubtitles"],
      ["eng-best-3", "Titlovi.com"],
    ]);
  });

  it("lists the OpenSubtitles API and addon under one OpenSubtitles entry", async () => {
    const { body } = await list(
      appWith({
        listed: [
          fakeSource("OpenSubtitles API", [{ ref: "1", hashMatch: true }]),
          fakeSource("OpenSubtitles", [{ ref: "a" }]),
        ],
        references: [],
      }),
      sealed(),
      "movie/tt0111161.json",
    );

    expect(
      body.subtitles.map(({ id, label, url }) => [id, label, refOf(url).c.map(({ r }) => r)]),
    ).toEqual([["eng-best", "OpenSubtitles", ["1", "a"]]]);
  });

  it("keeps a free subtitle behind an entry and its extras that would be all metered", async () => {
    const metered = ["m1", "m2", "m3", "m4", "m5"].map((ref) => ({ ref, metered: true }));
    const meteredSecond = metered.map((entry) => ({
      ...entry,
      ref: `${entry.ref}-hr`,
      lang: "hrv",
    }));
    const { body } = await list(
      appWith({
        listed: [
          fakeSource("OpenSubtitles", [
            ...metered,
            { ref: "f1" },
            { ref: "f2" },
            ...meteredSecond,
            { ref: "f1-hr", lang: "hrv" },
          ]),
        ],
        references: [fakeSource("Reference", [{ ref: "r", hashMatch: true }])],
      }),
      sealed({
        extras: {
          hideMismatches: true,
          dialogueOnly: true,
          foreignParts: false,
          sourceInLanguage: false,
          dualLanguage: "hrv",
        },
      }),
      "movie/tt0111161.json",
    );

    expect(
      body.subtitles.map(({ id, url }) => [
        id,
        refOf(url).c.map(({ r }) => r),
        refOf(url).s?.map(({ r }) => r),
      ]),
    ).toEqual([
      ["eng-best", ["m1", "m2", "m3", "f1"], undefined],
      ["eng-dialogue", ["m1", "m2", "m3", "f1"], undefined],
      ["eng+hrv-dual", ["m1", "m2", "m3", "f1"], ["m1-hr", "m2-hr", "m3-hr", "f1-hr"]],
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
      { trustProxy: true },
      { "x-forwarded-proto": "https", "x-forwarded-host": "proxy.example.com" },
      "https://proxy.example.com/",
    ],
    [
      {},
      { "x-forwarded-proto": "https", "x-forwarded-host": "proxy.example.com" },
      "http://localhost/",
    ],
    [{ trustProxy: true }, { "x-forwarded-proto": "https" }, "http://localhost/"],
    [
      { trustProxy: true },
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
      a: [
        { n: "Reference", r: "r", l: "eng", h: 1 },
        { n: "Fake", r: "a", l: "eng" },
      ],
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

  it("downloads the served subtitles as served and the anchor and references as not", async () => {
    const sources = mismatchSources();
    const { app, url } = await firstSlot(sources);

    await app.request(url);

    expect(sources.listed[0]?.download.mock.calls.map(([ref, , served]) => [ref, served])).toEqual([
      ["wrong", true],
      ["right", false],
    ]);
    expect(
      sources.references[0]?.download.mock.calls.map(([ref, , served]) => [ref, served]),
    ).toEqual([["r", false]]);
  });

  it("never takes a metered subtitle as a reference", async () => {
    const source = fakeSource("Fake", [
      { ref: "a", metered: true, releaseName: "Movie.2024.1080p.BluRay.x264-GROUP" },
    ]);
    const app = appWith({ listed: [source], references: [] });
    const { body } = await list(app, sealed(), `movie/tt0111161/filename=${fileName}.json`);

    expect(refOf(body.subtitles[0]?.url ?? "").x).toEqual([]);
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

  it("retimes a subtitle from the listing before the hash to the hashed listing's anchor", async () => {
    const source = fakeSource("Fake", [
      { ref: "hrv-shifted", lang: "hrv", cues: shifted },
      { ref: "disc", cues: track },
      { ref: "again", cues: transform(track, (time) => time + 40) },
    ]);
    const app = appWith({
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
    });
    const token = sealed({ languages: ["hrv"] });

    const first = await list(app, token, withoutHash);

    await list(app, token, withHash);

    const served = await servedAt(app, first.body.subtitles[0]?.url ?? "");

    expect(startsOf(served)).toEqual(startsOf(track));
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
  `movie/tt0111161/filename=${encodeURIComponent("Film (1080p BluRay x265 10bit Joy).mkv")}&videoSize=1&videoHash=${hash}.json`;

const episode23 = `series/tt1442437:1:23/${joy(23, "Hawaii")}${withHashOf(23)}.json`;

const namedEpisode = (season: number) =>
  `series/tt1442437:${season}:24/filename=${encodeURIComponent(`Modern Family S0${season}E24 Family Portrait  (1080p BluRay x265 10bit Joy).mkv`)}${withHashOf(24)}.json`;

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

  it("times the second language of a dual entry against the release family", async () => {
    const app = appWith(byQuery(familyEntries({ discLang: "eng" })));
    const token = sealed({
      languages: ["eng"],
      extras: { ...defaultConfig(["eng"]).extras, dualLanguage: "hrv" },
    });

    await list(app, token, episode23);

    const { body } = await list(app, token, namedEpisode(1));

    const dual = body.subtitles.find(({ id }) => id === "eng+hrv-dual")?.url ?? "";
    const response = await app.request(dual);
    const text = await response.text();

    expect(
      body.subtitles.map(({ id, url }) => [
        id,
        refOf(url).c.map(({ r }) => r),
        refOf(url).x.map(({ r }) => r),
      ]),
    ).toEqual([
      ["eng-best", ["e24-dvd"], []],
      ["eng+hrv-dual", ["e24-dvd"], ["e24-dvd"]],
    ]);
    expect(response.status).toBe(200);
    expect(text).toMatch(/^1\n00:00:04,500 --> 00:00:06,600\nLine 0\n<i>Line 0<\/i>\n/);
    expect(parseSubtitle(text).slice(0, 3)).toEqual([
      { start: 4500, end: 6600, text: "Line 0\nLine 0" },
      { start: 7500, end: 9100, text: "Line 1\nLine 1" },
      { start: 9200, end: 12369, text: "Line 2\nLine 2" },
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
    const token = sealed({ languages: ["hrv", "eng"] });

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
      `series/tt1442437:1:24/filename=${encodeURIComponent("Modern Family S01E24 Family Portrait  (1080p BluRay x265 10bit Other).mkv")}${withHashOf(24)}.json`,
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

  it("retimes a broadcast subtitle against a disc one in another language", async () => {
    const app = appWith(byQuery(familyEntries({ discLang: "eng" })));
    const token = sealed({ languages: ["hrv", "eng"] });

    const { url, ref } = await firstRefAt(
      app,
      token,
      `series/tt1442437:1:24/${joy(24, "Family Portrait")}${withHashOf(24)}.json`,
    );

    const served = parseSubtitle(await (await app.request(url)).text());
    const close = disc
      .slice(0, -1)
      .filter((cue, index) => Math.abs((served[index]?.start ?? 0) - cue.start) <= 100);

    expect(ref.x.map(({ r }) => r)).toEqual(["e24-dvd"]);
    expect(close.length / (disc.length - 1)).toBeGreaterThan(0.95);
  });

  it("lists no dual entry when the best entry is the guessed release of a rip", async () => {
    const { body } = await list(
      appWith(byQuery(familyEntries({ discLang: "eng" }))),
      sealed({ extras: { ...defaultConfig(["eng"]).extras, dualLanguage: "hrv" } }),
      `series/tt1442437:1:24/${joy(24, "Family Portrait")}${withHashOf(24)}.json`,
    );

    expect(body.subtitles.map(({ id, url }) => [id, refOf(url).x, refOf(url).a])).toEqual([
      ["eng-best", [], undefined],
    ]);
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

const anchored = (path: string) =>
  `movie/tt0111161/filename=${encodeURIComponent(path)}&videoSize=1&videoHash=0123456789abcdef.json`;

const startsOf = (cues: { start: number }[]) => cues.map(({ start }) => start);

const servedAt = async (app: ReturnType<typeof appWith>, url: string) =>
  parseSubtitle(await (await app.request(url)).text());

const santaSpans = (key: keyof typeof santaFixture) => timed(santaFixture[key]);

const gilmoreSpans = (key: keyof typeof gilmoreFixture) => timed(gilmoreFixture[key]);

const hashAnchored = () =>
  fakeSource("OpenSubtitles", [
    { ref: "hrv-shifted", lang: "hrv", cues: shifted },
    { ref: "fre-shifted", lang: "fre", cues: shifted },
    { ref: "eng-hash", lang: "eng", hashMatch: true, cues: track },
    { ref: "eng-again", lang: "eng", cues: transform(track, (time) => time + 40) },
  ]);

describe("timing anchor", () => {
  it("builds the sources once for a listing that warms the anchor", async () => {
    const sources = { listed: [hashAnchored()], references: [] };
    const sourcesFor = vi.fn<NonNullable<AppDeps["sourcesFor"]>>(() => sources);

    await list(
      appWith(sources, { sourcesFor }),
      sealed({ languages: ["hrv"] }),
      anchored(fileName),
    );

    expect(sourcesFor).toHaveBeenCalledTimes(1);
  });

  it("retimes the requested language to a hash match in another language", async () => {
    const app = appWith({ listed: [hashAnchored()], references: [] });

    const { url, ref } = await firstRefAt(app, sealed({ languages: ["hrv"] }), anchored(fileName));

    expect(ref.a?.map(({ r }) => r)).toEqual([
      "eng-hash",
      "hrv-shifted",
      "fre-shifted",
      "eng-again",
    ]);
    expect(startsOf(await servedAt(app, url))).toEqual(startsOf(track));
  });

  it("retimes the requested language to the release-name candidate in another language", async () => {
    const source = fakeSource("OpenSubtitles", [
      { ref: "hrv-shifted", lang: "hrv", releaseName: "Movie.2024.HDTV.x264-OTHER", cues: shifted },
      { ref: "eng-web", lang: "eng", releaseName: "Movie.2024.720p.WEB-DL-ANY", cues: track },
      {
        ref: "eng-release",
        lang: "eng",
        releaseName: "Movie.2024.1080p.BluRay.x264-GROUP",
        cues: track,
      },
    ]);
    const app = appWith({ listed: [source], references: [] });

    const { url, ref } = await firstRefAt(app, sealed({ languages: ["hrv"] }), anchored(fileName));

    expect(ref.a?.[0]?.r).toBe("eng-release");
    expect(startsOf(await servedAt(app, url))).toEqual(startsOf(track));
  });

  it("serves a subtitle that already shares the anchor's timing as it is", async () => {
    const close = transform(track, (time) => time + 40);
    const source = fakeSource("OpenSubtitles", [
      { ref: "hrv-close", lang: "hrv", releaseName: "Movie.2024.720p.WEB-DL-ANY", cues: close },
      {
        ref: "eng-release",
        lang: "eng",
        releaseName: "Movie.2024.1080p.BluRay.x264-GROUP",
        cues: track,
      },
    ]);
    const app = appWith({ listed: [source], references: [] });

    const { url } = await firstRefAt(app, sealed({ languages: ["hrv"] }), anchored(fileName));

    expect(startsOf(await servedAt(app, url))).toEqual(startsOf(close));
    expect(retime).not.toHaveBeenCalled();
  });

  it("trusts no anchor that no other subtitle shares, as with The Santa Clause 2 timed for PAL", async () => {
    const source = fakeSource("OpenSubtitles", [
      {
        ref: "hrv-dvd",
        lang: "hrv",
        releaseName: "Santa.Clause.2.2002.FS.DVDRip.XviD.iNT-420RipZ.HR",
        cues: santaSpans("hrvDisc"),
      },
      {
        ref: "ara-pal",
        lang: "ara",
        releaseName: "The.Santa.Clause.2.2002.1080p.bluray.mora.25r",
        fps: 25,
        cues: santaSpans("palAnchor"),
      },
      {
        ref: "eng-bluray",
        lang: "eng",
        releaseName: "The Santa Clause 2 (2002) 720p BluRay.en",
        fps: 23.976,
        cues: santaSpans("engBluRay"),
      },
      {
        ref: "eng-dvd",
        lang: "eng",
        releaseName: "Santa.Clause.2.2002.FS.DVDRip.XviD.iNT-420RipZ.EN",
        fps: 23.976,
        cues: santaSpans("engDvd"),
      },
    ]);
    const app = appWith({ listed: [source], references: [] });

    const { url, ref } = await firstRefAt(
      app,
      sealed({ languages: ["hrv"] }),
      anchored("The.Santa.Clause.2.2002.1080p.BluRay.x264-nikt0.mkv"),
    );

    expect(ref.a?.[0]?.r).toBe("ara-pal");
    expect(startsOf(await servedAt(app, url))).toEqual(startsOf(santaSpans("hrvDisc")));
  }, 60_000);

  it("speeds up a subtitle made for 25 fps when the untrusted anchor and most others run at 23.976", async () => {
    const source = fakeSource("OpenSubtitles", [
      {
        ref: "hrv-pal",
        lang: "hrv",
        releaseName: "Movie.2024.DVDRip.XviD-PAL",
        fps: 25,
        cues: transform(track, (time) => Math.round((time * 23.976) / 25)),
      },
      {
        ref: "eng-release",
        lang: "eng",
        releaseName: "Movie.2024.1080p.BluRay.x264-GROUP",
        cues: transform(track, (time) => time + 300),
      },
      {
        ref: "eng-web",
        lang: "eng",
        releaseName: "Movie.2024.720p.WEB-DL-ANY",
        cues: transform(track, (time) => time - 300),
      },
      {
        ref: "fre-web",
        lang: "fre",
        releaseName: "Movie.2024.720p.WEB-DL-ANY",
        cues: transform(track, (time) => time + 900),
      },
    ]);
    const app = appWith({ listed: [source], references: [] });

    const { url, ref } = await firstRefAt(app, sealed({ languages: ["hrv"] }), anchored(fileName));

    const served = await servedAt(app, url);
    const expected = transform(track, (time) => time + 300);

    expect(ref.a?.[0]?.r).toBe("eng-release");
    expect(ref.x).toEqual([]);
    expect(
      Math.max(
        ...served.map(({ start }, index) => Math.abs(start - (expected[index]?.start ?? 0))),
      ),
    ).toBeLessThanOrEqual(2);
  });

  it("speeds up a subtitle made for 25 fps to the timing two others share at 23.976", async () => {
    const source = fakeSource("OpenSubtitles", [
      {
        ref: "hrv-pal",
        lang: "hrv",
        releaseName: "Movie.2024.DVDRip.XviD-PAL",
        fps: 25,
        cues: transform(track, (time) => Math.round((time * 23.976) / 25)),
      },
      {
        ref: "eng-release",
        lang: "eng",
        releaseName: "Movie.2024.1080p.BluRay.x264-GROUP",
        cues: transform(track, (time) => time + 300),
      },
      {
        ref: "eng-web",
        lang: "eng",
        releaseName: "Movie.2024.720p.WEB-DL-ANY",
        cues: transform(track, (time) => time - 100),
      },
      {
        ref: "fre-web",
        lang: "fre",
        releaseName: "Movie.2024.720p.WEB-DL-ANY",
        cues: transform(track, (time) => time - 100),
      },
    ]);
    const app = appWith({ listed: [source], references: [] });

    const { url } = await firstRefAt(app, sealed({ languages: ["hrv"] }), anchored(fileName));

    const served = await servedAt(app, url);
    const expected = transform(track, (time) => time - 100);

    expect(
      Math.max(
        ...served.map(({ start }, index) => Math.abs(start - (expected[index]?.start ?? 0))),
      ),
    ).toBeLessThanOrEqual(2);
  });

  it("keeps today's entry when nothing names a timing anchor", async () => {
    const source = fakeSource("OpenSubtitles", [
      { ref: "hrv-shifted", lang: "hrv", cues: shifted },
      { ref: "eng", lang: "eng", cues: track },
    ]);
    const app = appWith({ listed: [source], references: [] });

    const { url, ref } = await firstRefAt(
      app,
      sealed({ languages: ["hrv"] }),
      "movie/tt0111161.json",
    );

    expect(ref.a).toBeUndefined();
    expect(startsOf(await servedAt(app, url))).toEqual(startsOf(shifted));
  });

  it("decides the anchor once for every language of the file", async () => {
    const source = hashAnchored();
    const app = appWith({ listed: [source], references: [] });

    const { body } = await list(app, sealed({ languages: ["hrv", "fre"] }), anchored(fileName));

    await servedAt(app, body.subtitles[0]?.url ?? "");
    await servedAt(app, body.subtitles[1]?.url ?? "");

    expect(source.download.mock.calls.filter(([ref]) => ref === "eng-again")).toHaveLength(1);
  });

  it("decides the anchor once for concurrent requests of the file", async () => {
    const source = hashAnchored();
    const app = appWith({ listed: [source], references: [] });

    const { body } = await list(app, sealed({ languages: ["hrv", "fre"] }), anchored(fileName));

    await Promise.all(body.subtitles.map(({ url }) => servedAt(app, url)));

    expect(source.download.mock.calls.filter(([ref]) => ref === "eng-again")).toHaveLength(1);
  });

  it("decides the anchor after the listing, before any subtitle is fetched", async () => {
    const state = memorySharedState();
    const set = vi.spyOn(state, "set");
    const deferred: Promise<unknown>[] = [];
    const app = appWith(
      { listed: [hashAnchored()], references: [] },
      { state, defer: (work) => deferred.push(work) },
    );

    await list(app, sealed({ languages: ["hrv"] }), anchored(fileName));
    await Promise.all(deferred);

    expect(
      set.mock.calls
        .filter(([key]) => key.startsWith("anchor:"))
        .map(([, value, seconds]) => [value, seconds]),
    ).toEqual([["2", 2_592_000]]);
  });

  it("downloads nothing after a listing once the file's anchor is decided", async () => {
    const source = hashAnchored();
    const deferred: Promise<unknown>[] = [];
    const app = appWith(
      { listed: [source], references: [] },
      { defer: (work) => deferred.push(work) },
    );

    await list(app, sealed({ languages: ["hrv"] }), anchored(fileName));
    await Promise.all(deferred);
    source.download.mockClear();

    await list(app, sealed({ languages: ["hrv"] }), anchored(fileName));
    await Promise.all(deferred);

    expect(source.download).not.toHaveBeenCalled();
  });

  it("hides a candidate that mismatches the file's hash reference under a trusted anchor", async () => {
    const source = fakeSource("OpenSubtitles", [
      { ref: "hrv-wrong", lang: "hrv", cues: unrelated },
      { ref: "hrv-right", lang: "hrv", cues: shifted },
      { ref: "eng-hash", lang: "eng", hashMatch: true, cues: track },
      { ref: "eng-again", lang: "eng", cues: transform(track, (time) => time + 40) },
    ]);
    const app = appWith({ listed: [source], references: [] });

    const { url } = await firstRefAt(
      app,
      sealed({ languages: ["hrv", "eng"] }),
      anchored(fileName),
    );

    expect(startsOf(await servedAt(app, url))).toEqual(startsOf(track));
  });

  it("times to the release-name anchor when the only hash match is metered", async () => {
    const later = transform(track, (time) => time + 1000);
    const listed = fakeSource("OpenSubtitles", [
      { ref: "hrv-shifted", lang: "hrv", cues: shifted },
      {
        ref: "eng-release",
        lang: "eng",
        releaseName: "Movie.2024.1080p.BluRay.x264-GROUP",
        cues: later,
      },
      {
        ref: "eng-again",
        lang: "eng",
        releaseName: "Movie.2024.720p.WEB-DL-ANY",
        cues: transform(later, (time) => time + 40),
      },
    ]);
    const references = fakeSource("OpenSubtitles API", [
      { ref: "hrv-hash", lang: "hrv", hashMatch: true, metered: true, cues: track },
    ]);
    const app = appWith({ listed: [listed], references: [references] });

    const { url, ref } = await firstRefAt(app, sealed({ languages: ["hrv"] }), anchored(fileName));

    expect(ref.a?.[0]?.r).toBe("eng-release");
    expect(ref.x).toEqual([]);
    expect(startsOf(await servedAt(app, url))).toEqual(startsOf(later));
  });

  it("keeps the hash flag of an anchor the other listing matched", async () => {
    const app = appWith(hashAware());
    const token = sealed();
    const name = encodeURIComponent("Modern Family S01E23 Hawaii  (1080p x265 10bit Joy).mkv");

    await list(
      app,
      token,
      `series/tt1442437:1:23/filename=${name}&videoSize=227584187&videoHash=3e0c5471cdc9cb0e.json`,
    );

    const { ref } = await firstRefAt(app, token, `series/tt1442437:1:23/filename=${name}.json`);

    expect(ref.a?.[0]).toEqual({ n: "Fake", r: "disc", l: "eng", h: 1 });
  });

  it("keeps an untrusted decision for ten minutes when a guard cannot be downloaded", async () => {
    const state = memorySharedState();
    const set = vi.spyOn(state, "set");
    const source = fakeSource("OpenSubtitles", [
      { ref: "hrv-shifted", lang: "hrv", cues: shifted },
      { ref: "fre-shifted", lang: "fre", cues: shifted },
      { ref: "eng-hash", lang: "eng", hashMatch: true, cues: track },
      { ref: "eng-broken", lang: "eng" },
    ]);
    const app = appWith({ listed: [source], references: [] }, { state });

    const { body } = await list(app, sealed({ languages: ["hrv", "fre"] }), anchored(fileName));

    await servedAt(app, body.subtitles[0]?.url ?? "");
    await servedAt(app, body.subtitles[1]?.url ?? "");

    expect(
      set.mock.calls
        .filter(([key]) => key.startsWith("anchor:"))
        .map(([, value, seconds]) => [value, seconds]),
    ).toEqual([["-1", 600]]);
  });

  it("serves without an anchor when a guard outlasts the deadline, and decides again later", async () => {
    const state = memorySharedState();
    const set = vi.spyOn(state, "set");
    const source = fakeSource("OpenSubtitles", [
      { ref: "hrv-shifted", lang: "hrv", cues: shifted },
      { ref: "eng-hash", lang: "eng", hashMatch: true, cues: track },
      { ref: "eng-hanging", lang: "eng", hang: true },
      { ref: "eng-again", lang: "eng", cues: transform(track, (time) => time + 40) },
    ]);
    const app = appWith({ listed: [source], references: [] }, { state });

    const { url } = await firstRefAt(app, sealed({ languages: ["hrv"] }), anchored(fileName));

    expect(startsOf(await servedAt(app, url))).toEqual(startsOf(shifted));
    expect(set.mock.calls.filter(([key]) => key.startsWith("anchor:"))).toEqual([]);
  }, 20_000);

  it("takes no anchor from a matching resolution alone", async () => {
    const source = fakeSource("OpenSubtitles", [
      { ref: "hrv-shifted", lang: "hrv", cues: shifted },
      { ref: "eng", lang: "eng", releaseName: "Movie.2024.1080p.HDTV.x264-OTHER", cues: track },
    ]);

    const { ref } = await firstRefAt(
      appWith({ listed: [source], references: [] }),
      sealed({ languages: ["hrv"] }),
      anchored("Movie.2024.1080p.mkv"),
    );

    expect(ref.a).toBeUndefined();
  });

  it("skips a subtitle whose timing agrees with no other subtitle of the video, as a commentary track", async () => {
    const source = fakeSource("OpenSubtitles", [
      { ref: "hrv-commentary", lang: "hrv", cues: unrelated },
      { ref: "hrv-shifted", lang: "hrv", cues: shifted },
      { ref: "eng", lang: "eng", cues: track },
      { ref: "fre", lang: "fre", cues: transform(track, (time) => time + 40) },
      { ref: "deu", lang: "deu", cues: transform(track, (time) => time - 500) },
    ]);
    const app = appWith({ listed: [source], references: [] });

    const { url, ref } = await firstRefAt(
      app,
      sealed({ languages: ["hrv"] }),
      anchored("Movie.2024.1080p.mkv"),
    );

    expect(ref.a).toBeUndefined();
    expect(ref.c.map(({ r }) => r)).toEqual(["hrv-commentary", "hrv-shifted"]);
    expect(startsOf(await servedAt(app, url))).toEqual(startsOf(shifted));
  });

  it("serves a candidate with as good a release name as the anchor without retiming it", async () => {
    const source = fakeSource("OpenSubtitles", [
      {
        ref: "eng-release",
        lang: "eng",
        releaseName: "Movie.2024.1080p.BluRay.x264-GROUP",
        cues: track,
      },
      {
        ref: "hrv-release",
        lang: "hrv",
        releaseName: "Movie.2024.1080p.BluRay.x264-GROUP",
        cues: shifted,
      },
      {
        ref: "eng-again",
        lang: "eng",
        releaseName: "Movie.2024.720p.WEB-DL-ANY",
        cues: transform(track, (time) => time + 40),
      },
    ]);
    const app = appWith({ listed: [source], references: [] });

    const { url, ref } = await firstRefAt(app, sealed({ languages: ["hrv"] }), anchored(fileName));

    expect(ref.a?.[0]?.r).toBe("eng-release");
    expect(ref.c[0]?.e).toBe(1);
    expect(startsOf(await servedAt(app, url))).toEqual(startsOf(shifted));
  });

  it("downloads no reference under a trusted anchor", async () => {
    const references = fakeSource("OpenSubtitles API", [
      { ref: "hrv-hash", lang: "hrv", hashMatch: true, metered: true, cues: track },
    ]);
    const listed = fakeSource("OpenSubtitles", [
      { ref: "hrv-shifted", lang: "hrv", cues: shifted },
      { ref: "fre-hash", lang: "fre", hashMatch: true, cues: track },
      { ref: "fre-again", lang: "fre", cues: transform(track, (time) => time + 40) },
    ]);
    const app = appWith({ listed: [listed], references: [references] });

    const { url, ref } = await firstRefAt(app, sealed({ languages: ["hrv"] }), anchored(fileName));

    expect(ref.x).toEqual([]);
    expect(startsOf(await servedAt(app, url))).toEqual(startsOf(track));
    expect(references.download).not.toHaveBeenCalled();
  });

  it("serves Gilmore Girls S05E17 in Croatian retimed to its DVD timing", async () => {
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
    const app = appWith({ listed: [source], references: [] });

    const { body } = await list(
      app,
      sealed({ languages: ["hrv", "eng"] }),
      `series/tt0238784:5:17/filename=${encodeURIComponent("Gilmore Girls (2000) - S05E17 - Pulp Friction (1080p BluRay x265 Celdra).mkv")}.json`,
    );

    const [hrv, eng] = await Promise.all(body.subtitles.map(({ url }) => servedAt(app, url)));

    const shifts = (hrv ?? []).map((cue, index) => cue.start - (hrvBroadcast[index]?.start ?? 0));

    expect(refOf(body.subtitles[0]?.url ?? "").a?.[0]?.r).toBe("eng-dvd-hi");
    expect(median(shifts.slice(0, 60))).toBeGreaterThan(700);
    expect(median(shifts.slice(0, 60))).toBeLessThan(1900);
    expect(median(shifts.slice(-60))).toBeGreaterThan(2700);
    expect(median(shifts.slice(-60))).toBeLessThan(3800);
    expect(startsOf(eng ?? [])).toEqual(startsOf(gilmoreSpans("engDvdHearingImpaired")));
  }, 60_000);
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

  it("lists OpenSubtitles once next to a login", () => {
    const sources = sourcesFromConfig(
      {
        ...config,
        sources: [
          { kind: "stremio-addon", url: "https://opensubtitles-v3.strem.io/manifest.json" },
          { kind: "subdl", apiKey: "key" },
          { kind: "opensubtitles", username: "user", password: "pass" },
        ],
      },
      { tokens: memoryTokenCache(), state: memorySharedState(), openSubtitlesAppKey: "app-key" },
    );

    expect(names(sources.listed)).toEqual(["OpenSubtitles", "SubDL"]);
    expect(sources.references).toEqual([]);
  });

  it("lists OpenSubtitles for a login alone", () => {
    const sources = sourcesFromConfig(
      { ...config, sources: [{ kind: "opensubtitles", username: "user", password: "pass" }] },
      { tokens: memoryTokenCache(), state: memorySharedState(), openSubtitlesAppKey: "app-key" },
    );

    expect(names(sources.listed)).toEqual(["OpenSubtitles"]);
    expect(sources.references).toEqual([]);
  });

  it("lists an install link sealed before the API through the API", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      String(input).startsWith("https://api.opensubtitles.com")
        ? new Response(JSON.stringify(restHashFixture))
        : new Response(JSON.stringify(v3HashFixture)),
    );
    const token =
      "AQrayQZPwhMYhSSTE58xMGB5hEuVQGaI4Hp1uTmhVH2LKFWGrItvNzps_aM5E2DrS52IGLaGSVaGZl6KUieNrhcrdfgr7vqkj0_v52VFmgEh0gdhs7q-EaTTAwxr1z9NE05n0HoO97SsGVVfm_lrl0xu0wyiG2uWLhefwDpiYrxg2rP01k5eDGLaqGWeKIA-3slv771UxxbW9EqsAOMbDLG-ur8EJs3goz0fbWkU31HXW0SItY29wRw5OtyRAmqDpDBVjaB5JT9WlOV6j3nXD2fHk0NcOIXPkxneqp48KgKsEMUugGM2Ppp3cD12n1fI9FVHVkyIGTF6eY92W0pYJOUH4v9BkNPQsZa45OaAlnetejwkfvghDGixyQ";

    vi.stubGlobal("fetch", fetchMock);

    const app = createApp({ secret: "a".repeat(32), openSubtitlesAppKey: "app-key" });
    const { body } = await list(app, token, "movie/tt0046183.json");

    expect(fetchMock.mock.calls.map(([url]) => String(url)).toSorted()).toEqual([
      "https://api.opensubtitles.com/api/v1/subtitles?imdb_id=46183&languages=en,hr&order_by=download_count&order_direction=desc",
      "https://opensubtitles-v3.strem.io/subtitles/movie/tt0046183.json",
    ]);
    expect(body.subtitles.map(({ id, label }) => [id, label])).toEqual([
      ["eng-best", "OpenSubtitles"],
      ["hrv-best", "OpenSubtitles"],
    ]);
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

  it("lists each OpenSubtitles row once next to a login, through v3 where it can", async () => {
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
      found
        .flat()
        .map(({ sourceName, ref, hashMatch, metered }) => [
          sourceName,
          ref.slice(-10),
          hashMatch,
          metered === true,
        ]),
    ).toEqual([
      ["OpenSubtitles", "735363", true, true],
      ["OpenSubtitles", "1953315756", true, false],
      ["OpenSubtitles", "12038440", false, true],
      ["OpenSubtitles", "1953294863", false, false],
      ["OpenSubtitles", "enc=cp1250", false, false],
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
