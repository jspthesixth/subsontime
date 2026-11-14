import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "./app.ts";
import { defaultConfig } from "./config/default-config.ts";
import { seal } from "./config/seal.ts";
import { memorySharedState, type SharedState } from "./jobs/shared-state.ts";
import type { SourceSet } from "./sources/from-config.ts";
import type { Source } from "./sources/source.ts";
import type { TokenCache } from "./sources/token-cache.ts";
import { fakeSource } from "./sources/test-sources.ts";
import { encodeRef, refKey } from "./stremio/refs.ts";
import { writeSRT } from "./subtitles/write.ts";
import { syntheticTrack } from "./timing/test-tracks.ts";
import { memoryStore, type TimingsStore } from "./timings/db.ts";

type App = ReturnType<typeof createApp>;

const secret = "a-test-secret-that-is-long-enough-1234";
const installSalt = "an-install-salt-that-is-long-enough-12";
const track = syntheticTrack(1, 50);
const token = seal(defaultConfig(["eng"]), secret);
const subPath = `/${token}/sub/${encodeRef(
  { v: 1, q: { t: "movie", i: "tt0111161" }, c: [{ n: "Fake", r: "a", l: "eng", h: 1 }], x: [] },
  refKey(secret),
)}.srt`;
const video = { hash: "0123456789abcdef", size: 7_345_678_901 };
const lookUpPath = `/api/v1/fixes?video=${video.hash}:${video.size}`;
const movie = { type: "movie", id: "tt0111161" };

const failing = async (): Promise<never> => {
  throw new Error("Redis is down");
};

const brokenState: SharedState = {
  get: failing,
  set: failing,
  setIfAbsent: failing,
  delete: failing,
  increment: failing,
};

const subtitleSources = (delayMs?: number) => {
  const source = fakeSource("Fake", [{ ref: "a", hashMatch: true, cues: track, delayMs }]);
  const sources: SourceSet = { listed: [source], references: [] };

  return { source, sources };
};

const instance = (state: SharedState | undefined, deps: Partial<AppDeps> = {}) =>
  createApp({
    secret,
    installSalt,
    state,
    clientKey: (context) => context.req.header("x-test-client") ?? "none",
    ...deps,
  });

const post = (app: App, path: string, body: unknown, client = "203.0.113.7") =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-client": client },
    body: JSON.stringify(body),
  });

const fixBody = () => ({
  video,
  subtitle: [{ h: "0000000000000001", s: 0, e: 900 }],
  method: "audio",
  installId: randomUUID(),
});

const mismatchBody = () => ({
  video,
  subtitleHashes: ["1111111111111111"],
  installId: randomUUID(),
});

const fixesOf = async (app: App) =>
  ((await (await app.request(lookUpPath)).json()) as { fixes: unknown[] }).fixes;

const counted = (store: TimingsStore) => ({
  ...store,
  fixesFor: vi.fn<TimingsStore["fixesFor"]>(store.fixesFor),
});

const hangingFirst = (count: number) => {
  let searches = 0;
  const search = vi.fn<Source["search"]>(async () => {
    searches += 1;

    if (searches <= count) {
      await new Promise(() => {});
    }

    return [];
  });
  const sources: SourceSet = {
    listed: [{ name: "Slow", search, download: async () => new Uint8Array() }],
    references: [],
  };

  return { search, sources };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("two instances on one shared state", () => {
  it("download a subtitle once when asked at the same time", async () => {
    const state = memorySharedState();
    const { source, sources } = subtitleSources(50);
    const apps = [1, 2].map(() => instance(state, { sourcesFor: () => sources }));
    const responses = await Promise.all(apps.map((app) => app.request(subPath)));

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual([
      writeSRT(track),
      writeSRT(track),
    ]);
    expect(source.download).toHaveBeenCalledTimes(1);
  });

  it("serve a cached subtitle without any source call", async () => {
    const state = memorySharedState();
    const first = subtitleSources();
    const second = subtitleSources();

    await instance(state, { sourcesFor: () => first.sources }).request(subPath);

    const response = await instance(state, { sourcesFor: () => second.sources }).request(subPath);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(writeSRT(track));
    expect(second.source.search).not.toHaveBeenCalled();
    expect(second.source.download).not.toHaveBeenCalled();
  });

  it("never write the install link into a shared key", async () => {
    const state = memorySharedState();
    const set = vi.spyOn(state, "set");
    const setIfAbsent = vi.spyOn(state, "setIfAbsent");
    const { sources } = subtitleSources();

    await instance(state, { sourcesFor: () => sources }).request(subPath);

    const keys = [...set.mock.calls, ...setIfAbsent.mock.calls].map(([key]) => key);

    expect(keys.length).toBeGreaterThan(0);
    keys.forEach((key) => expect(key).not.toContain(token));
  });

  it.each([
    ["source checks", 10, (app: App) => post(app, "/api/sources/check", {})],
    ["checks", 10, (app: App) => post(app, "/api/check", {})],
    ["title searches", 60, (app: App) => app.request("/api/titles?q=")],
    ["Open Timings writes", 60, (app: App) => post(app, "/api/v1/fixes", {})],
  ])("share one limit for %s of %i", async (_, limit, send) => {
    const state = memorySharedState();
    const one = instance(state);
    const two = instance(state);
    const statuses: number[] = [];

    for (const index of Array.from({ length: limit }, (__, each) => each)) {
      statuses.push((await send(index % 2 === 0 ? one : two)).status);
    }

    expect(statuses).not.toContain(429);
    expect((await send(two)).status).toBe(429);
  });

  it("refuse a third check while two run, refresh their slots and free them at the end", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });

    const state = memorySharedState();
    const set = vi.spyOn(state, "set");
    const source = fakeSource("Fake", [{ ref: "a", hang: true }]);
    const sources: SourceSet = { listed: [source], references: [] };
    const one = instance(state, { sourcesFor: () => sources });
    const two = instance(state, { sourcesFor: () => sources });
    const running = [
      post(one, "/api/check", movie, "198.51.100.1"),
      post(two, "/api/check", movie, "198.51.100.2"),
    ];

    await vi.waitFor(() => expect(source.download).toHaveBeenCalledTimes(2));

    const third = await post(two, "/api/check", movie, "198.51.100.3");

    await vi.advanceTimersByTimeAsync(10_000);

    const refreshed = set.mock.calls.filter(([key]) => key.startsWith("slot:check:"));

    await vi.advanceTimersByTimeAsync(11_000);

    const statuses = await Promise.all(running);
    const after = post(one, "/api/check", movie, "198.51.100.4");

    await vi.advanceTimersByTimeAsync(21_000);

    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "Busy, try again in a moment" });
    expect(refreshed.map(([key, , ttl]) => [key, ttl]).toSorted()).toEqual([
      ["slot:check:0", 30],
      ["slot:check:1", 30],
    ]);
    expect(statuses.map((response) => response.status)).toEqual([200, 200]);
    expect((await after).status).toBe(200);
  });

  it("free a check slot whose holder crashed after 30 seconds", async () => {
    let now = Date.now();
    const state = memorySharedState(() => now);
    const { search, sources } = hangingFirst(2);
    const crashed = instance(state, { sourcesFor: () => sources });
    const other = instance(state, { sourcesFor: () => sources });

    void post(crashed, "/api/check", movie, "198.51.100.1");
    void post(crashed, "/api/check", movie, "198.51.100.2");
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));

    const busy = await post(other, "/api/check", movie, "198.51.100.3");

    now += 29_000;

    const stillBusy = await post(other, "/api/check", movie, "198.51.100.4");

    now += 1000;

    expect(busy.status).toBe(429);
    expect(stillBusy.status).toBe(429);
    expect((await post(other, "/api/check", movie, "198.51.100.5")).status).toBe(200);
  });

  it("never write a client address into a shared key", async () => {
    const address = "198.51.100.77";
    const state = memorySharedState();
    const spies = [
      vi.spyOn(state, "get"),
      vi.spyOn(state, "set"),
      vi.spyOn(state, "setIfAbsent"),
      vi.spyOn(state, "increment"),
      vi.spyOn(state, "delete"),
    ];
    const { sources } = subtitleSources();
    const app = instance(state, { sourcesFor: () => sources, timings: memoryStore() });
    const asClient = { headers: { "x-test-client": address } };

    await app.request("/api/titles?q=", asClient);
    await app.request(lookUpPath, asClient);
    await app.request(subPath, asClient);
    await post(app, "/api/sources/check", {}, address);
    await post(app, "/api/check", movie, address);
    await post(app, "/api/v1/fixes", fixBody(), address);

    const keys = spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));

    expect(keys.some((key) => key.startsWith("rl:"))).toBe(true);
    keys.forEach((key) => expect(key).not.toContain(address));
  });

  it("never serve a summary read before a write on another instance", async () => {
    const state = memorySharedState();
    const store = memoryStore();
    const gate = Promise.withResolvers<void>();
    let reading = false;
    const fixesFor: TimingsStore["fixesFor"] = async (key) => {
      const rows = await store.fixesFor(key);

      if (!reading) {
        reading = true;
        await gate.promise;
      }

      return rows;
    };
    const slow = instance(state, { timings: { ...store, fixesFor } });
    const writer = instance(state, { timings: store });
    const inFlight = fixesOf(slow);

    await vi.waitFor(() => expect(reading).toBe(true));
    expect((await post(writer, "/api/v1/fixes", fixBody())).status).toBe(202);
    gate.resolve();

    expect(await inFlight).toEqual([]);
    expect(await fixesOf(slow)).toHaveLength(1);
    expect(await fixesOf(writer)).toHaveLength(1);
  });

  it("give one client the same origin on the same day and another the next day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 14, 12));

    const state = memorySharedState();
    const store = memoryStore();
    const one = instance(state, { timings: store });
    const two = instance(state, { timings: store });

    expect((await post(one, "/api/v1/fixes", fixBody())).status).toBe(202);
    expect((await post(two, "/api/v1/fixes", fixBody())).status).toBe(202);

    vi.setSystemTime(Date.UTC(2026, 10, 15, 12));
    expect((await post(two, "/api/v1/fixes", fixBody())).status).toBe(202);

    const [first, second, nextDay] = (await store.fixesFor(video)).map((fix) => fix.origin);

    expect(first).toBe(second);
    expect(nextDay).not.toBe(first);
  });

  it("share a summary until a write on either instance", async () => {
    const state = memorySharedState();
    const store = memoryStore();
    const one = counted(store);
    const two = counted(store);
    const first = instance(state, { timings: one });
    const second = instance(state, { timings: two });

    await first.request(lookUpPath);
    await second.request(lookUpPath);

    expect(one.fixesFor).toHaveBeenCalledTimes(1);
    expect(two.fixesFor).not.toHaveBeenCalled();
    expect((await post(second, "/api/v1/fixes", fixBody())).status).toBe(202);

    const read = (await (await first.request(lookUpPath)).json()) as { fixes: unknown[] };

    expect(read.fixes).toHaveLength(1);
    expect(one.fixesFor).toHaveBeenCalledTimes(2);
  });
});

describe("instances without shared state", () => {
  it("each download a subtitle themselves", async () => {
    const { source, sources } = subtitleSources(50);

    await Promise.all(
      [1, 2].map(() => instance(undefined, { sourcesFor: () => sources }).request(subPath)),
    );

    expect(source.download).toHaveBeenCalledTimes(2);
  });
});

describe("a shared state that fails on every call", () => {
  it("still answers every read and does the work itself", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { source, sources } = subtitleSources();
    const app = instance(brokenState, { sourcesFor: () => sources, timings: memoryStore() });
    const listing = await app.request(`/${token}/subtitles/movie/tt0111161.json`);
    const files = await Promise.all([app.request(subPath), app.request(subPath)]);

    expect(source.download).toHaveBeenCalledTimes(2);
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/api/titles?q=")).status).toBe(200);
    expect((await post(app, "/api/sources/check", {})).status).toBe(400);
    expect((await post(app, "/api/check", movie)).status).toBe(200);
    expect((await app.request(`/${token}/manifest.json`)).status).toBe(200);
    expect(listing.status).toBe(200);
    expect(((await listing.json()) as { subtitles: unknown[] }).subtitles).toHaveLength(1);
    expect(files.map((file) => file.status)).toEqual([200, 200]);
    expect(await files[0]?.text()).toBe(writeSRT(track));
    expect((await app.request(lookUpPath)).status).toBe(200);
    expect(log.mock.calls.flat().join(" ")).not.toContain(token);
  });

  it.each([
    ["/api/v1/fixes", fixBody()],
    ["/api/v1/mismatches", mismatchBody()],
    ["/api/v1/reports", { ...mismatchBody(), reason: "timing-off" }],
  ])("refuses a write to %s with 503", async (path, body) => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const store = memoryStore();
    const response = await post(instance(brokenState, { timings: store }), path, body);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Try again in a moment" });
    expect(await store.fixesFor(video)).toEqual([]);
    expect(await store.mismatchesFor(video)).toEqual([]);
  });
});

describe("logins cached for an install link", () => {
  it("are shared between the addon routes and the check of the same link only", async () => {
    const seen: TokenCache[] = [];
    const other = seal(defaultConfig(["fra"]), secret);
    const app = instance(undefined, {
      sourcesFor: (_, tokens) => {
        seen.push(tokens);

        return { listed: [], references: [] };
      },
    });
    const checkWith = (sealed: string) =>
      post(app, "/api/check", {
        ...movie,
        installURL: `https://example.com/${sealed}/manifest.json`,
      });

    await app.request(`/${token}/subtitles/movie/tt0111161.json`);
    await seen[0]?.set("login", "session", 60);
    await checkWith(token);
    await checkWith(other);

    expect(seen).toHaveLength(3);
    expect(await seen[1]?.get("login")).toBe("session");
    expect(await seen[2]?.get("login")).toBeUndefined();
  });
});
