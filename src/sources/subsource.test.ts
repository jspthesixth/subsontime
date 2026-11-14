import { zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import subtitlesFixture from "../../test/fixtures/sources/subsource-subtitles.json" with { type: "json" };
import titleFixture from "../../test/fixtures/sources/subsource-title.json" with { type: "json" };
import { parseRelease } from "../subtitles/release.ts";
import type { VideoQuery } from "./source.ts";
import { subSourceSource } from "./subsource.ts";

const apiKey = "key-abc123";
const signal = () => AbortSignal.timeout(1000);
const encoder = new TextEncoder();
const base = "https://api.subsource.net/api/v1";

const movie: VideoQuery = { type: "movie", imdbId: "tt0111161", languages: ["hrv", "eng", "xxx"] };
const episode: VideoQuery = {
  type: "series",
  imdbId: "tt0903747",
  season: 1,
  episode: 2,
  languages: ["eng"],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const rows = (data: unknown[]) => json({ success: true, data });

const stubFetch = (...responses: Response[]) => {
  const fetchMock = vi.fn<typeof fetch>();

  responses.forEach((response) => fetchMock.mockResolvedValueOnce(response));
  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
};

const urlOf = (fetchMock: ReturnType<typeof stubFetch>, call: number) =>
  String(fetchMock.mock.calls[call]?.[0]);

const zip = (files: Record<string, string>) =>
  zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, encoder.encode(text)])),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("subSourceSource search", () => {
  it("looks up a movie then lists one request per mapped language", async () => {
    const fetchMock = stubFetch(json(titleFixture), rows([]), rows([]));

    await subSourceSource(apiKey).search(movie, signal());

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(urlOf(fetchMock, 0)).toBe(
      `${base}/movies/search?searchType=imdb&imdb=tt0111161&type=movie`,
    );
    expect(urlOf(fetchMock, 1)).toBe(
      `${base}/subtitles?movieId=777&language=croatian&page=1&limit=50`,
    );
    expect(urlOf(fetchMock, 2)).toBe(
      `${base}/subtitles?movieId=777&language=english&page=1&limit=50`,
    );
  });

  it("sends the key only in the X-API-Key header", async () => {
    const fetchMock = stubFetch(json(titleFixture), rows([]), rows([]));

    await subSourceSource(apiKey).search(movie, signal());

    expect(fetchMock.mock.calls.map(([url]) => String(url)).join(" ")).not.toContain(apiKey);
    fetchMock.mock.calls.forEach(([, init]) =>
      expect(init?.headers).toEqual({ "X-API-Key": apiKey }),
    );
  });

  it("adds the season to the title lookup for a series", async () => {
    const fetchMock = stubFetch(json(titleFixture), rows([]));

    await subSourceSource(apiKey).search(episode, signal());

    expect(urlOf(fetchMock, 0)).toBe(
      `${base}/movies/search?searchType=imdb&imdb=tt0903747&type=series&season=1`,
    );
  });

  it("makes no request when no language maps", async () => {
    const fetchMock = stubFetch();

    const candidates = await subSourceSource(apiKey).search(
      { ...movie, languages: ["xxx"] },
      signal(),
    );

    expect(candidates).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns nothing and skips the listing when the title has no match", async () => {
    const fetchMock = stubFetch(rows([]));

    const candidates = await subSourceSource(apiKey).search(movie, signal());

    expect(candidates).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns nothing when the title lookup is not a success", async () => {
    stubFetch(json({ success: false }, 500));

    expect(await subSourceSource(apiKey).search(movie, signal())).toEqual([]);
  });

  it("keeps the other languages when one listing fails", async () => {
    stubFetch(
      json(titleFixture),
      json({ success: false }, 500),
      rows([{ subtitleId: 5, releaseInfo: ["Movie.1080p.BluRay-GRP"], framerate: 24 }]),
    );

    const candidates = await subSourceSource(apiKey).search(movie, signal());

    expect(candidates).toEqual([
      {
        sourceName: "SubSource",
        ref: "5",
        lang: "eng",
        release: parseRelease("Movie.1080p.BluRay-GRP"),
        releaseName: "Movie.1080p.BluRay-GRP",
        hashMatch: false,
        fps: 24,
      },
    ]);
  });

  it("keeps the other languages when one listing rejects", async () => {
    stubFetch(json(titleFixture), rows([{ subtitleId: 6, commentary: "note" }]));
    vi.mocked(fetch).mockRejectedValueOnce(new Error("boom"));

    const candidates = await subSourceSource(apiKey).search(movie, signal());

    expect(candidates.map((candidate) => candidate.ref)).toEqual(["6"]);
  });

  it("returns nothing when a fetch rejects", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error(`${base}?x=1`));

    vi.stubGlobal("fetch", fetchMock);

    expect(await subSourceSource(apiKey).search(movie, signal())).toEqual([]);
  });

  it("filters episodes, keeps packs and builds episode refs", async () => {
    stubFetch(json(titleFixture), json(subtitlesFixture));

    const candidates = await subSourceSource(apiKey).search(episode, signal());

    expect(candidates).toEqual([
      {
        sourceName: "SubSource",
        ref: "1001#S01E02",
        lang: "eng",
        release: parseRelease("Show.S01E02.1080p.WEB-DL-GRP"),
        releaseName: "Show.S01E02.1080p.WEB-DL-GRP",
        hashMatch: false,
        fps: 23.976,
      },
      {
        sourceName: "SubSource",
        ref: "1003#S01E02",
        lang: "eng",
        release: parseRelease("Show season 1 complete pack"),
        releaseName: "Show season 1 complete pack",
        hashMatch: false,
        fps: undefined,
      },
    ]);
  });

  it("does not match S01E10 against S01E100 and reads numeric string framerates", async () => {
    stubFetch(json(titleFixture), json(subtitlesFixture));

    const tenth = await subSourceSource(apiKey).search({ ...episode, episode: 10 }, signal());

    expect(tenth.map((candidate) => candidate.ref)).toEqual(["1003#S01E10", "1004#S01E10"]);
    expect(tenth.map((candidate) => candidate.fps)).toEqual([undefined, undefined]);

    stubFetch(json(titleFixture), json(subtitlesFixture));

    const third = await subSourceSource(apiKey).search({ ...episode, episode: 3 }, signal());

    expect(third.find((candidate) => candidate.ref === "1002#S01E03")?.fps).toBe(25);
  });
});

describe("subSourceSource download", () => {
  it("downloads an episode ref on a fresh source and picks the tagged entry", async () => {
    const fetchMock = stubFetch(
      new Response(Buffer.from(zip({ "Show.S01E01.srt": "one", "Show.S01E02.srt": "two" }))),
    );

    const bytes = await subSourceSource(apiKey).download("1001#S01E02", signal());

    expect(urlOf(fetchMock, 0)).toBe(`${base}/subtitles/1001/download`);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ "X-API-Key": apiKey });
    expect(new TextDecoder().decode(bytes)).toBe("two");
  });

  it("rejects a malformed ref without a request", async () => {
    const fetchMock = stubFetch();

    await expect(subSourceSource(apiKey).download("../1", signal())).rejects.toThrow(
      "SubSource download failed",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails on a non-zip body", async () => {
    stubFetch(new Response("not a zip"));

    await expect(subSourceSource(apiKey).download("1", signal())).rejects.toThrow(
      "SubSource download failed",
    );
  });

  it("fails on a non-2xx response", async () => {
    stubFetch(new Response("no", { status: 404 }));

    await expect(subSourceSource(apiKey).download("1", signal())).rejects.toThrow(
      "SubSource download failed",
    );
  });
});
