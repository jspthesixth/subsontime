import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import downloadFixture from "../../test/fixtures/sources/opensubtitles-rest-download.json" with { type: "json" };
import loginFixture from "../../test/fixtures/sources/opensubtitles-rest-login.json" with { type: "json" };
import searchFixture from "../../test/fixtures/sources/opensubtitles-rest-search.json" with { type: "json" };
import packageJSON from "../../package.json" with { type: "json" };
import { parseRelease } from "../subtitles/release.ts";
import { openSubtitlesSource } from "./opensubtitles.ts";
import type { VideoQuery } from "./source.ts";
import { memoryTokenCache } from "./test-sources.ts";

const credentials = { username: "alice", password: "secret" };
const appKey = "app-key";
const signal = () => AbortSignal.timeout(1000);
const userAgent = `SubsOnTime v${packageJSON.version}`;
const baseURL = "https://api.opensubtitles.com/api/v1";
const hash = "8e245d9679d31e12";

const movie: VideoQuery = {
  type: "movie",
  imdbId: "tt0111161",
  videoHash: hash,
  languages: ["hrv", "eng"],
};

const episode: VideoQuery = {
  type: "series",
  imdbId: "tt0903747",
  season: 1,
  episode: 2,
  languages: ["eng"],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const stubFetch = (...responses: Response[]) => {
  const fetchMock = vi.fn<typeof fetch>();

  responses.forEach((response) => fetchMock.mockResolvedValueOnce(response));
  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
};

const headersOf = (fetchMock: ReturnType<typeof stubFetch>, call: number) =>
  new Headers(fetchMock.mock.calls[call]?.[1]?.headers);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("openSubtitlesSource search", () => {
  it("maps the response to candidates", async () => {
    stubFetch(json(searchFixture));

    const candidates = await openSubtitlesSource(undefined, appKey, memoryTokenCache()).search(
      movie,
      signal(),
    );

    expect(candidates).toEqual([
      {
        sourceName: "OpenSubtitles",
        ref: "501",
        lang: "hrv",
        release: parseRelease("The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP"),
        releaseName: "The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP",
        hashMatch: true,
        fps: 23.976,
      },
      {
        sourceName: "OpenSubtitles",
        ref: "502",
        lang: "pob",
        release: parseRelease("Shawshank.Redemption.720p.WEB-DL"),
        releaseName: "Shawshank.Redemption.720p.WEB-DL",
        hashMatch: false,
        fps: undefined,
      },
    ]);
  });

  it("requests a movie with a hash using sorted parameters and no authorization", async () => {
    const fetchMock = stubFetch(json({ data: [] }));

    await openSubtitlesSource(credentials, appKey, memoryTokenCache()).search(movie, signal());

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${baseURL}/subtitles?imdb_id=111161&languages=en,hr&moviehash=${hash}`,
    );
    expect(headersOf(fetchMock, 0).get("Authorization")).toBeNull();
    expect(headersOf(fetchMock, 0).get("Api-Key")).toBe(appKey);
    expect(headersOf(fetchMock, 0).get("User-Agent")).toBe(userAgent);
    expect(headersOf(fetchMock, 0).get("Accept")).toBe("application/json");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requests an episode by its parent", async () => {
    const fetchMock = stubFetch(json({ data: [] }));

    await openSubtitlesSource(undefined, appKey, memoryTokenCache()).search(episode, signal());

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${baseURL}/subtitles?episode_number=2&languages=en&parent_imdb_id=903747&season_number=1`,
    );
  });

  it("returns nothing for a failed request", async () => {
    stubFetch(json({ message: "no" }, 500));

    expect(
      await openSubtitlesSource(undefined, appKey, memoryTokenCache()).search(movie, signal()),
    ).toEqual([]);
  });
});

describe("openSubtitlesSource download", () => {
  const fileBytes = new Uint8Array([1, 2, 3]);

  it("logs in once and reuses the token within its lifetime", async () => {
    vi.useFakeTimers();

    const fetchMock = stubFetch(
      json(loginFixture),
      json(downloadFixture),
      new Response(fileBytes),
      json(downloadFixture),
      new Response(fileBytes),
    );
    const source = openSubtitlesSource(credentials, appKey, memoryTokenCache());

    await source.download("501", signal());
    vi.advanceTimersByTime(11 * 60 * 60 * 1000);
    await source.download("501", signal());

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${baseURL}/login`,
      "https://vip-api.opensubtitles.com/api/v1/download",
      downloadFixture.link,
      "https://vip-api.opensubtitles.com/api/v1/download",
      downloadFixture.link,
    ]);
  });

  it("logs in again after 12 hours", async () => {
    vi.useFakeTimers();

    const fetchMock = stubFetch(
      json(loginFixture),
      json(downloadFixture),
      new Response(fileBytes),
      json(loginFixture),
      json(downloadFixture),
      new Response(fileBytes),
    );
    const source = openSubtitlesSource(credentials, appKey, memoryTokenCache());

    await source.download("501", signal());
    vi.advanceTimersByTime(12 * 60 * 60 * 1000 + 1);
    await source.download("501", signal());

    expect(fetchMock.mock.calls.filter(([url]) => url === `${baseURL}/login`)).toHaveLength(2);
  });

  it("caches the token under the SHA-256 of the username", async () => {
    const tokens = memoryTokenCache();

    stubFetch(json(loginFixture), json(downloadFixture), new Response(fileBytes));

    await openSubtitlesSource(credentials, appKey, tokens).download("501", signal());

    const cached = await tokens.get(createHash("sha256").update("alice").digest("hex"));

    expect(JSON.parse(cached ?? "null")).toEqual({
      token: "fixture-token",
      baseURL: "https://vip-api.opensubtitles.com/api/v1",
    });
  });

  it("downloads with the bearer token from the user's base URL", async () => {
    const fetchMock = stubFetch(json(loginFixture), json(downloadFixture), new Response(fileBytes));

    const bytes = await openSubtitlesSource(credentials, appKey, memoryTokenCache()).download(
      "501",
      signal(),
    );

    expect(bytes).toEqual(fileBytes);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ username: "alice", password: "secret" }),
    );
    expect(headersOf(fetchMock, 0).get("Content-Type")).toBe("application/json");
    expect(headersOf(fetchMock, 0).get("User-Agent")).toBe(userAgent);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://vip-api.opensubtitles.com/api/v1/download");
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ file_id: 501 }));
    expect(headersOf(fetchMock, 1).get("Authorization")).toBe("Bearer fixture-token");
    expect(headersOf(fetchMock, 1).get("Api-Key")).toBe(appKey);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(downloadFixture.link);
  });

  it("downloads without credentials and without authorization", async () => {
    const fetchMock = stubFetch(json(downloadFixture), new Response(fileBytes));

    await openSubtitlesSource(undefined, appKey, memoryTokenCache()).download("501", signal());

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${baseURL}/download`);
    expect(headersOf(fetchMock, 0).get("Authorization")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails a login without leaking the response", async () => {
    stubFetch(json({ message: "bad secret" }, 401));

    const download = openSubtitlesSource(credentials, appKey, memoryTokenCache()).download(
      "501",
      signal(),
    );

    await expect(download).rejects.toThrow(/^OpenSubtitles login failed$/);
  });

  it("throws for a failed download", async () => {
    stubFetch(json({ message: "quota" }, 406));

    await expect(
      openSubtitlesSource(undefined, appKey, memoryTokenCache()).download("501", signal()),
    ).rejects.toThrow("Download failed with status 406");
  });
});
