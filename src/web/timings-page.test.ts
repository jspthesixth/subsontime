import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { memoryStore, type NewFix, type TimingsStore } from "../timings/db.ts";

const secret = "a-test-secret-that-is-long-enough-1234";
const installSalt = "an-install-salt-that-is-long-enough-12";
const video = { hash: "0123456789abcdef", size: 7_345_678_901 };
const otherVideo = { hash: "fedcba9876543210", size: 1_000 };
const privacySentences = [
  "Submissions carry no account and no address. A daily-changing code makes it harder for one connection to confirm its own fix or hide a subtitle; it cannot be traced back after that day.",
  "Very short common lines, like Yes, can be guessed from their fingerprint; longer lines cannot.",
];

const unavailableNote = "Numbers are unavailable right now.";

const fix = (overrides: Partial<NewFix>): NewFix => ({
  video,
  subtitleHashes: ["1111111111111111"],
  cues: [{ h: "1111111111111111", s: 1000, e: 2000 }],
  method: "audio",
  submitter: "a".repeat(32),
  ...overrides,
});

const seeded = async () => {
  const store = memoryStore();

  await store.putFix(fix({ origin: "1".repeat(16) }));
  await store.putFix(fix({ submitter: "b".repeat(32), origin: "2".repeat(16) }));
  await store.putFix(fix({ video: otherVideo, origin: "1".repeat(16) }));
  await store.putMismatch({
    video: otherVideo,
    subtitleHashes: ["2222222222222222"],
    submitter: "a".repeat(32),
    origin: "1".repeat(16),
  });
  await store.putMismatch({
    video: otherVideo,
    subtitleHashes: ["2222222222222222"],
    submitter: "b".repeat(32),
    origin: "2".repeat(16),
  });

  return store;
};

const appWith = (timings: TimingsStore) =>
  createApp({
    secret,
    installSalt,
    timings,
    clientKey: (context) => context.req.header("x-client") ?? "1.2.3.4",
  });

const statValues = (page: string) =>
  [...page.matchAll(/<span class="stat-n">([^<]*)<\/span\s*>/g)].map(([, value]) => value);

describe("GET /timings", () => {
  it("renders one h1 and the four numbers from the store", async () => {
    const response = await appWith(await seeded()).request("/timings");
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(page.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(statValues(page)).toEqual(["3", "1", "2", "1"]);
  });

  it("formats large numbers with thousands separators", async () => {
    const store = {
      ...memoryStore(),
      stats: async () => ({ fixes: 1234567, confirmed: 12345, videos: 98765, hidden: 4321 }),
    };
    const page = await (await appWith(store).request("/timings")).text();

    expect(statValues(page)).toEqual(["1,234,567", "12,345", "98,765", "4,321"]);
  });

  it("shows the numbers as unavailable when Open Timings is not set up", async () => {
    const page = await (await createApp({ secret }).request("/timings")).text();

    expect(statValues(page)).toEqual(["-", "-", "-", "-"]);
    expect(page).toContain(unavailableNote);
  });

  it("leaves the unavailable note out when the numbers are real", async () => {
    const page = await (await appWith(memoryStore()).request("/timings")).text();

    expect(statValues(page)).toEqual(["0", "0", "0", "0"]);
    expect(page).not.toContain(unavailableNote);
  });

  it("shows the numbers as unavailable when the store cannot be read", async () => {
    const store = {
      ...memoryStore(),
      stats: () => Promise.reject(new Error("down")),
    };
    const response = await appWith(store).request("/timings");

    expect(response.status).toBe(200);
    const page = await response.text();

    expect(statValues(page)).toEqual(["-", "-", "-", "-"]);
    expect(page).toMatch(
      /<span class="stat-n">-<\/span\s*><span class="small">timing fixes<\/span>/,
    );
    expect(page).toContain(unavailableNote);
  });

  it("states what is kept about submitters word for word", async () => {
    const page = await (await appWith(memoryStore()).request("/timings")).text();
    const text = page.replace(/\s+/g, " ");

    privacySentences.forEach((sentence) => expect(text).toContain(sentence));
  });

  it("lists the real API endpoints and links the CC0 data download", async () => {
    const page = await (await appWith(memoryStore()).request("/timings")).text();

    expect(page).toContain("GET /api/v1/fixes?video=");
    expect(page).toContain("GET /api/v1/fixes/");
    expect(page).toContain("POST /api/v1/fixes");
    expect(page).toContain("POST /api/v1/mismatches");
    expect(page).toContain("POST /api/v1/reports");
    expect(page).toContain('<a class="btn btn-ghost" href="/api/v1/dump">Download the data</a>');
    expect(page).toContain("Daily, gzipped JSON Lines, CC0-1.0");
    expect(page).not.toContain("at launch");
    expect(page).toContain('<script type="module" src="/client/timings.js"></script>');
  });
});

describe("GET /api/v1/stats", () => {
  it("returns the numbers from the store", async () => {
    const response = await appWith(await seeded()).request("/api/v1/stats");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fixes: 3, confirmed: 1, videos: 2, hidden: 1 });
  });

  it("keeps the numbers for ten minutes", async () => {
    const store = await seeded();
    const app = appWith(store);

    await app.request("/api/v1/stats");
    await store.putFix(fix({ video: { hash: "00000000000000ff", size: 5 } }));

    expect(await (await app.request("/api/v1/stats")).json()).toMatchObject({ fixes: 3 });
  });

  it("does not keep a failed read", async () => {
    const store = await seeded();
    let failing = true;
    const app = appWith({
      ...store,
      stats: () => (failing ? Promise.reject(new Error("down")) : store.stats()),
    });

    const failed = await app.request("/api/v1/stats");

    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "Try again in a moment" });

    failing = false;

    expect(await (await app.request("/api/v1/stats")).json()).toMatchObject({ fixes: 3 });
  });

  it("reads the store once for concurrent requests on a cache miss", async () => {
    const store = await seeded();
    let reads = 0;
    const app = appWith({
      ...store,
      stats: async () => {
        reads += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));

        return store.stats();
      },
    });

    const bodies = await Promise.all(
      Array.from({ length: 3 }, async () => (await app.request("/api/v1/stats")).json()),
    );

    expect(reads).toBe(1);
    expect(bodies).toEqual(
      Array.from({ length: 3 }, () => ({ fixes: 3, confirmed: 1, videos: 2, hidden: 1 })),
    );
  });

  it("allows 60 requests a minute from one client", async () => {
    const app = appWith(memoryStore());
    const statuses = [];

    for (const _ of Array.from({ length: 61 })) {
      statuses.push((await app.request("/api/v1/stats")).status);
    }

    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect(
      (await app.request("/api/v1/stats", { headers: { "x-client": "5.6.7.8" } })).status,
    ).toBe(200);
  });
});
