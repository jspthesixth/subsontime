import { afterEach, describe, expect, it, vi } from "vitest";
import downloadFixture from "../../test/fixtures/sources/opensubtitles-rest-download.json" with { type: "json" };
import restFixture from "../../test/fixtures/sources/opensubtitles-rest-hash-search.json" with { type: "json" };
import v3Fixture from "../../test/fixtures/sources/opensubtitles-v3-hash-movie.json" with { type: "json" };
import { memorySharedState, type SharedState } from "../jobs/shared-state.ts";
import {
  budgetedDownloads,
  downloadBudget,
  openSubtitlesHashSource,
  sharedListing,
  type DownloadBudget,
} from "./opensubtitles-hash.ts";
import { openSubtitlesSource } from "./opensubtitles.ts";
import type { Candidate, VideoQuery } from "./source.ts";
import { stremioAddonSource } from "./stremio-addon.ts";
import { memoryTokenCache } from "./test-sources.ts";

const manifestURL = "https://opensubtitles-v3.strem.io/manifest.json";
const restSearchURL = "https://api.opensubtitles.com/api/v1/subtitles";
const v3ListingURL = "https://opensubtitles-v3.strem.io/subtitles/";
const matchedV3URL =
  "https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/1953315756";
const fileBytes = new Uint8Array([1, 2, 3]);

const peterPan: VideoQuery = {
  type: "movie",
  imdbId: "tt0046183",
  videoHash: "466d8f728dbe2142",
  videoSize: 1394609539,
  languages: ["eng", "hrv"],
};

const urlOf = (input: Parameters<typeof fetch>[0]) =>
  input instanceof Request ? input.url : String(input);

const stubAPIs = ({ restStatus = 200 }: { restStatus?: number } = {}) => {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = urlOf(input);

    if (url.startsWith(v3ListingURL)) {
      return new Response(JSON.stringify(v3Fixture));
    }

    if (url.startsWith(restSearchURL)) {
      return new Response(JSON.stringify(restFixture), { status: restStatus });
    }

    if (url.endsWith("/download")) {
      return new Response(JSON.stringify(downloadFixture));
    }

    return new Response(fileBytes);
  });

  vi.stubGlobal("fetch", fetchMock);

  return {
    restSearches: () =>
      fetchMock.mock.calls.filter(([url]) => urlOf(url).startsWith(restSearchURL)),
    restDownloads: () => fetchMock.mock.calls.filter(([url]) => urlOf(url).endsWith("/download")),
  };
};

const openBudget = (left = true): DownloadBudget => ({
  left: async () => left,
  spend: async () => left,
});

const sourceWith = (state: SharedState = memorySharedState(), budget = openBudget()) => {
  const rest = budgetedDownloads(
    openSubtitlesSource(undefined, "app-key", memoryTokenCache()),
    budget,
    state,
  );

  return openSubtitlesHashSource({
    manifestURL,
    name: "OpenSubtitles",
    appKey: "app-key",
    state,
    budget,
    rest,
    listing: sharedListing(manifestURL, "OpenSubtitles"),
  });
};

const fail = async () => {
  throw new Error("down");
};

const failingState = (): SharedState => ({
  get: fail,
  set: fail,
  setIfAbsent: fail,
  delete: fail,
  increment: fail,
  deleteIfEquals: fail,
  expireIfEquals: fail,
});

const signal = () => AbortSignal.timeout(1000);

const summary = (candidates: Candidate[]) =>
  candidates.map(({ ref, lang, hashMatch, metered }) => [ref, lang, hashMatch, metered === true]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("openSubtitlesHashSource search", () => {
  it("marks the v3 entry whose id is a REST hash match and adds the match v3 does not list", async () => {
    stubAPIs();

    const candidates = await sourceWith().search(peterPan, signal());

    expect(summary(candidates)).toEqual([
      [
        "https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/1953294863",
        "eng",
        false,
        false,
      ],
      [matchedV3URL, "eng", true, false],
      [
        "https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/1952547961?senc=cp1250",
        "hrv",
        false,
        false,
      ],
      ["735363", "hrv", true, true],
    ]);
    expect(candidates.every(({ sourceName }) => sourceName === "OpenSubtitles")).toBe(true);
  });

  it("joins a numeric v3 id to a legacy id sent as a string", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      urlOf(input).startsWith(v3ListingURL)
        ? new Response(
            JSON.stringify({
              subtitles: v3Fixture.subtitles.map((entry) => ({ ...entry, id: Number(entry.id) })),
            }),
          )
        : new Response(
            JSON.stringify({
              ...restFixture,
              data: restFixture.data.map((entry) => ({
                ...entry,
                attributes: {
                  ...entry.attributes,
                  legacy_subtitle_id: String(entry.attributes.legacy_subtitle_id),
                },
              })),
            }),
          ),
    );

    vi.stubGlobal("fetch", fetchMock);

    const candidates = await sourceWith().search(peterPan, signal());

    expect(candidates.filter(({ hashMatch }) => hashMatch).map(({ ref }) => ref)).toEqual([
      matchedV3URL,
      "735363",
    ]);
  });

  it("marks the v3 entries that REST flags as foreign parts only", async () => {
    const flagged = new Set([4770753, 4749227]);
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      urlOf(input).startsWith(v3ListingURL)
        ? new Response(JSON.stringify(v3Fixture))
        : new Response(
            JSON.stringify({
              ...restFixture,
              data: restFixture.data.map((entry) => ({
                ...entry,
                attributes: {
                  ...entry.attributes,
                  foreign_parts_only: flagged.has(entry.attributes.legacy_subtitle_id),
                },
              })),
            }),
          ),
    );

    vi.stubGlobal("fetch", fetchMock);

    const source = sourceWith();

    for (const candidates of [
      await source.search(peterPan, signal()),
      await source.search(peterPan, signal()),
    ]) {
      expect(
        candidates.map(({ ref, hashMatch, foreignPartsOnly }) => [
          ref,
          hashMatch,
          foreignPartsOnly,
        ]),
      ).toEqual([
        [
          "https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/1953294863",
          false,
          true,
        ],
        [matchedV3URL, true, true],
        [
          "https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/1952547961?senc=cp1250",
          false,
          undefined,
        ],
        ["735363", true, undefined],
      ]);
    }
  });

  it("adds a REST hash match for a language whose only listed hash match is foreign parts only", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      urlOf(input).startsWith(v3ListingURL)
        ? new Response(JSON.stringify(v3Fixture))
        : new Response(
            JSON.stringify({
              ...restFixture,
              data: restFixture.data.map((entry) => ({
                ...entry,
                attributes: {
                  ...entry.attributes,
                  moviehash_match:
                    entry.attributes.moviehash_match ||
                    entry.attributes.legacy_subtitle_id === 13605764,
                  foreign_parts_only: entry.attributes.legacy_subtitle_id === 4770753,
                },
              })),
            }),
          ),
    );

    vi.stubGlobal("fetch", fetchMock);

    const candidates = await sourceWith().search(peterPan, signal());

    expect(
      candidates
        .filter(({ hashMatch, foreignPartsOnly }) => hashMatch && foreignPartsOnly !== true)
        .map(({ ref, lang }) => [ref, lang]),
    ).toEqual([
      ["735363", "hrv"],
      ["12038440", "eng"],
    ]);
  });

  it("asks the REST search for the hash, the title and the languages", async () => {
    const { restSearches } = stubAPIs();

    await sourceWith().search(peterPan, signal());

    expect(restSearches().map(([url]) => urlOf(url))).toEqual([
      `${restSearchURL}?imdb_id=46183&languages=en,hr&moviehash=466d8f728dbe2142`,
    ]);
  });

  it("leaves out the REST-only match once the download budget is spent", async () => {
    stubAPIs();

    const candidates = await sourceWith(memorySharedState(), openBudget(false)).search(
      peterPan,
      signal(),
    );

    expect(candidates.map(({ ref }) => ref)).not.toContain("735363");
    expect(candidates.find(({ ref }) => ref === matchedV3URL)?.hashMatch).toBe(true);
  });

  it("searches REST once per title and file while the result is cached", async () => {
    const { restSearches } = stubAPIs();

    const source = sourceWith();

    await source.search(peterPan, signal());
    const second = await source.search(peterPan, signal());

    expect(restSearches()).toHaveLength(1);
    expect(second.find(({ ref }) => ref === matchedV3URL)?.hashMatch).toBe(true);
  });

  it("serves the v3 listing and retries later when the REST search fails", async () => {
    const { restSearches } = stubAPIs({ restStatus: 429 });

    const source = sourceWith();

    const candidates = await source.search(peterPan, signal());

    await source.search(peterPan, signal());

    expect(candidates.some(({ hashMatch }) => hashMatch)).toBe(false);
    expect(candidates).toHaveLength(3);
    expect(restSearches()).toHaveLength(2);
  });

  it("stops searching REST past five searches in one second", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-15T12:00:00.100Z"));

    const { restSearches } = stubAPIs();

    const source = sourceWith();
    const files = Array.from({ length: 6 }, (_, index) => ({
      ...peterPan,
      videoHash: `466d8f728dbe214${index}`,
    }));

    await Promise.all(files.map((file) => source.search(file, signal())));

    expect(restSearches()).toHaveLength(5);
  });

  it("lists exactly what the v3 addon lists without a hash", async () => {
    const { restSearches } = stubAPIs();

    const query = { ...peterPan, videoHash: undefined, videoSize: undefined };

    const candidates = await sourceWith().search(query, signal());

    expect(candidates).toEqual(
      await stremioAddonSource(manifestURL, "OpenSubtitles").search(query, signal()),
    );
    expect(restSearches()).toHaveLength(0);
  });
});

describe("openSubtitlesHashSource download", () => {
  it("downloads a joined match through its v3 URL without a REST download", async () => {
    const { restDownloads } = stubAPIs();

    expect(await sourceWith().download(matchedV3URL, signal())).toEqual(fileBytes);
    expect(restDownloads()).toHaveLength(0);
  });

  it("downloads a REST-only match through REST once and serves it from the cache after", async () => {
    const { restDownloads } = stubAPIs();

    const source = sourceWith();

    await source.download("735363", signal());

    expect(await source.download("735363", signal())).toEqual(fileBytes);
    expect(restDownloads()).toHaveLength(1);
  });

  it("refuses a REST download once the budget is spent", async () => {
    const { restDownloads } = stubAPIs();

    await expect(
      sourceWith(memorySharedState(), openBudget(false)).download("735363", signal()),
    ).rejects.toThrow("The OpenSubtitles download budget is spent");
    expect(restDownloads()).toHaveLength(0);
  });
});

describe("downloadBudget", () => {
  it("allows downloads up to the limit", async () => {
    const budget = downloadBudget(memorySharedState(), 2);

    expect([await budget.spend(), await budget.spend(), await budget.spend()]).toEqual([
      true,
      true,
      false,
    ]);
    expect(await budget.left()).toBe(false);
  });

  it("starts again on the next UTC day", async () => {
    let now = Date.parse("2026-11-15T23:59:00Z");
    const budget = downloadBudget(
      memorySharedState(() => now),
      1,
      () => now,
    );

    await budget.spend();

    const spentToday = await budget.spend();

    now = Date.parse("2026-11-16T00:01:00Z");

    expect(spentToday).toBe(false);
    expect(await budget.left()).toBe(true);
    expect(await budget.spend()).toBe(true);
  });

  it("allows nothing when the shared state fails", async () => {
    const budget = downloadBudget(failingState(), 4);

    expect([await budget.left(), await budget.spend()]).toEqual([false, false]);
  });

  it("keeps serving the v3 candidates when the shared state fails", async () => {
    stubAPIs();

    const state = failingState();
    const candidates = await sourceWith(state, downloadBudget(state, 4)).search(peterPan, signal());

    expect(candidates.map(({ ref }) => ref)).not.toContain("735363");
    expect(candidates.find(({ ref }) => ref === matchedV3URL)?.hashMatch).toBe(true);
  });
});
