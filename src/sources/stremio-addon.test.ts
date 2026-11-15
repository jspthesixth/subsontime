import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../../test/fixtures/sources/opensubtitles-v3-movie.json" with { type: "json" };
import { parseRelease } from "../subtitles/release.ts";
import type { VideoQuery } from "./source.ts";
import { openSubtitlesV3, parseStremioId, stremioAddonSource } from "./stremio-addon.ts";

const movie: VideoQuery = { type: "movie", imdbId: "tt0111161", languages: ["eng", "pob"] };

const stubFetch = (body: BodyInit, init?: ResponseInit) => {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(body, init));

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseStremioId", () => {
  it("reads a series id", () => {
    expect(parseStremioId("series", "tt0903747:1:1")).toEqual({
      type: "series",
      imdbId: "tt0903747",
      season: 1,
      episode: 1,
    });
  });

  it("reads a movie id", () => {
    expect(parseStremioId("movie", "tt0111161")).toEqual({ type: "movie", imdbId: "tt0111161" });
  });

  it.each([
    ["channel", "tt0111161"],
    ["movie", "kitsu:1"],
    ["series", "tt0903747"],
    ["series", "tt0903747:a:1"],
    ["series", "tt0903747:1:1:1"],
  ])("rejects %s %s", (type, id) => {
    expect(() => parseStremioId(type, id)).toThrow("Unsupported video id");
  });
});

describe("stremioAddonSource", () => {
  it("keeps an entry whose id is a number", async () => {
    stubFetch(
      JSON.stringify({
        subtitles: [{ id: 42, url: "https://subs.example.com/42.srt", lang: "eng" }],
      }),
    );

    const candidates = await stremioAddonSource(
      "https://subs.example.com/manifest.json",
      "subs.example.com",
    ).search(movie, AbortSignal.timeout(1000));

    expect(candidates.map(({ ref }) => ref)).toEqual(["https://subs.example.com/42.srt"]);
  });

  it("maps the OpenSubtitles v3 response to candidates", async () => {
    stubFetch(JSON.stringify(fixture));

    const candidates = await openSubtitlesV3.search(movie, AbortSignal.timeout(1000));

    expect(candidates).toHaveLength(7);
    expect(candidates[0]).toEqual({
      sourceName: "OpenSubtitles",
      ref: "https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/36919",
      lang: "eng",
      release: parseRelease("sawshank_redemption_engl.srt"),
      releaseName: "sawshank_redemption_engl.srt",
      hashMatch: false,
      fps: 23.98,
    });
    expect(candidates.map((candidate) => candidate.lang)).not.toContain("hrv");
  });

  it("marks hash matches", async () => {
    stubFetch(JSON.stringify({ subtitles: [{ url: "https://x/1", lang: "eng", m: "h" }] }));

    const [candidate] = await openSubtitlesV3.search(movie, AbortSignal.timeout(1000));

    expect(candidate).toMatchObject({ hashMatch: true, fps: undefined, releaseName: undefined });
  });

  it("requests a series with all extras", async () => {
    const fetchMock = stubFetch(JSON.stringify({ subtitles: [] }));

    await stremioAddonSource("https://addon.example/abc/manifest.json", "Addon").search(
      {
        type: "series",
        imdbId: "tt0903747",
        season: 1,
        episode: 2,
        videoHash: "8e245d9679d31e12",
        videoSize: 12909756,
        filename: "Breaking Bad S01E02.mkv",
        languages: ["eng"],
      },
      AbortSignal.timeout(1000),
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://addon.example/abc/subtitles/series/tt0903747:1:2/videoHash=8e245d9679d31e12&videoSize=12909756&filename=Breaking%20Bad%20S01E02.mkv.json",
    );
  });

  it("requests a movie without extras", async () => {
    const fetchMock = stubFetch(JSON.stringify({ subtitles: [] }));

    await openSubtitlesV3.search(movie, AbortSignal.timeout(1000));

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://opensubtitles-v3.strem.io/subtitles/movie/tt0111161.json",
    );
  });

  it("returns no candidates for an HTML response", async () => {
    stubFetch("<html>Bad gateway</html>", { status: 502 });

    await expect(openSubtitlesV3.search(movie, AbortSignal.timeout(1000))).resolves.toEqual([]);
  });

  it("returns no candidates for a 200 response with an HTML body", async () => {
    stubFetch("<html>Welcome</html>");

    await expect(openSubtitlesV3.search(movie, AbortSignal.timeout(1000))).resolves.toEqual([]);
  });

  it("rejects a series query without season and episode", async () => {
    stubFetch(JSON.stringify({ subtitles: [] }));

    await expect(
      openSubtitlesV3.search({ ...movie, type: "series" }, AbortSignal.timeout(1000)),
    ).rejects.toThrow("Unsupported video id");
  });

  it("downloads the body bytes", async () => {
    stubFetch(new Uint8Array([1, 2, 3]));

    await expect(
      openSubtitlesV3.download("https://x/1", AbortSignal.timeout(1000)),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it("throws when a download fails", async () => {
    stubFetch("nope", { status: 404 });

    await expect(
      openSubtitlesV3.download("https://x/1", AbortSignal.timeout(1000)),
    ).rejects.toThrow("status 404");
  });
});
