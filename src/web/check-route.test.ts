import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { defaultConfig } from "../config/default-config.ts";
import { seal } from "../config/seal.ts";
import type { SourceSet } from "../sources/from-config.ts";
import { fakeSource } from "../sources/test-sources.ts";
import type { Source } from "../sources/source.ts";
import { encodeRef, refKey } from "../stremio/refs.ts";
import { retime } from "../timing/retime.ts";
import { syntheticTrack, transform } from "../timing/test-tracks.ts";
import { memoryStore } from "../timings/db.ts";

vi.mock("../timing/retime.ts", { spy: true });

type CheckRow = {
  lang: string;
  source: string;
  release?: string;
  label: string;
  detail?: string;
  reason?: string;
  playsFirst?: boolean;
  ref?: string;
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

beforeEach(() => {
  vi.clearAllMocks();
});

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
      { lang: "English", source: "Fake", label: "Retimed", detail: "-2.00 s", playsFirst: true },
    ]);
    expect(result.reference).toBe("English, made for this exact file");
    expect(result.sources).toBe(2);
  });

  it("lists every top candidate of a language, shown ones first in menu order", async () => {
    const { result } = await checked({
      listed: [
        fakeSource("Fake", [
          { ref: "wrong", cues: unrelated, releaseName: "Movie.S01E05.720p.HDTV" },
          { ref: "broken", releaseName: "Movie.2024.720p.WEB" },
          { ref: "right", cues: shifted },
          { ref: "hash", hashMatch: true, cues: track, releaseName: "Movie.2024.1080p.WEB-DL" },
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
        playsFirst: true,
      },
      { lang: "English", source: "Fake", label: "Retimed", detail: "-2.00 s" },
    ]);
    expect(result.leftOut).toEqual([
      {
        lang: "English",
        source: "Fake",
        release: "Movie.S01E05.720p.HDTV",
        label: "Not retimed",
        reason: mismatchReason,
      },
      {
        lang: "English",
        source: "Fake",
        release: "Movie.2024.720p.WEB",
        label: "Not retimed",
        reason: "Could not be read.",
      },
    ]);
  });

  it("shows a served mismatch with its reason and marks nothing to play first", async () => {
    const installURL = `https://subs.example.com/${seal(
      {
        ...defaultConfig(["eng"]),
        bestOnly: false,
        extras: { ...defaultConfig(["eng"]).extras, hideMismatches: false },
      },
      secret,
    )}/manifest.json`;

    const { result } = await checked(
      {
        listed: [
          fakeSource("Fake", [
            { ref: "wrong", cues: unrelated },
            { ref: "right", cues: shifted },
          ]),
        ],
        references: [hashReference()],
      },
      { ...movie, installURL },
    );

    expect(result.shown).toEqual([
      { lang: "English", source: "Fake", label: "Not retimed", detail: mismatchReason },
      { lang: "English", source: "Fake", label: "Retimed", detail: "-2.00 s" },
    ]);
    expect(result.leftOut).toEqual([]);
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
        playsFirst: true,
      },
    ]);
    expect(result.leftOut).toEqual([]);
  });

  it("shows the offset and speed of a retimed subtitle", async () => {
    const faster = transform(track, (time) => (time * 23.976) / 25 + 1000);

    const { result } = await checked({
      listed: [fakeSource("Fake", [{ ref: "a", fps: 25, cues: faster }])],
      references: [
        fakeSource("Reference", [{ ref: "r", hashMatch: true, fps: 23.976, cues: track }]),
      ],
    });

    expect(result.shown.map((row) => [row.label, row.detail])).toEqual([
      ["Retimed", "-1.04 s · speed 25 to 23.976"],
    ]);
  });

  it("shows the speed ratio when the frame rates are unknown", async () => {
    const faster = transform(track, (time) => (time * 25) / 23.976 + 1000);

    const { result } = await checked({
      listed: [fakeSource("Fake", [{ ref: "a", cues: faster }])],
      references: [hashReference()],
    });

    expect(result.shown.map((row) => [row.label, row.detail])).toEqual([
      ["Retimed", "-0.96 s · speed ×1.0427"],
    ]);
  });

  it("counts two cuts in the plural", async () => {
    const first = track[66]?.start ?? 0;
    const second = track[133]?.start ?? 0;
    const cut = transform(track, (time) => {
      if (time >= second) {
        return time + 10_000;
      }

      return time >= first ? time + 5000 : time;
    });

    const { result } = await checked({
      listed: [fakeSource("Fake", [{ ref: "a", cues: cut }])],
      references: [hashReference()],
    });

    expect(result.shown.map((row) => [row.label, row.detail])).toEqual([
      ["Retimed", "-5.00 s · 2 cuts"],
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

  it("never retimes a subtitle whose download finishes after the time budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    try {
      const pending = checked({
        listed: [fakeSource("Fake", [{ ref: "late", cues: shifted, delayMs: 25_000 }])],
        references: [hashReference()],
      });

      await vi.advanceTimersByTimeAsync(20_000);

      const { result } = await pending;

      await vi.advanceTimersByTimeAsync(10_000);

      expect(result.shown).toEqual([]);
      expect(vi.mocked(retime)).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers 429 to a third check while two are running", async () => {
    const gate = Promise.withResolvers<void>();
    const search = vi.fn<Source["search"]>(async () => {
      await gate.promise;

      return [];
    });
    const app = appWith({
      listed: [{ name: "Slow", search, download: async () => new Uint8Array() }],
      references: [],
    });
    const running = [check(app, movie, "198.51.100.1"), check(app, movie, "198.51.100.2")];

    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));

    const third = await check(app, movie, "198.51.100.3");

    gate.resolve();

    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "Busy, try again in a moment" });
    expect((await Promise.all(running)).map((response) => response.status)).toEqual([200, 200]);
    expect((await check(app, movie, "198.51.100.3")).status).toBe(200);
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

const installSalt = "an-install-salt-that-is-long-enough-12345";
const installURL = `https://subs.example.com/${seal(
  { ...defaultConfig(["eng"]), installId: "6f1c1a52-6a43-4e8a-9b55-0c2a6a1d2e3f" },
  secret,
)}/manifest.json`;
const greeting = [
  { start: 1000, end: 3000, text: "Hello there." },
  { start: 4000, end: 6000, text: "<i>General Kenobi!</i>" },
];
const file = { videoHash: "8e245d9679d31e12", videoSize: 12909756 };
const unreadableMessage = "We could not read this subtitle, so it cannot be reported.";

const reporting = () => {
  const timings = memoryStore();
  const putReport = vi.spyOn(timings, "putReport");
  const source = fakeSource("Fake", [
    { ref: "a", hashMatch: true, cues: greeting, releaseName: "Movie.2024.1080p.WEB-DL" },
  ]);
  const app = createApp({
    secret,
    installSalt,
    timings,
    sourcesFor: () => ({ listed: [source], references: [] }),
    clientKey: (context) => context.req.header("x-test-client") ?? "none",
  });

  return { app, source, putReport };
};

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, client = "a") =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-client": client },
    body: JSON.stringify(body),
  });

const refOf = async (app: ReturnType<typeof createApp>, body: unknown = movie) => {
  const result = (await (await post(app, "/api/check", body)).json()) as CheckResult;

  return result.shown[0]?.ref ?? "";
};

describe("POST /api/check/report", () => {
  it("reports a subtitle by its hashes and never its text", async () => {
    const { app, putReport } = reporting();

    const ref = await refOf(app, { ...movie, ...file, installURL });

    const response = await post(app, "/api/check/report", {
      ref,
      reason: "machine-translated",
      installURL,
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(putReport.mock.calls).toEqual([
      [
        {
          video: { hash: "8e245d9679d31e12", size: 12909756 },
          subtitleHashes: ["12998c017066eb0d", "354cacb2d2c45cb2"],
          reason: "machine-translated",
          submitter: "7e5125cb4f1eb5af57ebfca8d10a7181",
          origin: expect.stringMatching(/^[0-9a-f]{16}$/),
        },
      ],
    ]);
    expect(JSON.stringify(putReport.mock.calls)).not.toMatch(/hello|kenobi/i);
  });

  it("gives a row no report ref when the check ran without the video file", async () => {
    const { app } = reporting();

    const result = (await (await post(app, "/api/check", movie)).json()) as CheckResult;

    expect(result.shown).toEqual([
      {
        lang: "English",
        source: "Fake",
        release: "Movie.2024.1080p.WEB-DL",
        label: "Made for this file",
        detail: "fingerprint match",
        playsFirst: true,
      },
    ]);
  });

  it.each([
    [
      "an unsigned ref",
      () =>
        Buffer.from(
          JSON.stringify({
            v: 1,
            q: { t: "movie", i: "tt0111161" },
            c: [{ n: "Fake", r: "a", l: "eng" }],
            x: [],
            w: { h: "8e245d9679d31e12", z: 12909756 },
          }),
        ).toString("base64url"),
    ],
    [
      "a ref with a changed payload",
      (ref: string) => {
        const [payload = "", signature = ""] = ref.split(".");

        const changed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));

        changed.w.z = 1;

        return `${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`;
      },
    ],
    [
      "a signed ref without a video",
      () =>
        encodeRef(
          { v: 1, q: { t: "movie", i: "tt0111161" }, c: [{ n: "Fake", r: "a", l: "eng" }], x: [] },
          refKey(secret),
        ),
    ],
  ])("refuses %s", async (_, refFrom) => {
    const { app, putReport } = reporting();

    const ref = refFrom(await refOf(app, { ...movie, ...file }));

    const response = await post(app, "/api/check/report", { ref, reason: "wrong-language" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid subtitle reference" });
    expect(putReport).not.toHaveBeenCalled();
  });

  it.each([
    ["cannot be downloaded", new Error("Download failed")],
    ["cannot be parsed", new TextEncoder().encode("not a subtitle")],
  ])("refuses a subtitle that %s, with a message", async (_, outcome) => {
    const { app, source, putReport } = reporting();

    const ref = await refOf(app, { ...movie, ...file });

    if (outcome instanceof Error) {
      source.download.mockRejectedValueOnce(outcome);
    } else {
      source.download.mockResolvedValueOnce(outcome);
    }

    const response = await post(app, "/api/check/report", { ref, reason: "lines-missing" });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: unreadableMessage });
    expect(putReport).not.toHaveBeenCalled();
  });

  it("refuses an unknown reason before downloading anything", async () => {
    const { app, source, putReport } = reporting();

    const ref = await refOf(app, { ...movie, ...file });

    source.download.mockClear();

    const response = await post(app, "/api/check/report", { ref, reason: "too-long" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Pick what is wrong with this subtitle" });
    expect(source.download).not.toHaveBeenCalled();
    expect(putReport).not.toHaveBeenCalled();
  });

  it("answers 429 to the eleventh report in a minute, apart from checks", async () => {
    const { app } = reporting();

    const statuses: number[] = [];

    for (let index = 0; index < 11; index += 1) {
      statuses.push(
        (await post(app, "/api/check/report", { ref: "x", reason: "timing-off" })).status,
      );
    }

    expect(statuses).toEqual([...Array.from({ length: 10 }, () => 400), 429]);
    expect((await post(app, "/api/check", movie)).status).toBe(200);
  });
});

describe("GET /check report panel", () => {
  it("offers the five reasons, the hint and the two buttons from the board", async () => {
    const page = (await (await reporting().app.request("/check")).text()).replace(/\s+/g, " ");

    expect(page).toContain('role="radiogroup" aria-label="Reason"');
    expect(
      [
        ...page.matchAll(/<input type="radio" name="reason" value="([a-z-]+)"[^>]*\/>([^<]+)</g),
      ].map(([, value, label]) => [value, label]),
    ).toEqual([
      ["machine-translated", "Machine translated"],
      ["wrong-language", "Wrong language"],
      ["lines-missing", "Lines missing"],
      ["timing-off", "Timing still off"],
      ["broken-characters", "Broken characters"],
    ]);
    expect(page).toContain(
      "Reports are anonymous. After a few, this subtitle stops showing for everyone.",
    );
    expect(page).toMatch(/<button type="button" class="btn btn-ghost btn-sm row-cancel">Cancel</);
    expect(page).toMatch(
      /<button type="button" class="btn btn-light btn-sm row-send">Send report</,
    );
    expect(page).toMatch(/<button[^>]*class="btn-quiet row-report"[^>]*> Report </);
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

    const response = await appWith({ listed: [], references: [] }).request("/api/titles?q=bad");

    expect(await response.json()).toEqual([
      { id: "tt0111161", type: "movie", name: "The Shawshank Redemption" },
      { id: "tt0903747", type: "series", name: "Breaking Bad", year: "2008" },
    ]);
  });
});

describe("GET /api/titles ordering and limits", () => {
  it("puts a name equal to the query first, then names that start with it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) =>
        json({
          metas: String(url).includes("/series/")
            ? [
                { id: "tt2387761", name: "Breaking Bad: Original Minisodes" },
                { id: "tt0903747", name: "Breaking Bad" },
              ]
            : [{ id: "tt9243946", name: "El Camino: A Breaking Bad Movie" }],
        }),
      ),
    );

    const response = await appWith({ listed: [], references: [] }).request(
      "/api/titles?q=Breaking%20bad",
    );
    const titles = (await response.json()) as { name: string }[];

    expect(titles.map((title) => title.name)).toEqual([
      "Breaking Bad",
      "Breaking Bad: Original Minisodes",
      "El Camino: A Breaking Bad Movie",
    ]);
  });

  it("answers 429 to the 61st title or episode lookup in a minute", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => json({ metas: [], meta: { videos: [] } })),
    );

    const app = appWith({ listed: [], references: [] });
    const lookup = (path: string) => app.request(path, { headers: { "x-test-client": "a" } });
    const statuses: number[] = [];

    for (let index = 0; index < 30; index += 1) {
      statuses.push((await lookup("/api/titles?q=bad")).status);
      statuses.push((await lookup("/api/titles/tt0903747/episodes")).status);
    }

    statuses.push((await lookup("/api/titles?q=bad")).status);

    expect(statuses.filter((status) => status === 200)).toHaveLength(60);
    expect(statuses.at(-1)).toBe(429);
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
