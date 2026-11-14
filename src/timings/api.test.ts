import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { memoryTokenCache } from "../sources/token-cache.ts";
import { TimingsInputError, lookUp, submitFix, submitMismatch } from "./api.ts";
import { memoryStore, subtitleKey, type TimingsStore } from "./db.ts";
import type { FixCue } from "./fingerprint.ts";
import { groupingKeyOf, submitterOf } from "./submitter.ts";

const secret = "a-test-secret-that-is-long-enough-1234";
const installSalt = "an-install-salt-that-is-long-enough-12";
const video = { hash: "0123456789abcdef", size: 7_345_678_901 };
const videoParam = `${video.hash}:${video.size}`;
const subtitleMessage =
  "Send subtitle as 1 to 5000 cues, each a 16-character hex hash with start and end times in order";

const appWith = (store: TimingsStore, clientKey = () => "1.2.3.4") =>
  createApp({ secret, tokens: memoryTokenCache(), installSalt, timings: store, clientKey });

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const cues = (count: number): FixCue[] =>
  Array.from({ length: count }, (_, index) => ({
    h: index.toString(16).padStart(16, "0"),
    s: index * 1000,
    e: index * 1000 + 900,
  }));

const groupingKey = groupingKeyOf(installSalt);

const writer = { submitter: "a".repeat(32), origin: "0123456789abcdef" };

const fixBody = (overrides: Record<string, unknown> = {}) => ({
  video,
  subtitle: cues(3),
  method: "audio",
  installId: randomUUID(),
  ...overrides,
});

const mismatchBody = (overrides: Record<string, unknown> = {}) => ({
  video,
  subtitleHashes: ["1111111111111111", "2222222222222222"],
  installId: randomUUID(),
  ...overrides,
});

const reportBody = (overrides: Record<string, unknown> = {}) => ({
  ...mismatchBody(),
  reason: "timing-off",
  ...overrides,
});

describe("POST /api/v1/fixes", () => {
  it("accepts a fix and serves it back", async () => {
    const store = memoryStore();
    const app = appWith(store);
    const response = await post(app, "/api/v1/fixes", fixBody());

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });

    const read = await app.request(`/api/v1/fixes?video=${videoParam}`);

    expect(await read.json()).toEqual({
      fixes: [
        {
          id: subtitleKey(cues(3).map((cue) => cue.h)),
          subtitleSketch: cues(3).map((cue) => cue.h),
          status: "hint",
          method: "audio",
          agreeing: 1,
          fromAudio: true,
          cueCount: 3,
        },
      ],
      hidden: [],
    });
  });

  it("stores the reference key of a reference fix", async () => {
    const store = memoryStore();
    const referenceKey = "1111111111111111,2222222222222222";
    const response = await post(
      appWith(store),
      "/api/v1/fixes",
      fixBody({ method: "reference", referenceKey }),
    );

    expect(response.status).toBe(202);
    expect((await store.fixesFor(video))[0]?.referenceKey).toBe(referenceKey);
  });

  it.each([
    ["text instead of a hash", "hello world"],
    ["15 hex characters", "0123456789abcde"],
    ["uppercase hex", "0123456789ABCDEF"],
  ])("rejects a cue hash that is %s without echoing it", async (_, h) => {
    const response = await post(
      appWith(memoryStore()),
      "/api/v1/fixes",
      fixBody({ subtitle: [{ h, s: 0, e: 900 }] }),
    );
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: subtitleMessage });
    expect(text).not.toContain(h);
  });

  it("rejects more than 5000 cues", async () => {
    const response = await post(appWith(memoryStore()), "/api/v1/fixes", {
      ...fixBody(),
      subtitle: cues(5001),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: subtitleMessage });
  });

  it("rejects an empty cue list", async () => {
    const response = await post(appWith(memoryStore()), "/api/v1/fixes", fixBody({ subtitle: [] }));

    expect(response.status).toBe(400);
  });

  it("rejects a cue that ends before it starts", async () => {
    const response = await post(
      appWith(memoryStore()),
      "/api/v1/fixes",
      fixBody({ subtitle: [{ h: "1111111111111111", s: 2000, e: 1000 }] }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: subtitleMessage });
  });

  it("rejects cues whose starts go backwards", async () => {
    const response = await post(
      appWith(memoryStore()),
      "/api/v1/fixes",
      fixBody({
        subtitle: [
          { h: "1111111111111111", s: 5000, e: 6000 },
          { h: "2222222222222222", s: 1000, e: 2000 },
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: subtitleMessage });
  });

  it.each([
    ["a fraction", 1.5],
    ["a negative time", -1],
    ["more than a day", 86_400_001],
  ])("rejects a cue time that is %s", async (_, time) => {
    const response = await post(
      appWith(memoryStore()),
      "/api/v1/fixes",
      fixBody({ subtitle: [{ h: "1111111111111111", s: time, e: 86_400_001 }] }),
    );

    expect(response.status).toBe(400);
  });

  it("keeps only the hash and times of a cue", async () => {
    const store = memoryStore();
    const app = appWith(store);

    await post(
      app,
      "/api/v1/fixes",
      fixBody({ subtitle: [{ h: "1111111111111111", s: 0, e: 900, text: "secret line" }] }),
    );

    const read = await app.request(`/api/v1/fixes?video=${videoParam}`);

    expect(await read.text()).not.toContain("secret line");
    expect((await store.fixesFor(video))[0]?.cues).toEqual([
      { h: "1111111111111111", s: 0, e: 900 },
    ]);
  });

  it.each([
    ["video", { video: { hash: "movie.mkv", size: 1 } }, "video"],
    ["video size", { video: { hash: video.hash, size: 0 } }, "video"],
    ["method", { method: "guess" }, "method"],
    ["referenceKey", { referenceKey: "a reference title" }, "referenceKey"],
    ["installId", { installId: "my-laptop" }, "installId"],
  ])("rejects a bad %s with a fixed message", async (_, overrides, field) => {
    const response = await post(appWith(memoryStore()), "/api/v1/fixes", fixBody(overrides));
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(text).error).toMatch(new RegExp(`^Send ${field} as `));
    Object.values(overrides).forEach((value) =>
      expect(text).not.toContain(typeof value === "string" ? value : value.hash),
    );
  });

  it("rejects a body that is not an object", async () => {
    const response = await post(appWith(memoryStore()), "/api/v1/fixes", "[1, 2]");

    expect(response.status).toBe(400);
  });

  it("accepts a 300 KB fix while other API routes keep the 16 KB limit", async () => {
    const app = appWith(memoryStore());
    const body = JSON.stringify(fixBody({ subtitle: cues(5000) }), null, 2);

    expect(Buffer.byteLength(body)).toBeGreaterThan(300 * 1024);

    const fixResponse = await post(app, "/api/v1/fixes", body);
    const configResponse = await post(app, "/api/config", { padding: "x".repeat(20 * 1024) });

    expect(fixResponse.status).toBe(202);
    expect(configResponse.status).toBe(413);
  });

  it("refuses a fix over 512 KB", async () => {
    const response = await post(
      appWith(memoryStore()),
      "/api/v1/fixes",
      fixBody({ padding: "x".repeat(513 * 1024) }),
    );

    expect(response.status).toBe(413);
  });
});

describe("POST /api/v1/mismatches and /api/v1/reports", () => {
  it("stores a mismatch", async () => {
    const store = memoryStore();
    const body = mismatchBody();
    const response = await post(appWith(store), "/api/v1/mismatches", body);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(await store.mismatchesFor(video)).toMatchObject([
      {
        subtitleHashes: body.subtitleHashes,
        submitter: submitterOf(body.installId, installSalt),
      },
    ]);
  });

  it("stores a report", async () => {
    const store = memoryStore();
    const response = await post(appWith(store), "/api/v1/reports", reportBody());

    expect(response.status).toBe(202);
    expect(await store.reportsFor(video)).toMatchObject([{ reason: "timing-off" }]);
  });

  it("rejects a hash list with text in it", async () => {
    const response = await post(
      appWith(memoryStore()),
      "/api/v1/mismatches",
      mismatchBody({ subtitleHashes: ["hello world"] }),
    );
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toEqual({
      error: "Send subtitleHashes as 1 to 5000 16-character hex hashes",
    });
    expect(text).not.toContain("hello world");
  });

  it("rejects more than 5000 hashes", async () => {
    const response = await post(
      appWith(memoryStore()),
      "/api/v1/reports",
      reportBody({ subtitleHashes: cues(5001).map((cue) => cue.h) }),
    );

    expect(response.status).toBe(400);
  });

  it("rejects an unknown report reason", async () => {
    const response = await post(
      appWith(memoryStore()),
      "/api/v1/reports",
      reportBody({ reason: "rude words" }),
    );
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(text).not.toContain("rude words");
  });
});

describe("write limit", () => {
  it("refuses the 61st write in an hour from one client even with new install ids", async () => {
    const store = memoryStore();
    const app = appWith(store);
    const writes = Array.from(
      { length: 60 },
      (_, index) =>
        [
          () => post(app, "/api/v1/fixes", fixBody()),
          () => post(app, "/api/v1/mismatches", mismatchBody()),
          () => post(app, "/api/v1/reports", reportBody()),
        ][index % 3],
    );

    for (const write of writes) {
      expect((await write?.())?.status).toBe(202);
    }

    const refused = await post(app, "/api/v1/fixes", fixBody());

    expect(refused.status).toBe(429);
    expect(await store.fixesFor(video)).toHaveLength(8);
  });

  it("counts writes per client", async () => {
    const store = memoryStore();
    const clients = ["1.1.1.1", "2.2.2.2"];
    let current = 0;
    const app = appWith(store, () => clients[current] ?? "");

    for (const _ of Array.from({ length: 60 })) {
      await post(app, "/api/v1/mismatches", mismatchBody());
    }

    current = 1;

    expect((await post(app, "/api/v1/mismatches", mismatchBody())).status).toBe(202);
  });

  it("does not count reads", async () => {
    const app = appWith(memoryStore());

    for (const _ of Array.from({ length: 61 })) {
      await app.request(`/api/v1/fixes?video=${videoParam}`);
    }

    expect((await post(app, "/api/v1/fixes", fixBody())).status).toBe(202);
  });
});

describe("GET /api/v1/fixes", () => {
  it("returns no submitter, install id or time", async () => {
    const store = memoryStore();
    const app = appWith(store);
    const installIds = [randomUUID(), randomUUID()];

    for (const [position, installId] of installIds.entries()) {
      await post(
        app,
        "/api/v1/fixes",
        fixBody({ installId, subtitle: cues(6).slice(position * 3, position * 3 + 3) }),
      );
    }

    const response = await app.request(`/api/v1/fixes?video=${videoParam}`);
    const text = await response.text();

    expect(JSON.parse(text).fixes).toHaveLength(2);
    ["submitter", "installId", "createdAt", "video", ...installIds]
      .concat(installIds.map((installId) => submitterOf(installId, installSalt)))
      .forEach((secretValue) => expect(text).not.toContain(secretValue));
  });

  it("is publicly cacheable for five minutes and open to any origin", async () => {
    const response = await appWith(memoryStore()).request(`/api/v1/fixes?video=${videoParam}`, {
      headers: { origin: "https://example.com" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual({ fixes: [], hidden: [] });
  });

  it.each([
    "",
    "0123456789abcdef",
    "0123456789abcdef:0",
    "movie.mkv:12",
    "0123456789abcdef:1e9",
    "0123456789abcdef:0100",
  ])("rejects the video parameter %j", async (param) => {
    const response = await appWith(memoryStore()).request(`/api/v1/fixes?video=${param}`);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Send video as a 16-character hex hash and a size in bytes",
    });
  });

  it("answers a cross-origin preflight for writes", async () => {
    const response = await appWith(memoryStore()).request("/api/v1/fixes", {
      method: "OPTIONS",
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("GET /api/v1/fixes/:video/:id/cues", () => {
  it("returns the cues of the listed fix", async () => {
    const app = appWith(memoryStore());
    const other = cues(6).slice(3);

    await post(app, "/api/v1/fixes", fixBody());
    await post(app, "/api/v1/fixes", fixBody({ subtitle: other }));

    const listed = await (await app.request(`/api/v1/fixes?video=${videoParam}`)).json();
    const id = subtitleKey(other.map((cue) => cue.h));
    const response = await app.request(`/api/v1/fixes/${videoParam}/${id}/cues`);

    expect(listed.fixes.map((view: { id: string }) => view.id)).toContain(id);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.json()).toEqual({ cues: other });
  });

  it("keeps the id of a group when a newer fix with a slightly different list joins", async () => {
    let client = "1.1.1.1";
    const app = appWith(memoryStore(), () => client);
    const listedIds = async () =>
      (await (await app.request(`/api/v1/fixes?video=${videoParam}`)).json()).fixes.map(
        (view: { id: string }) => view.id,
      );

    await post(app, "/api/v1/fixes", fixBody({ subtitle: cues(30) }));

    const [before] = await listedIds();

    client = "2.2.2.2";
    await post(app, "/api/v1/fixes", fixBody({ subtitle: cues(30).slice(1) }));

    const response = await app.request(`/api/v1/fixes/${videoParam}/${before}/cues`);

    expect(before).toBe(subtitleKey(cues(30).map((cue) => cue.h)));
    expect(await listedIds()).toEqual([before]);
    expect(response.status).toBe(200);
    expect((await response.json()).cues).toHaveLength(30);
  });

  it("answers 404 for a fix that is no longer listed", async () => {
    const response = await appWith(memoryStore()).request(
      `/api/v1/fixes/${videoParam}/${"0".repeat(32)}/cues`,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "This fix is no longer listed" });
  });

  it("rejects a bad video parameter", async () => {
    const response = await appWith(memoryStore()).request(
      `/api/v1/fixes/movie.mkv:12/${"0".repeat(32)}/cues`,
    );

    expect(response.status).toBe(400);
  });
});

const confirmingFix = (installId: string) =>
  fixBody({ installId, subtitle: cues(30), method: "audio" });

const statusAfter = async (clients: string[]) => {
  let current = 0;
  const app = appWith(memoryStore(), () => clients[current] ?? "");

  for (const [index] of clients.entries()) {
    current = index;
    await post(app, "/api/v1/fixes", confirmingFix(randomUUID()));
    await post(app, "/api/v1/mismatches", mismatchBody());
  }

  return (await app.request(`/api/v1/fixes?video=${videoParam}`)).json();
};

describe("origins", () => {
  it("never confirms or hides for two install ids on one connection", async () => {
    expect(await statusAfter(["1.1.1.1", "1.1.1.1"])).toMatchObject({
      fixes: [{ status: "hint" }],
      hidden: [],
    });
  });

  it("confirms and hides for two connections", async () => {
    expect(await statusAfter(["1.1.1.1", "2.2.2.2"])).toMatchObject({
      fixes: [{ status: "confirmed", agreeing: 2 }],
      hidden: [{ reason: "mismatch", count: 2 }],
    });
  });

  it("puts the origin in no response and no log", async () => {
    const store = memoryStore();
    const app = appWith(store);
    const logged = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const responses = [
      await post(app, "/api/v1/fixes", fixBody()),
      await post(app, "/api/v1/mismatches", mismatchBody()),
      await post(app, "/api/v1/reports", reportBody()),
      await post(app, "/api/v1/fixes", "not json"),
      await app.request(`/api/v1/fixes?video=${videoParam}`),
      await app.request(
        `/api/v1/fixes/${videoParam}/${subtitleKey(cues(3).map((cue) => cue.h))}/cues`,
      ),
    ];
    const texts = await Promise.all(responses.map((response) => response.text()));
    const [origin = ""] = (await store.fixesFor(video)).map((row) => row.origin ?? "");
    const calls = logged.flatMap((spy) => spy.mock.calls.flat().map(String));

    logged.forEach((spy) => spy.mockRestore());

    expect(origin).toMatch(/^[0-9a-f]{16}$/);
    expect([...texts, ...calls].filter((text) => text.includes(origin))).toEqual([]);
  });
});

describe("in-process handlers", () => {
  it("validate the same way as the routes", async () => {
    const store = memoryStore();

    await expect(
      submitFix(store, fixBody({ subtitle: [{ h: "hello world", s: 0, e: 1 }] }), writer),
    ).rejects.toThrow(new TimingsInputError(subtitleMessage));
    expect(await store.fixesFor(video)).toEqual([]);
  });

  it("look up a video by its key", async () => {
    const store = memoryStore();

    await submitFix(store, fixBody(), writer);

    expect((await lookUp(store, video, { groupingKey })).fixes).toHaveLength(1);
    await expect(lookUp(store, { hash: "x", size: 1 }, { groupingKey })).rejects.toThrow(
      TimingsInputError,
    );
  });

  it("look up a video for one viewer", async () => {
    const store = memoryStore();

    await submitMismatch(store, mismatchBody(), writer);

    expect((await lookUp(store, video, { groupingKey })).hidden).toEqual([]);
    expect((await lookUp(store, video, { groupingKey, viewer: writer.submitter })).hidden).toEqual([
      { subtitleSketch: mismatchBody().subtitleHashes, reason: "mismatch", count: 1 },
    ]);
  });

  it("look up a video with the cues of each fix", async () => {
    const store = memoryStore();

    await submitFix(store, fixBody(), writer);

    expect((await lookUp(store, video, { groupingKey, withCues: true })).fixes).toMatchObject([
      { cues: cues(3), cueCount: 3 },
    ]);
    expect((await lookUp(store, video, { groupingKey })).fixes[0]).not.toHaveProperty("cues");
  });

  it("store the origin of each write", async () => {
    const store = memoryStore();

    await submitFix(store, fixBody(), writer);
    await submitMismatch(store, mismatchBody(), writer);

    expect((await store.fixesFor(video))[0]?.origin).toBe(writer.origin);
    expect((await store.mismatchesFor(video))[0]?.origin).toBe(writer.origin);
  });

  it("serve a cached lookup until a write for that video or five minutes pass", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    const store = memoryStore();
    const counted = { ...store, fixesFor: vi.fn<TimingsStore["fixesFor"]>(store.fixesFor) };

    await lookUp(counted, video, { groupingKey });
    await lookUp(counted, video, { groupingKey });
    await lookUp(counted, { ...video, size: video.size + 1 }, { groupingKey });

    expect(counted.fixesFor).toHaveBeenCalledTimes(2);

    await submitFix(counted, fixBody(), writer);

    expect((await lookUp(counted, video, { groupingKey })).fixes).toHaveLength(1);
    expect(counted.fixesFor).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(299_000);
    await lookUp(counted, video, { groupingKey });
    vi.advanceTimersByTime(2000);
    await lookUp(counted, video, { groupingKey });

    expect(counted.fixesFor).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });
});
