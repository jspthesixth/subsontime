import { afterEach, describe, expect, it, vi } from "vitest";
import downloadFixture from "../../test/fixtures/sources/opensubtitles-rest-download.json" with { type: "json" };
import restFixture from "../../test/fixtures/sources/opensubtitles-rest-hash-search.json" with { type: "json" };
import v3Fixture from "../../test/fixtures/sources/opensubtitles-v3-hash-movie.json" with { type: "json" };
import { memorySharedState, type SharedState } from "../jobs/shared-state.ts";
import {
  budgetedDownloads,
  downloadBudget,
  openSubtitlesListing,
  type DownloadBudget,
} from "./opensubtitles-hash.ts";
import { openSubtitlesSource } from "./opensubtitles.ts";
import type { Candidate, VideoQuery } from "./source.ts";
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

const listingFixture = {
  ...restFixture,
  data: restFixture.data.map((entry) => ({
    ...entry,
    attributes: { ...entry.attributes, moviehash_match: false },
  })),
};

const withStringIds = (fixture: typeof restFixture) => ({
  ...fixture,
  data: fixture.data.map((entry) => ({
    ...entry,
    attributes: {
      ...entry.attributes,
      legacy_subtitle_id: String(entry.attributes.legacy_subtitle_id),
    },
  })),
});

type Stub = { restStatus?: number; listing?: unknown; matches?: unknown };

const stubAPIs = ({
  restStatus = 200,
  listing = listingFixture,
  matches = restFixture,
}: Stub = {}) => {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = urlOf(input);

    if (url.startsWith(v3ListingURL)) {
      return new Response(JSON.stringify(v3Fixture));
    }

    if (url.startsWith(restSearchURL)) {
      return new Response(JSON.stringify(url.includes("order_by=") ? listing : matches), {
        status: restStatus,
      });
    }

    if (url.endsWith("/download")) {
      return new Response(JSON.stringify(downloadFixture));
    }

    return new Response(fileBytes);
  });

  vi.stubGlobal("fetch", fetchMock);

  return {
    calls: () => fetchMock.mock.calls.map(([url]) => urlOf(url)),
    restSearches: () =>
      fetchMock.mock.calls.filter(([url]) => urlOf(url).startsWith(restSearchURL)),
    restDownloads: () => fetchMock.mock.calls.filter(([url]) => urlOf(url).endsWith("/download")),
  };
};

const openBudget = (left = true): DownloadBudget => ({
  left: async () => left,
  spend: async () => left,
});

const sourceWith = (state: SharedState = memorySharedState(), budget = openBudget()) =>
  openSubtitlesListing({
    manifestURL,
    name: "OpenSubtitles",
    appKey: "app-key",
    state,
    budget,
    rest: budgetedDownloads(
      openSubtitlesSource(undefined, "app-key", memoryTokenCache()),
      budget,
      state,
    ),
  });

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

const amiableV3URL =
  "https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/1953294863";
const croatianV3URL =
  "https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/1952547961?senc=cp1250";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("openSubtitlesListing search", () => {
  it("lists the REST rows, through v3 where v3 has them, then the rows only v3 lists", async () => {
    stubAPIs();

    const candidates = await sourceWith().search(peterPan, signal());

    expect(summary(candidates)).toEqual([
      ["735363", "hrv", true, true],
      [matchedV3URL, "eng", true, false],
      ["12038440", "eng", false, true],
      [amiableV3URL, "eng", false, false],
      [croatianV3URL, "hrv", false, false],
    ]);
    expect(candidates.every(({ sourceName }) => sourceName === "OpenSubtitles")).toBe(true);
  });

  it("keeps the v3 release name of a row v3 has", async () => {
    stubAPIs();

    const candidates = await sourceWith().search(peterPan, signal());

    expect(candidates.map(({ releaseName, fps }) => [releaseName, fps]).slice(0, 4)).toEqual([
      ["Peter.Pan.1953.1080p.BluRay.x264.YIFY-srp", 25],
      ["Peter.Pan.1953.720p.BluRay.x264.YIFY.srt", 47.952],
      ["Peter.Pan.1953.1080p.BluRay.x265-RARBG.en", undefined],
      ["Peter.Pan.1953.1080p.BluRay.X264-AMIABLE.srt", 23.976],
    ]);
  });

  it("asks REST for page 1 by downloads, the hash on its own, and v3 for the file", async () => {
    const { calls } = stubAPIs();

    await sourceWith().search(peterPan, signal());

    expect(calls().toSorted()).toEqual([
      `${restSearchURL}?imdb_id=46183&languages=en,hr&moviehash=466d8f728dbe2142`,
      `${restSearchURL}?imdb_id=46183&languages=en,hr&order_by=download_count&order_direction=desc`,
      "https://opensubtitles-v3.strem.io/subtitles/movie/tt0046183/videoHash=466d8f728dbe2142&videoSize=1394609539.json",
    ]);
  });

  it("lists without a hash search when the request has no hash", async () => {
    const { calls } = stubAPIs();

    const candidates = await sourceWith().search(
      { ...peterPan, videoHash: undefined, videoSize: undefined },
      signal(),
    );

    expect(summary(candidates)).toEqual([
      ["735363", "hrv", false, true],
      [matchedV3URL, "eng", false, false],
      ["12038440", "eng", false, true],
      [amiableV3URL, "eng", false, false],
      [croatianV3URL, "hrv", false, false],
    ]);
    expect(calls().filter((url) => url.includes("moviehash"))).toEqual([]);
  });

  it("carries the REST foreign parts flag onto the v3 rows", async () => {
    const flagged = new Set([4770753, 4749227]);
    const withFlags = <T extends typeof listingFixture>(fixture: T) => ({
      ...fixture,
      data: fixture.data.map((entry) => ({
        ...entry,
        attributes: {
          ...entry.attributes,
          foreign_parts_only: flagged.has(entry.attributes.legacy_subtitle_id),
        },
      })),
    });

    stubAPIs({ listing: withFlags(listingFixture), matches: withFlags(restFixture) });

    const candidates = await sourceWith().search(peterPan, signal());

    expect(candidates.map(({ ref, foreignPartsOnly }) => [ref, foreignPartsOnly])).toEqual([
      ["735363", undefined],
      [matchedV3URL, true],
      [amiableV3URL, true],
      ["12038440", undefined],
      [croatianV3URL, undefined],
    ]);
  });

  it("joins a numeric v3 id to a legacy id sent as a string", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      urlOf(input).startsWith(v3ListingURL)
        ? new Response(
            JSON.stringify({
              subtitles: v3Fixture.subtitles.map((entry) => ({ ...entry, id: Number(entry.id) })),
            }),
          )
        : new Response(JSON.stringify(withStringIds(restFixture))),
    );

    vi.stubGlobal("fetch", fetchMock);

    const candidates = await sourceWith().search(peterPan, signal());

    expect(candidates.filter(({ metered }) => metered !== true).map(({ ref }) => ref)).toEqual([
      matchedV3URL,
      amiableV3URL,
      croatianV3URL,
    ]);
  });

  it("leaves out the REST-only rows once the download budget is spent", async () => {
    stubAPIs();

    const candidates = await sourceWith(memorySharedState(), openBudget(false)).search(
      peterPan,
      signal(),
    );

    expect(summary(candidates)).toEqual([
      [matchedV3URL, "eng", true, false],
      [amiableV3URL, "eng", false, false],
      [croatianV3URL, "hrv", false, false],
    ]);
  });

  it("serves the v3 listing alone and retries REST later when REST fails", async () => {
    const { restSearches } = stubAPIs({ restStatus: 429 });

    const source = sourceWith();

    const candidates = await source.search(peterPan, signal());

    await source.search(peterPan, signal());

    expect(summary(candidates)).toEqual([
      [amiableV3URL, "eng", false, false],
      [matchedV3URL, "eng", false, false],
      [croatianV3URL, "hrv", false, false],
    ]);
    expect(restSearches()).toHaveLength(4);
  });

  it("shares the REST and v3 listings between installs for a day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-16T12:00:00Z"));

    const { calls } = stubAPIs();

    const state = memorySharedState();

    await sourceWith(state).search(peterPan, signal());

    const second = await sourceWith(state).search(peterPan, signal());

    vi.setSystemTime(Date.parse("2026-11-17T12:00:01Z"));
    await sourceWith(state).search(peterPan, signal());

    expect(calls()).toHaveLength(6);
    expect(summary(second)[1]).toEqual([matchedV3URL, "eng", true, false]);
  });

  it("stops searching REST past five searches in one second across installs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-15T12:00:00.100Z"));

    const { restSearches } = stubAPIs();

    const state = memorySharedState();
    const files = Array.from({ length: 6 }, (_, index) => ({
      ...peterPan,
      videoHash: `466d8f728dbe214${index}`,
    }));

    await Promise.all(files.map((file) => sourceWith(state).search(file, signal())));

    expect(restSearches()).toHaveLength(5);
  });
});

describe("openSubtitlesListing download", () => {
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
