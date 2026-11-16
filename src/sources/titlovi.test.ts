import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import loginFixture from "../../test/fixtures/sources/titlovi-login.json" with { type: "json" };
import seriesFixture from "../../test/fixtures/sources/titlovi-search-series.json" with { type: "json" };
import searchFixture from "../../test/fixtures/sources/titlovi-search.json" with { type: "json" };
import { parseRelease } from "../subtitles/release.ts";
import type { VideoQuery } from "./source.ts";
import { titloviSource } from "./titlovi.ts";
import type { TokenCache } from "./token-cache.ts";
import { memoryTokenCache } from "./test-sources.ts";

const credentials = { username: "alice", password: "secret" };
const signal = () => AbortSignal.timeout(1000);
const base = "https://kodi.titlovi.com/api/subtitles";
const loginURL = `${base}/gettoken?username=alice&password=secret&json=true`;
const cacheKey = createHash("sha256").update("titlovi:alice").digest("hex");
const encoder = new TextEncoder();

const movie: VideoQuery = {
  type: "movie",
  imdbId: "tt0111161",
  languages: ["hrv", "srp", "eng"],
};

const episode: VideoQuery = {
  type: "series",
  imdbId: "tt0903747",
  season: 1,
  episode: 2,
  languages: ["hrv"],
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("titloviSource search", () => {
  it("logs in with the credentials in the query and searches a movie", async () => {
    const fetchMock = stubFetch(json(loginFixture), json(searchFixture));

    const candidates = await titloviSource(credentials, memoryTokenCache()).search(movie, signal());

    expect(urlOf(fetchMock, 0)).toBe(loginURL);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(urlOf(fetchMock, 1)).toBe(
      `${base}/search?imdbID=tt0111161&json=true&lang=English|Hrvatski|Srpski&token=00000000-0000-4000-8000-000000000001&userid=100042`,
    );
    expect(candidates).toEqual([
      {
        sourceName: "Titlovi.com",
        ref: "1:304729",
        lang: "srp",
        release: parseRelease(
          "REMASTERED.1080p.BluRay.H264.AAC-RARBG, REMASTERED.1080p.BluRay.x264-AMIABLE",
        ),
        releaseName: "REMASTERED.1080p.BluRay.H264.AAC-RARBG, REMASTERED.1080p.BluRay.x264-AMIABLE",
        hashMatch: false,
        fps: undefined,
      },
      {
        sourceName: "Titlovi.com",
        ref: "1:286652",
        lang: "hrv",
        release: parseRelease("REMASTERED.1080p.BluRay.x264-AMIABLE"),
        releaseName: "REMASTERED.1080p.BluRay.x264-AMIABLE",
        hashMatch: false,
        fps: undefined,
      },
      {
        sourceName: "Titlovi.com",
        ref: "1:36001",
        lang: "srp",
        release: parseRelease("Night Of The Living Dead"),
        releaseName: "Night Of The Living Dead",
        hashMatch: false,
        fps: undefined,
      },
    ]);
  });

  it("drops a row in a language it does not know", async () => {
    stubFetch(
      json(loginFixture),
      json({ SubtitleResults: [{ Id: 1, Type: 1, Title: "T", Release: "x", Lang: "Klingon" }] }),
    );

    const candidates = await titloviSource(credentials, memoryTokenCache()).search(movie, signal());

    expect(candidates).toEqual([]);
  });

  it("sends season and episode for a series and drops other episodes", async () => {
    const fetchMock = stubFetch(json(loginFixture), json(seriesFixture));

    const candidates = await titloviSource(credentials, memoryTokenCache()).search(
      { type: "series", imdbId: "tt0238784", season: 5, episode: 17, languages: ["hrv"] },
      signal(),
    );

    expect(urlOf(fetchMock, 1)).toBe(
      `${base}/search?episode=17&imdbID=tt0238784&json=true&lang=Hrvatski&season=5&token=00000000-0000-4000-8000-000000000001&userid=100042`,
    );
    expect(candidates.map((candidate) => candidate.ref)).toEqual(["2:116680:S05E17"]);
  });

  it.each([
    ["hrv", "Hrvatski"],
    ["srp", "Srpski"],
    ["bos", "Bosanski"],
    ["slv", "Slovenski"],
    ["mkd", "Makedonski"],
    ["eng", "English"],
  ])("maps %s to %s and back", async (code, name) => {
    const fetchMock = stubFetch(
      json(loginFixture),
      json({
        SubtitleResults: [
          {
            Id: 1,
            Type: 1,
            Title: "T",
            Release: "",
            Lang: name,
            Season: -1,
            Episode: -1,
            Rating: 1,
          },
        ],
      }),
    );

    const candidates = await titloviSource(credentials, memoryTokenCache()).search(
      { ...movie, languages: [code] },
      signal(),
    );

    expect(urlOf(fetchMock, 1)).toContain(`lang=${name}&`);
    expect(candidates.map((candidate) => candidate.lang)).toEqual([code]);
  });

  it("returns nothing for a series query without a season", async () => {
    stubFetch(
      json(loginFixture),
      json({
        SubtitleResults: [{ Id: 1, Type: 2, Title: "T", Release: "", Lang: "Hrvatski", Rating: 1 }],
      }),
    );

    const candidates = await titloviSource(credentials, memoryTokenCache()).search(
      { type: "series", imdbId: "tt0238784", languages: ["hrv"] },
      signal(),
    );

    expect(candidates).toEqual([]);
  });

  it("returns nothing without a request when no language is supported", async () => {
    const fetchMock = stubFetch();

    const candidates = await titloviSource(credentials, memoryTokenCache()).search(
      { ...movie, languages: ["jpn"] },
      signal(),
    );

    expect(candidates).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs in again once and retries after a 401", async () => {
    const fetchMock = stubFetch(
      json(loginFixture),
      new Response("", { status: 401 }),
      json({ ...loginFixture, Token: "tok-2" }),
      json(searchFixture),
    );

    const candidates = await titloviSource(credentials, memoryTokenCache()).search(movie, signal());

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(urlOf(fetchMock, 2)).toBe(loginURL);
    expect(urlOf(fetchMock, 3)).toContain("token=tok-2");
    expect(candidates).toHaveLength(3);
  });

  it("gives up after a second 401", async () => {
    const fetchMock = stubFetch(
      json(loginFixture),
      new Response("", { status: 401 }),
      json(loginFixture),
      new Response("", { status: 401 }),
    );

    const candidates = await titloviSource(credentials, memoryTokenCache()).search(movie, signal());

    expect(candidates).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("returns nothing for other failures and a null result list", async () => {
    stubFetch(json(loginFixture), new Response("", { status: 500 }));

    const failed = await titloviSource(credentials, memoryTokenCache()).search(movie, signal());

    stubFetch(json(loginFixture), json({ SubtitleResults: null }));

    const empty = await titloviSource(credentials, memoryTokenCache()).search(movie, signal());

    expect(failed).toEqual([]);
    expect(empty).toEqual([]);
  });

  it("reuses the cached token within its lifetime", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-14T10:00:00Z"), toFake: ["Date"] });

    const tokens = memoryTokenCache();
    const fetchMock = stubFetch(json(loginFixture), json(searchFixture), json(searchFixture));
    const source = titloviSource(credentials, tokens);

    await source.search(movie, signal());
    await source.search(movie, signal());

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(urlOf(fetchMock, 2)).toContain(
      "token=00000000-0000-4000-8000-000000000001&userid=100042",
    );
    expect(JSON.parse((await tokens.get(cacheKey)) ?? "null")).toEqual({
      token: "00000000-0000-4000-8000-000000000001",
      userId: 100042,
    });
  });

  it("reads the expiry as Zagreb time and stores the token until ten minutes before it", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-23T16:34:29.350Z"), toFake: ["Date"] });

    const set = vi.fn<TokenCache["set"]>(async () => {});
    const fetchMock = stubFetch(json(loginFixture), json(searchFixture));

    await titloviSource(credentials, { get: async () => undefined, set }).search(movie, signal());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenCalledWith(cacheKey, expect.any(String), 1200);
  });

  it("reads the expiry in Zagreb summer time when the clocks change before it", async () => {
    vi.useFakeTimers({ now: new Date("2030-03-30T12:00:00Z"), toFake: ["Date"] });

    const set = vi.fn<TokenCache["set"]>(async () => {});

    stubFetch(
      json({ ...loginFixture, ExpirationDate: "2030-03-31T12:00:00" }),
      json(searchFixture),
    );

    await titloviSource(credentials, { get: async () => undefined, set }).search(movie, signal());

    expect(set).toHaveBeenCalledWith(cacheKey, expect.any(String), 78600);
  });

  it("logs in again when the cached value is not valid JSON", async () => {
    const tokens = memoryTokenCache();
    const fetchMock = stubFetch(json(loginFixture), json(searchFixture));

    await tokens.set(cacheKey, "not json", 600);

    await titloviSource(credentials, tokens).search(movie, signal());

    expect(urlOf(fetchMock, 0)).toBe(loginURL);
  });

  it("fails the login without leaking the password or the body", async () => {
    stubFetch(new Response("bad password secret", { status: 403 }));

    const error = await titloviSource(credentials, memoryTokenCache())
      .search(movie, signal())
      .catch((caught: unknown) => caught);

    expect(error).toEqual(new Error("Titlovi.com login failed"));
    expect(String((error as Error).message)).not.toContain("secret");
  });

  it("sends no Authorization header", async () => {
    const fetchMock = stubFetch(json(loginFixture), json(searchFixture));

    await titloviSource(credentials, memoryTokenCache()).search(movie, signal());

    fetchMock.mock.calls.forEach(([, init]) =>
      expect(new Headers(init?.headers).has("Authorization")).toBe(false),
    );
  });
});

const zip = (files: Record<string, string>) =>
  zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, encoder.encode(text)])),
  );

const downloadBody = (bytes: Uint8Array) => new Response(Buffer.from(bytes));

describe("titloviSource download", () => {
  it("requests the archive without a token and picks the episode entry", async () => {
    const fetchMock = stubFetch(
      downloadBody(
        zip({
          "Show.S01E01.srt": "one",
          "Show.s01e02.srt": "two",
          "Show.S01E03.srt": "three",
        }),
      ),
    );

    const bytes = await titloviSource(credentials, memoryTokenCache()).download(
      "3:2001:S01E02",
      signal(),
    );

    expect(new TextDecoder().decode(bytes)).toBe("two");
    expect(urlOf(fetchMock, 0)).toBe("https://titlovi.com/download/?type=3&mediaid=2001");

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);

    expect(headers.get("User-Agent")).toBe("Mozilla/5.0 (compatible; SubsOnTime)");
    expect(headers.get("Referer")).toBe("https://titlovi.com");
    expect(headers.has("Authorization")).toBe(false);
  });

  it("picks a three-digit episode entry and not the shorter one it starts with", async () => {
    stubFetch(
      downloadBody(zip({ "Show.S01E10.srt": "ten-long-entry", "Show.S01E100.srt": "hundred" })),
    );

    const bytes = await titloviSource(credentials, memoryTokenCache()).download(
      "3:2001:S01E100",
      signal(),
    );

    expect(new TextDecoder().decode(bytes)).toBe("hundred");
  });

  it("puts a three-digit episode in the ref", async () => {
    stubFetch(
      json(loginFixture),
      json({
        SubtitleResults: [
          {
            Id: 7,
            Type: 3,
            Title: "T",
            Release: "",
            Lang: "Hrvatski",
            Season: 1,
            Episode: 100,
            Rating: 1,
          },
        ],
      }),
    );

    const candidates = await titloviSource(credentials, memoryTokenCache()).search(
      { ...episode, episode: 100 },
      signal(),
    );

    expect(candidates.map((candidate) => candidate.ref)).toEqual(["3:7:S01E100"]);
  });

  it("picks the largest subtitle entry when no episode is requested", async () => {
    stubFetch(
      downloadBody(
        zip({ "readme.txt": "x".repeat(100), "a.srt": "short", "b.srt": "the longest one" }),
      ),
    );

    const bytes = await titloviSource(credentials, memoryTokenCache()).download("1:1001", signal());

    expect(new TextDecoder().decode(bytes)).toBe("the longest one");
  });

  it.each(["", "1", "1:", "a:1", "1:2:S1E2", "1:2:S01E02:x", "1:2:foo"])(
    "rejects the malformed ref %j without a request",
    async (ref) => {
      const fetchMock = stubFetch();

      await expect(
        titloviSource(credentials, memoryTokenCache()).download(ref, signal()),
      ).rejects.toThrow("Titlovi.com download failed");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a non-zip body", () => new Response("not a zip")],
    ["no subtitle entry", () => downloadBody(zip({ "readme.txt": "hi" }))],
    ["a failed response", () => new Response("", { status: 500 })],
  ])("throws for %s", async (_name, response) => {
    stubFetch(response());

    await expect(
      titloviSource(credentials, memoryTokenCache()).download("1:1", signal()),
    ).rejects.toThrow("Titlovi.com download failed");
  });
});
