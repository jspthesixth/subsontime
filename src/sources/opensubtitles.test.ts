import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import downloadFixture from "../../test/fixtures/sources/opensubtitles-rest-download.json" with { type: "json" };
import loginFixture from "../../test/fixtures/sources/opensubtitles-rest-login.json" with { type: "json" };
import quotaFixture from "../../test/fixtures/sources/opensubtitles-rest-download-quota.json" with { type: "json" };
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

const flaggedEntry = (fileId: number, foreignPartsOnly: unknown) => ({
  attributes: {
    language: "en",
    release: "Inglourious.Basterds.2009.1080p.BluRay.x265-RARBG",
    foreign_parts_only: foreignPartsOnly,
    files: [{ file_id: fileId }],
  },
});

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
        ref: "4440067",
        lang: "eng",
        release: parseRelease("Night.of.the.Living.Dead.1968.REMASTERED.720p.BluRay.X264-AMIABLE"),
        releaseName: "Night.of.the.Living.Dead.1968.REMASTERED.720p.BluRay.X264-AMIABLE",
        hashMatch: false,
        fps: 23.976,
      },
      {
        sourceName: "OpenSubtitles",
        ref: "11916325",
        lang: "hrv",
        release: parseRelease("Night Of The Living Dead {1968} - Horror, Thriller 7,8"),
        releaseName: "Night Of The Living Dead {1968} - Horror, Thriller 7,8",
        hashMatch: false,
        fps: 23.976,
      },
      {
        sourceName: "OpenSubtitles",
        ref: "4439353",
        lang: "hrv",
        release: parseRelease("DVDRIP DIVX5 AC3-WRIST"),
        releaseName: "DVDRIP DIVX5 AC3-WRIST",
        hashMatch: false,
        fps: undefined,
      },
      {
        sourceName: "OpenSubtitles",
        ref: "4439397",
        lang: "srp",
        release: parseRelease("BW.FS.BRRip.AC3.XviD-SHiRK"),
        releaseName: "BW.FS.BRRip.AC3.XviD-SHiRK",
        hashMatch: false,
        fps: 23.976,
      },
    ]);
  });

  it("maps a regional language and drops entries without a file or a known language", async () => {
    stubFetch(
      json({
        data: [
          { attributes: { language: "pt-BR", files: [{ file_id: 502 }, { file_id: 503 }] } },
          { attributes: { language: "en", files: [] } },
          { attributes: { language: "xx", files: [{ file_id: 504 }] } },
        ],
      }),
    );

    const candidates = await openSubtitlesSource(undefined, appKey, memoryTokenCache()).search(
      movie,
      signal(),
    );

    expect(candidates.map(({ ref, lang }) => [ref, lang])).toEqual([["502", "pob"]]);
  });

  it("keeps a subtitle whose release is null", async () => {
    stubFetch(
      json({
        data: [{ attributes: { language: "en", release: null, files: [{ file_id: 505 }] } }],
      }),
    );

    const candidates = await openSubtitlesSource(undefined, appKey, memoryTokenCache()).search(
      movie,
      signal(),
    );

    expect(candidates.map(({ ref, releaseName }) => [ref, releaseName])).toEqual([
      ["505", undefined],
    ]);
  });

  it("marks the subtitles flagged as foreign parts only", async () => {
    stubFetch(
      json({ data: [flaggedEntry(601, true), flaggedEntry(602, false), flaggedEntry(603, 1)] }),
    );

    const candidates = await openSubtitlesSource(undefined, appKey, memoryTokenCache()).search(
      movie,
      signal(),
    );

    expect(candidates.map(({ ref, foreignPartsOnly }) => [ref, foreignPartsOnly])).toEqual([
      ["601", true],
      ["602", undefined],
      ["603", undefined],
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

  it("signs in again once when OpenSubtitles refuses the cached token", async () => {
    const fetchMock = stubFetch(
      json(loginFixture),
      json(downloadFixture),
      new Response(fileBytes),
      json({ message: "You cannot consume this service", status: 401 }, 401),
      json(loginFixture),
      json(downloadFixture),
      new Response(fileBytes),
    );
    const source = openSubtitlesSource(credentials, appKey, memoryTokenCache());

    await source.download("501", signal());

    expect(await source.download("501", signal())).toEqual(fileBytes);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${baseURL}/login`,
      "https://vip-api.opensubtitles.com/api/v1/download",
      downloadFixture.link,
      "https://vip-api.opensubtitles.com/api/v1/download",
      `${baseURL}/login`,
      "https://vip-api.opensubtitles.com/api/v1/download",
      downloadFixture.link,
    ]);
  });

  it("signs in again only once", async () => {
    const refused = () => json({ message: "You cannot consume this service", status: 401 }, 401);
    const fetchMock = stubFetch(json(loginFixture), refused(), json(loginFixture), refused());

    await expect(
      openSubtitlesSource(credentials, appKey, memoryTokenCache()).download("501", signal()),
    ).rejects.toThrow("Download failed with status 401");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("remembers used-up downloads until the reset time OpenSubtitles gives", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-16T17:00:00Z"));

    const fetchMock = stubFetch(
      json(loginFixture),
      json(quotaFixture, 406),
      json(downloadFixture),
      new Response(fileBytes),
    );
    const source = openSubtitlesSource(credentials, appKey, memoryTokenCache());

    await expect(source.download("501", signal())).rejects.toThrow(
      "Download failed with status 406",
    );
    await expect(source.download("501", signal())).rejects.toThrow(
      "The OpenSubtitles downloads of this account are used up",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.parse("2026-11-17T00:00:01Z"));

    expect(await source.download("501", signal())).toEqual(fileBytes);
    expect(fetchMock).toHaveBeenCalledTimes(4);
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

  it("logs in again when the cached session is not JSON", async () => {
    const tokens = memoryTokenCache();
    const fetchMock = stubFetch(json(loginFixture), json(downloadFixture), new Response(fileBytes));

    await tokens.set(createHash("sha256").update("alice").digest("hex"), "not json", 600);

    expect(
      await openSubtitlesSource(credentials, appKey, tokens).download("501", signal()),
    ).toEqual(fileBytes);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${baseURL}/login`);
  });

  it("downloads from the default address when the login names a host outside OpenSubtitles", async () => {
    const fetchMock = stubFetch(
      json({ ...loginFixture, base_url: "evil.example" }),
      json(downloadFixture),
      new Response(fileBytes),
    );

    await openSubtitlesSource(credentials, appKey, memoryTokenCache()).download("501", signal());

    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.opensubtitles.com/api/v1/download");
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
