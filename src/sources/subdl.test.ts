import { zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import movieFixture from "../../test/fixtures/sources/subdl-search-movie.json" with { type: "json" };
import seriesFixture from "../../test/fixtures/sources/subdl-search.json" with { type: "json" };
import { parseRelease } from "../subtitles/release.ts";
import type { VideoQuery } from "./source.ts";
import { subdlSource } from "./subdl.ts";

const apiKey = "key-abc123";
const signal = () => AbortSignal.timeout(1000);
const encoder = new TextEncoder();

const movie: VideoQuery = {
  type: "movie",
  imdbId: "tt0111161",
  languages: ["hrv", "eng", "pob"],
};

const episode: VideoQuery = {
  type: "series",
  imdbId: "tt0903747",
  season: 1,
  episode: 2,
  languages: ["hrv", "eng"],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

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

const downloadBody = (bytes: Uint8Array) => new Response(Buffer.from(bytes));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("subdlSource search", () => {
  it("searches a movie with mapped languages and maps the rows", async () => {
    const fetchMock = stubFetch(json(movieFixture));

    const candidates = await subdlSource(apiKey).search(movie, signal());

    expect(urlOf(fetchMock, 0)).toBe(
      "https://api.subdl.com/api/v1/subtitles?api_key=key-abc123&imdb_id=tt0111161&languages=hr%2Cen%2Cbr_pt&type=movie&subs_per_page=30",
    );
    expect(candidates).toEqual([
      {
        sourceName: "SubDL",
        ref: "/subtitle/200-1.zip",
        lang: "hrv",
        release: parseRelease("The.Shawshank.Redemption.1994.1080p.BluRay-GRP"),
        releaseName: "The.Shawshank.Redemption.1994.1080p.BluRay-GRP",
        hashMatch: false,
        fps: undefined,
      },
      {
        sourceName: "SubDL",
        ref: "/subtitle/201-1.zip",
        lang: "pob",
        release: parseRelease("Shawshank Redemption"),
        releaseName: "Shawshank Redemption",
        hashMatch: false,
        fps: undefined,
      },
      {
        sourceName: "SubDL",
        ref: "/subtitle/202-1.zip",
        lang: "por",
        release: parseRelease("Shawshank.PT"),
        releaseName: "Shawshank.PT",
        hashMatch: false,
        fps: undefined,
      },
      {
        sourceName: "SubDL",
        ref: "/subtitle/203-1.zip",
        lang: "eng",
        release: parseRelease("Shawshank.EN"),
        releaseName: "Shawshank.EN",
        hashMatch: false,
        fps: undefined,
      },
    ]);
  });

  it("sends season and episode for a series and keeps matching rows with episode refs", async () => {
    const fetchMock = stubFetch(json(seriesFixture));

    const candidates = await subdlSource(apiKey).search(episode, signal());

    expect(urlOf(fetchMock, 0)).toBe(
      "https://api.subdl.com/api/v1/subtitles?api_key=key-abc123&imdb_id=tt0903747&languages=hr%2Cen&type=tv&season_number=1&episode_number=2&subs_per_page=30",
    );
    expect(candidates.map(({ ref }) => ref)).toEqual([
      "/subtitle/100-1.zip#S01E02",
      "/subtitle/101-1.zip#S01E02",
      "/subtitle/102-1.zip#S01E02",
      "/subtitle/103-1.zip#S01E02",
    ]);
  });

  it("does not send languages without a SubDL code", async () => {
    const fetchMock = stubFetch(json({ status: true, subtitles: [] }));

    await subdlSource(apiKey).search({ ...movie, languages: ["hrv", "xxx"] }, signal());

    expect(urlOf(fetchMock, 0)).toContain("languages=hr&");
  });

  it("makes no request when no language maps", async () => {
    const fetchMock = stubFetch();

    const candidates = await subdlSource(apiKey).search({ ...movie, languages: ["xxx"] }, signal());

    expect(candidates).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-2xx response", () => json({ status: true, subtitles: [] }, 500)],
    ["status false", () => json({ status: false, statusCode: 403, error: "not_authorized" })],
    ["a non-JSON body", () => new Response("oops")],
  ])("returns no candidates for %s", async (_name, response) => {
    stubFetch(response());

    expect(await subdlSource(apiKey).search(movie, signal())).toEqual([]);
  });

  it("skips a row that fails validation", async () => {
    stubFetch(
      json({ status: true, subtitles: [{ language: 5, url: "/subtitle/1-1.zip" }, "junk"] }),
    );

    expect(await subdlSource(apiKey).search(movie, signal())).toEqual([]);
  });
});

describe("subdlSource download", () => {
  it("downloads an episode ref on a fresh source and picks the episode entry", async () => {
    const fetchMock = stubFetch(
      downloadBody(zip({ "Show.S01E01.srt": "one", "Show.S01E02.srt": "two" })),
    );

    const bytes = await subdlSource(apiKey).download("/subtitle/100-1.zip#S01E02", signal());

    expect(new TextDecoder().decode(bytes)).toBe("two");
    expect(urlOf(fetchMock, 0)).toBe("https://dl.subdl.com/subtitle/100-1.zip");
  });

  it("picks the largest entry for a movie ref", async () => {
    stubFetch(downloadBody(zip({ "a.srt": "short", "b.srt": "the longest one" })));

    const bytes = await subdlSource(apiKey).download("/subtitle/200-1.zip", signal());

    expect(new TextDecoder().decode(bytes)).toBe("the longest one");
  });

  it.each([
    "https://evil.example/subtitle/1-1.zip",
    "/subtitle/../x.zip",
    "/subtitle/1-1.zip#S1E2",
    "/subtitle/1-1.rar",
    "",
  ])("rejects the malformed ref %j without a request", async (ref) => {
    const fetchMock = stubFetch();

    await expect(subdlSource(apiKey).download(ref, signal())).rejects.toThrow(
      "SubDL download failed",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-2xx response", () => new Response("no", { status: 404 })],
    ["a non-zip body", () => new Response("not a zip")],
    ["no subtitle entry", () => downloadBody(zip({ "readme.txt": "hi" }))],
  ])("fails for %s", async (_name, response) => {
    stubFetch(response());

    await expect(subdlSource(apiKey).download("/subtitle/1-1.zip", signal())).rejects.toThrow(
      "SubDL download failed",
    );
  });

  it("never puts the API key in an error", async () => {
    stubFetch(new Response("no", { status: 500 }));

    const error = await subdlSource(apiKey)
      .download("/subtitle/1-1.zip", signal())
      .catch((caught: Error) => caught);

    expect(String((error as Error).message)).not.toContain(apiKey);
  });
});
