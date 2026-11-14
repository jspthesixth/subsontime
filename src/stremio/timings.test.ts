import type { ExecutionContext } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import type { Config } from "../config/config.ts";
import { defaultConfig } from "../config/default-config.ts";
import { seal } from "../config/seal.ts";
import type { SourceSet } from "../sources/from-config.ts";
import { fakeSource } from "../sources/test-sources.ts";
import type { Cue } from "../subtitles/cue.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import { writeSRT } from "../subtitles/write.ts";
import { retime } from "../timing/retime.ts";
import { syntheticTrack, transform } from "../timing/test-tracks.ts";
import { lookUp } from "../timings/api.ts";
import { memoryStore, type NewFix, type TimingsStore } from "../timings/db.ts";
import { cueHashes, toFixCues } from "../timings/fingerprint.ts";
import { groupingKeyOf, submitterOf } from "../timings/submitter.ts";
import { decodeRef, refKey } from "./refs.ts";

vi.mock("../timing/retime.ts", { spy: true });
vi.mock("../timings/api.ts", { spy: true });

type Listing = { subtitles: { id: string; lang: string; url: string }[] };
type App = ReturnType<typeof createApp>;

const secret = "a-test-secret-that-is-long-enough-1234";
const installSalt = "an-install-salt-that-is-long-enough-5678";
const video = { hash: "0123456789abcdef", size: 1_234_567 };
const extras = `videoHash=${video.hash}&videoSize=${video.size}`;
const track = syntheticTrack(1, 200);
const shifted = transform(track, (time) => time + 2000);
const unrelated = syntheticTrack(2, 200).map((cue) => ({ ...cue, text: `Wrong ${cue.text}` }));
const other = syntheticTrack(3, 200).map((cue) => ({ ...cue, text: `Other ${cue.text}` }));
const third = syntheticTrack(4, 200).map((cue) => ({ ...cue, text: `Third ${cue.text}` }));
const budgetMs = 300;

const failing = (): Promise<never> => Promise.reject(new TypeError("secret detail"));

const hanging = (): Promise<never> => new Promise(() => {});

const hashesOf = (cues: Cue[]) => cueHashes(cues).filter((hash) => hash !== undefined);

const appWith = (sources: SourceSet, store: TimingsStore = memoryStore()) =>
  createApp({
    secret,
    installSalt,
    timings: store,
    sourcesFor: () => sources,
    clientKey: (context) => context.req.header("x-test-client") ?? "client-a",
  });

const installed = (overrides: Partial<Config> = {}) => {
  const config = { ...defaultConfig(["eng"]), ...overrides };

  return {
    config,
    token: seal(config, secret),
    submitter: submitterOf(config.installId, installSalt),
  };
};

const refOf = (url: string) =>
  decodeRef(
    new URL(url).pathname
      .split("/")
      .at(-1)
      ?.replace(/\.srt$/, "") ?? "",
    refKey(secret),
  );

const firstURL = async (app: App, token: string, more = "") => {
  const listing = await app.request(`/${token}/subtitles/movie/tt0111161/${extras}${more}.json`);
  const { subtitles } = (await listing.json()) as Listing;

  return subtitles[0]?.url ?? "";
};

const play = async (app: App, token: string) => {
  const response = await app.request(await firstURL(app, token));

  return { response, text: await response.text() };
};

const confirmFix = async (store: TimingsStore, cues: Cue[]) => {
  const fix = toFixCues(cues);
  const row = { video, subtitleHashes: fix.map((cue) => cue.h), cues: fix };

  await store.putFix({ ...row, method: "audio", submitter: "s1", origin: "o1" });
  await store.putFix({
    ...row,
    method: "reference",
    referenceKey: row.subtitleHashes.slice(0, 8).join(","),
    submitter: "s2",
    origin: "o2",
  });
};

const hideByMismatch = async (store: TimingsStore, cues: Cue[], group = "") => {
  await store.putMismatch({
    video,
    subtitleHashes: hashesOf(cues),
    submitter: `m${group}a`,
    origin: `p${group}a`,
  });
  await store.putMismatch({
    video,
    subtitleHashes: hashesOf(cues),
    submitter: `m${group}b`,
    origin: `p${group}b`,
  });
};

const hideByReports = async (store: TimingsStore, cues: Cue[]) => {
  await Promise.all(
    ["1", "2", "3"].map((index) =>
      store.putReport({
        video,
        subtitleHashes: hashesOf(cues),
        reason: "machine-translated",
        submitter: `r${index}`,
        origin: `q${index}`,
      }),
    ),
  );
};

const deferredStore = () => {
  const store = memoryStore();
  const writes: NewFix[] = [];
  const gate = Promise.withResolvers<void>();

  return {
    writes,
    release: () => gate.resolve(),
    store: {
      ...store,
      putFix: async (row: NewFix) => {
        writes.push(row);
        await gate.promise;
        await store.putFix(row);
      },
    },
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const retimedSources = () => ({
  listed: [fakeSource("Fake", [{ ref: "a", cues: shifted }])],
  references: [fakeSource("Reference", [{ ref: "r", hashMatch: true, cues: track }])],
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reading Open Timings", () => {
  it("serves a confirmed shared fix without retiming", async () => {
    const store = memoryStore();
    const { token } = installed();

    await confirmFix(store, track);

    const { text } = await play(
      appWith(
        { listed: [fakeSource("Fake", [{ ref: "a", cues: shifted }])], references: [] },
        store,
      ),
      token,
    );

    await settle();

    expect(text).toBe(writeSRT(track));
    expect(vi.mocked(retime)).not.toHaveBeenCalled();
    expect(await store.fixesFor(video)).toHaveLength(2);
  });

  it("ignores a confirmed fix made for another subtitle", async () => {
    const store = memoryStore();
    const { token } = installed({ share: false });

    await confirmFix(store, other);

    const { text } = await play(appWith(retimedSources(), store), token);
    const cues = parseSubtitle(text);

    expect(vi.mocked(retime)).toHaveBeenCalledTimes(1);
    expect(Math.abs((cues[0]?.start ?? 0) - (track[0]?.start ?? 0))).toBeLessThan(200);
  });

  it("skips a subtitle Open Timings hid and serves the next one in a best-only slot", async () => {
    const store = memoryStore();
    const { token } = installed();
    const sources = () => ({
      listed: [
        fakeSource("Fake", [
          { ref: "hidden", cues: shifted },
          { ref: "next", cues: other },
        ]),
      ],
      references: [],
    });

    const before = await play(appWith(sources(), memoryStore()), token);

    await hideByMismatch(store, shifted);

    const hidden = await play(appWith(sources(), store), token);

    expect(before.text).toBe(writeSRT(shifted));
    expect(hidden.text).toBe(writeSRT(other));
  });

  it("serves an empty subtitle for a single hidden candidate", async () => {
    const store = memoryStore();
    const { token } = installed({ bestOnly: false });

    await hideByMismatch(store, shifted);

    const { response, text } = await play(
      appWith(
        { listed: [fakeSource("Fake", [{ ref: "a", cues: shifted }])], references: [] },
        store,
      ),
      token,
    );

    expect(response.status).toBe(200);
    expect(text).toBe("");
  });

  it("hides the viewer's own mismatch at once and for that viewer only", async () => {
    const store = memoryStore();
    const viewer = installed();
    const someoneElse = installed();
    const app = appWith(
      {
        listed: [
          fakeSource("Fake", [
            { ref: "reported", cues: shifted },
            { ref: "next", cues: other },
          ]),
        ],
        references: [],
      },
      store,
    );

    const before = await play(app, viewer.token);
    const reported = await app.request("/api/v1/mismatches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        installId: viewer.config.installId,
        video,
        subtitleHashes: hashesOf(shifted),
      }),
    });
    const after = await play(app, viewer.token);
    const elsewhere = await play(app, someoneElse.token);

    expect(reported.status).toBe(202);
    expect(before.text).toBe(writeSRT(shifted));
    expect(after.text).toBe(writeSRT(other));
    expect(elsewhere.text).toBe(writeSRT(shifted));
  });

  it("never reads Open Timings when shared fixes are off", async () => {
    const store = memoryStore();
    const { token } = installed({ useShared: false, share: false });

    await confirmFix(store, track);
    await hideByMismatch(store, shifted);

    const app = appWith(retimedSources(), store);
    const url = await firstURL(app, token);
    const cues = parseSubtitle(await (await app.request(url)).text());

    expect(refOf(url).d).toBeUndefined();
    expect(vi.mocked(lookUp)).not.toHaveBeenCalled();
    expect(vi.mocked(retime)).toHaveBeenCalledTimes(1);
    expect(Math.abs((cues[0]?.start ?? 0) - (track[0]?.start ?? 0))).toBeLessThan(200);
  });

  it("keeps Phase 1 behavior and logs only the error name when the store throws", async () => {
    const store: TimingsStore = {
      fixesFor: failing,
      mismatchesFor: failing,
      reportsFor: failing,
      putFix: failing,
      putMismatch: failing,
      putReport: failing,
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { token, submitter, config } = installed();

    const { response, text } = await play(appWith(retimedSources(), store), token);
    const cues = parseSubtitle(text);

    await settle();

    const logged = errors.mock.calls.map((call) => call.join(" "));

    expect(response.status).toBe(200);
    expect(Math.abs((cues[0]?.start ?? 0) - (track[0]?.start ?? 0))).toBeLessThan(200);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.every((line) => line.includes("TypeError"))).toBe(true);
    expect(
      logged.some((line) =>
        ["secret detail", submitter, config.installId, token].some((part) => line.includes(part)),
      ),
    ).toBe(false);
  });

  it("answers within the read budget when the store hangs", async () => {
    const hangingStore: TimingsStore = {
      ...memoryStore(),
      fixesFor: hanging,
      mismatchesFor: hanging,
      reportsFor: hanging,
    };
    const { token } = installed({ share: false });

    const timed = async (store: TimingsStore) => {
      const app = appWith(retimedSources(), store);
      const listingStarted = performance.now();
      const url = await firstURL(app, token);
      const fileStarted = performance.now();
      const text = await (await app.request(url)).text();

      return {
        listingMs: fileStarted - listingStarted,
        fileMs: performance.now() - fileStarted,
        text,
      };
    };

    const normal = await timed(memoryStore());
    const hung = await timed(hangingStore);

    expect(hung.text).toBe(normal.text);
    expect(hung.listingMs).toBeLessThan(normal.listingMs + budgetMs + 150);
    expect(hung.fileMs).toBeLessThan(normal.fileMs + budgetMs + 150);
  });

  it("keeps a ref with ten hidden subtitles under 8 KB", async () => {
    const store = memoryStore();
    const { token } = installed();
    const groups = Array.from({ length: 12 }, (_, index) =>
      syntheticTrack(10 + index, 300).map((cue) => ({
        ...cue,
        text: `Group ${index} ${cue.text}`,
      })),
    );

    await Promise.all(groups.map((cues, index) => hideByMismatch(store, cues, String(index))));

    const app = appWith(
      {
        listed: [
          fakeSource(
            "Fake",
            Array.from({ length: 4 }, (_, index) => ({ ref: `candidate-${index}`, cues: shifted })),
          ),
        ],
        references: [fakeSource("Reference", [{ ref: "r", hashMatch: true, cues: track }])],
      },
      store,
    );
    const url = await firstURL(app, token);
    const { hidden } = await lookUp(store, video, {
      groupingKey: groupingKeyOf(installSalt),
    });

    expect(hidden.length).toBeGreaterThanOrEqual(10);
    expect(hidden.every((entry) => entry.subtitleSketch.length === 128)).toBe(true);
    expect(refOf(url).d).toMatch(/^hid:/);
    expect(url.length).toBeLessThan(8 * 1024);
  });
});

describe("sharing to Open Timings", () => {
  it("shares one fix for a retimed subtitle after the response", async () => {
    const { store, writes, release } = deferredStore();
    const { token, submitter } = installed();
    const app = appWith(retimedSources(), store);

    const response = await app.request(await firstURL(app, token));
    const seenAtResponse = writes.length;
    const text = await response.text();

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    release();
    await vi.waitFor(async () => expect(await store.fixesFor(video)).toHaveLength(1));

    const [write] = writes;

    expect(seenAtResponse).toBe(0);
    expect(parseSubtitle(text)).toHaveLength(200);
    expect(write).toMatchObject({
      video,
      subtitleHashes: hashesOf(shifted),
      method: "reference",
      referenceKey: hashesOf(track).slice(0, 8).join(","),
      submitter,
      origin: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(write?.cues).toHaveLength(200);
    expect(
      write?.cues.every((cue) => Number.isInteger(cue.s) && Number.isInteger(cue.e) && cue.s >= 0),
    ).toBe(true);
  });

  it("names the method after a release-name reference", async () => {
    const releaseName = "Movie.2024.1080p.BluRay.x264-GROUP";
    const store = memoryStore();
    const { token } = installed();
    const app = appWith(
      {
        listed: [fakeSource("Fake", [{ ref: "a", cues: shifted }])],
        references: [fakeSource("Reference", [{ ref: "r", cues: track, releaseName }])],
      },
      store,
    );

    await app.request(await firstURL(app, token, `&filename=${releaseName}.mkv`));

    await vi.waitFor(async () =>
      expect(await store.fixesFor(video)).toMatchObject([{ method: "release-name" }]),
    );
  });

  it("hands the write to waitUntil when the platform gives one", async () => {
    const store = memoryStore();
    const { token } = installed();
    const app = appWith(retimedSources(), store);
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    const executionContext: ExecutionContext = {
      waitUntil,
      passThroughOnException: () => {},
      props: {},
    };

    await app.request(await firstURL(app, token), undefined, undefined, executionContext);
    await waitUntil.mock.calls[0]?.[0];

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(await store.fixesFor(video)).toHaveLength(1);
  });

  it("shares a mismatch against a hash-matched reference", async () => {
    const store = memoryStore();
    const { token, submitter } = installed();
    const app = appWith(
      {
        listed: [
          fakeSource("Fake", [
            { ref: "wrong", cues: unrelated },
            { ref: "right", cues: shifted },
          ]),
        ],
        references: [fakeSource("Reference", [{ ref: "r", hashMatch: true, cues: track }])],
      },
      store,
    );

    await play(app, token);
    await vi.waitFor(async () => expect(await store.mismatchesFor(video)).toHaveLength(1));
    await vi.waitFor(async () => expect(await store.fixesFor(video)).toHaveLength(1));

    expect(await store.mismatchesFor(video)).toMatchObject([
      { subtitleHashes: hashesOf(unrelated), submitter },
    ]);
  });

  it.each<[string, Partial<Config>, SourceSet]>([
    ["sharing is off", { share: false }, retimedSources()],
    ["timing is off", { timing: "off" }, retimedSources()],
    [
      "the subtitle is made for the file",
      {},
      {
        listed: [fakeSource("Fake", [{ ref: "a", hashMatch: true, cues: shifted }])],
        references: [],
      },
    ],
    [
      "the subtitle was not retimed",
      {},
      { listed: [fakeSource("Fake", [{ ref: "a", cues: shifted }])], references: [] },
    ],
  ])("shares nothing when %s", async (_, overrides, sources) => {
    const store = memoryStore();
    const { token } = installed(overrides);

    await play(appWith(sources, store), token);
    await settle();

    expect(await store.fixesFor(video)).toEqual([]);
    expect(await store.mismatchesFor(video)).toEqual([]);
  });

  it("shares nothing without a video fingerprint", async () => {
    const store = memoryStore();
    const { token } = installed();
    const app = appWith(retimedSources(), store);
    const listing = await app.request(`/${token}/subtitles/movie/tt0111161.json`);
    const { subtitles } = (await listing.json()) as Listing;

    await app.request(subtitles[0]?.url ?? "");
    await settle();

    expect(vi.mocked(lookUp)).not.toHaveBeenCalled();
    expect(await store.fixesFor(video)).toEqual([]);
  });
});

describe("the check page with Open Timings", () => {
  it("labels a shared fix and leaves out what Open Timings hid", async () => {
    const store = memoryStore();
    const { token } = installed();

    await store.putFix({
      video,
      subtitleHashes: hashesOf(track),
      cues: toFixCues(track),
      method: "audio",
      submitter: "s1",
      origin: "o1",
    });
    await store.putFix({
      video,
      subtitleHashes: hashesOf(track),
      cues: toFixCues(track),
      method: "reference",
      referenceKey: hashesOf(track).slice(0, 8).join(","),
      submitter: "s2",
      origin: "o2",
    });
    await hideByMismatch(store, other);
    await hideByReports(store, third);

    const app = appWith(
      {
        listed: [
          fakeSource("Fake", [
            { ref: "fixed", cues: shifted },
            { ref: "mismatched", cues: other },
            { ref: "reported", cues: third },
          ]),
        ],
        references: [],
      },
      store,
    );
    const response = await app.request("/api/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        installURL: `http://localhost/${token}/manifest.json`,
        type: "movie",
        id: "tt0111161",
        videoHash: video.hash,
        videoSize: video.size,
      }),
    });
    const result = (await response.json()) as { shown: unknown[]; leftOut: unknown[] };

    expect(result.shown).toEqual([
      {
        lang: "English",
        source: "Fake",
        label: "Shared fix, confirmed",
        detail: "2 agree · 1 from audio",
        playsFirst: true,
      },
    ]);
    expect(result.leftOut).toEqual([
      {
        lang: "English",
        source: "Fake",
        label: "Not retimed",
        reason: "Hidden by Open Timings: made for another video.",
      },
      {
        lang: "English",
        source: "Fake",
        label: "Not retimed",
        reason: "Hidden by Open Timings: reported as machine translated.",
      },
    ]);
    expect(vi.mocked(retime)).not.toHaveBeenCalled();
  });
});
