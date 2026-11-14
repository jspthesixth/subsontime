import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { defaultConfig } from "../config/default-config.ts";
import { seal } from "../config/seal.ts";
import type { SourceSet } from "../sources/from-config.ts";
import { fakeSource } from "../sources/test-sources.ts";
import { memoryTokenCache } from "../sources/token-cache.ts";
import { syntheticTrack, transform } from "../timing/test-tracks.ts";

type CheckRow = {
  lang: string;
  source: string;
  release?: string;
  label: string;
  detail?: string;
  reason?: string;
};

type CheckResult = {
  shown: CheckRow[];
  leftOut: CheckRow[];
  reference?: string;
  searchedMs: number;
  sources: number;
};

const secret = "a-test-secret-that-is-long-enough-1234";
const track = syntheticTrack(1, 200);
const shifted = transform(track, (time) => time + 2000);
const unrelated = syntheticTrack(2, 200).map((cue) => ({ ...cue, text: `Wrong ${cue.text}` }));
const movie = { type: "movie", id: "tt0111161" };
const mismatchReason =
  "Made for another video. Its dialogue does not line up with this file anywhere.";

const appWith = (sources: SourceSet) =>
  createApp({
    secret,
    tokens: memoryTokenCache(),
    sourcesFor: () => sources,
    clientKey: (context) => context.req.header("x-test-client") ?? "none",
  });

const check = (app: ReturnType<typeof appWith>, body: unknown, client = "203.0.113.7") =>
  app.request("/api/check", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-client": client },
    body: JSON.stringify(body),
  });

const checked = async (sources: SourceSet, body: unknown = movie) => {
  const response = await check(appWith(sources), body);

  return { response, result: (await response.json()) as CheckResult };
};

const hashReference = () => fakeSource("Reference", [{ ref: "r", hashMatch: true, cues: track }]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/check", () => {
  it("leaves out a subtitle made for another video and shows the next one", async () => {
    const { response, result } = await checked({
      listed: [
        fakeSource("Fake", [
          { ref: "wrong", cues: unrelated, releaseName: "Movie.S01E05.720p.HDTV" },
          { ref: "right", cues: shifted },
        ]),
      ],
      references: [hashReference()],
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(result.leftOut).toEqual([
      {
        lang: "English",
        source: "Fake",
        release: "Movie.S01E05.720p.HDTV",
        label: "Not retimed",
        reason: mismatchReason,
      },
    ]);
    expect(result.shown).toEqual([
      { lang: "English", source: "Fake", label: "Retimed", detail: "-2.00 s" },
    ]);
    expect(result.reference).toBe("English, made for this exact file");
    expect(result.sources).toBe(2);
  });

  it("shows a hash-matched subtitle as made for this file", async () => {
    const { result } = await checked({
      listed: [
        fakeSource("Fake", [
          { ref: "a", hashMatch: true, cues: shifted, releaseName: "Movie.2024.1080p.WEB-DL" },
        ]),
      ],
      references: [],
    });

    expect(result.shown).toEqual([
      {
        lang: "English",
        source: "Fake",
        release: "Movie.2024.1080p.WEB-DL",
        label: "Made for this file",
        detail: "fingerprint match",
      },
    ]);
    expect(result.leftOut).toEqual([]);
  });

  it("shows the offset and speed of a retimed subtitle", async () => {
    const faster = transform(track, (time) => (time * 25) / 23.976 + 1000);

    const { result } = await checked({
      listed: [fakeSource("Fake", [{ ref: "a", fps: 25, cues: faster }])],
      references: [
        fakeSource("Reference", [{ ref: "r", hashMatch: true, fps: 23.976, cues: track }]),
      ],
    });

    expect(result.shown.map((row) => [row.label, row.detail])).toEqual([
      ["Retimed", "-0.96 s · speed 25 to 23.976"],
    ]);
  });

  it("counts the cuts of a retimed subtitle", async () => {
    const middle = track[100]?.start ?? 0;
    const cut = transform(track, (time) => (time < middle ? time : time + 5000));

    const { result } = await checked({
      listed: [fakeSource("Fake", [{ ref: "a", cues: cut }])],
      references: [hashReference()],
    });

    expect(result.shown.map((row) => [row.label, row.detail])).toEqual([
      ["Retimed", "-2.50 s · 1 cut"],
    ]);
  });

  it("leaves out a subtitle that could not be read", async () => {
    const { result } = await checked({
      listed: [fakeSource("Fake", [{ ref: "broken" }])],
      references: [],
    });

    expect(result.shown).toEqual([]);
    expect(result.leftOut).toEqual([
      { lang: "English", source: "Fake", label: "Not retimed", reason: "Could not be read." },
    ]);
  });

  it("searches the posted languages when there is no install link", async () => {
    const source = fakeSource("Fake", [
      { ref: "e", lang: "eng", cues: track },
      { ref: "f", lang: "fra", cues: track },
      { ref: "h", lang: "hrv", cues: track },
    ]);

    const { result } = await checked(
      { listed: [source], references: [] },
      { ...movie, languages: ["hrv", "fra"] },
    );

    expect(source.search.mock.calls[0]?.[0].languages).toEqual(["hrv", "fra"]);
    expect(result.shown.map((row) => [row.lang, row.label])).toEqual([
      ["Hrvatski", "Not retimed"],
      ["Français", "Not retimed"],
    ]);
  });

  it("searches English when there is no install link and no language", async () => {
    const source = fakeSource("Fake", []);

    await checked({ listed: [source], references: [] });

    expect(source.search.mock.calls[0]?.[0].languages).toEqual(["eng"]);
  });

  it("searches the languages of the install link and passes the file", async () => {
    const source = fakeSource("Fake", []);
    const installURL = `https://subs.example.com/${seal(defaultConfig(["slv"]), secret)}/manifest.json`;

    await checked(
      { listed: [source], references: [] },
      {
        ...movie,
        installURL,
        languages: ["eng"],
        videoHash: "8e245d9679d31e12",
        videoSize: 12909756,
        filename: "Movie.2024.mkv",
      },
    );

    expect(source.search.mock.calls[0]?.[0]).toEqual({
      type: "movie",
      imdbId: "tt0111161",
      videoHash: "8e245d9679d31e12",
      videoSize: 12909756,
      filename: "Movie.2024.mkv",
      languages: ["slv"],
    });
  });

  it("rejects an install link that does not open, without echoing it", async () => {
    const installURL = `https://subs.example.com/${"A".repeat(60)}/manifest.json`;

    const { response, result } = await checked(
      { listed: [], references: [] },
      { ...movie, installURL },
    );

    expect(response.status).toBe(400);
    expect(result).toEqual({ error: "This install link is not valid. Set up again." });
  });

  it("rejects a video id that is not a film or an episode", async () => {
    const { response } = await checked(
      { listed: [], references: [] },
      { type: "series", id: "tt0903747" },
    );

    expect(response.status).toBe(400);
  });

  it("returns what finished when the time budget runs out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    try {
      const pending = checked(
        {
          listed: [
            fakeSource("Fake", [
              { ref: "e", lang: "eng", cues: track },
              { ref: "h", lang: "hrv", hang: true },
            ]),
          ],
          references: [],
        },
        { ...movie, languages: ["eng", "hrv"] },
      );

      await vi.advanceTimersByTimeAsync(20_000);

      const { result } = await pending;

      expect(result.shown.map((row) => row.lang)).toEqual(["English"]);
      expect(result.leftOut).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers 429 to the eleventh check in a minute", async () => {
    const app = appWith({ listed: [], references: [] });
    const statuses: number[] = [];

    for (let index = 0; index < 11; index += 1) {
      statuses.push((await check(app, movie)).status);
    }

    expect(statuses).toEqual([...Array.from({ length: 10 }, () => 200), 429]);
    expect((await check(app, movie, "198.51.100.1")).status).toBe(200);
  });
});

const json = (body: unknown) => new Response(JSON.stringify(body));

describe("GET /api/titles", () => {
  it("maps Cinemeta results and keeps ten", async () => {
    const metas = Array.from({ length: 12 }, (_, index) => ({
      id: `tt00000${10 + index}`,
      type: "movie",
      name: `Film ${index}`,
      releaseInfo: "1994",
      poster: "https://images.example.com/poster.jpg",
    }));
    const fetchMock = vi.fn<typeof fetch>(async () => json({ metas }));

    vi.stubGlobal("fetch", fetchMock);

    const response = await appWith({ listed: [], references: [] }).request(
      "/api/titles?q=the%20shaw&type=movie",
    );
    const titles = (await response.json()) as unknown[];

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://v3-cinemeta.strem.io/catalog/movie/top/search=the%20shaw.json",
    );
    expect(titles).toHaveLength(10);
    expect(titles[0]).toEqual({ id: "tt0000010", type: "movie", name: "Film 0", year: "1994" });
  });

  it("searches films and series when no type is given", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      json({
        metas: String(url).includes("/series/")
          ? [{ id: "tt0903747", type: "series", name: "Breaking Bad", releaseInfo: "2008–2013" }]
          : [{ id: "tt0111161", type: "movie", name: "The Shawshank Redemption" }],
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const response = await appWith({ listed: [], references: [] }).request("/api/titles?q=b");

    expect(await response.json()).toEqual([
      { id: "tt0111161", type: "movie", name: "The Shawshank Redemption" },
      { id: "tt0903747", type: "series", name: "Breaking Bad", year: "2008" },
    ]);
  });
});

describe("GET /api/titles/:id/episodes", () => {
  it("lists the episodes of a series in order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        json({
          meta: {
            videos: [
              { id: "tt0903747:1:2", season: 1, episode: 2, name: "Cat's in the Bag..." },
              { id: "tt0903747:1:1", season: 1, number: 1, name: "Pilot" },
            ],
          },
        }),
      ),
    );

    const response = await appWith({ listed: [], references: [] }).request(
      "/api/titles/tt0903747/episodes",
    );

    expect(await response.json()).toEqual([
      { season: 1, episode: 1, name: "Pilot" },
      { season: 1, episode: 2, name: "Cat's in the Bag..." },
    ]);
  });

  it("rejects an id that is not an IMDb id", async () => {
    const response = await appWith({ listed: [], references: [] }).request(
      "/api/titles/..%2Fmeta/episodes",
    );

    expect(response.status).toBe(400);
  });
});
