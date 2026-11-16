import { buffer } from "node:stream/consumers";
import { createGunzip, gunzipSync } from "node:zlib";
import type { Readable } from "node:stream";
import { get, put, type PutBlobResult } from "@vercel/blob";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { memoryStore, type TimingsStore } from "./db.ts";
import { writeDump } from "./dump.ts";
import { groupingKeyOf } from "./submitter.ts";
import { fix, subtitle, submitterAt, video } from "./test-fixes.ts";

vi.mock("@vercel/blob", () => ({ put: vi.fn<typeof put>(), get: vi.fn<typeof get>() }));

const secret = "a-test-secret-that-is-long-enough-1234";
const installSalt = "an-install-salt-that-is-long-enough-12";
const groupingKey = groupingKeyOf(installSalt);
const blobToken = "vercel_blob_rw_store_secret";
const cronSecret = "a-cron-secret-that-is-long-enough-123";
const otherVideo = { hash: "fedcba9876543210", size: 1_000 };
const lonelyVideo = { hash: "ffffffffffffffff", size: 1 };
const dumpURL = "https://store.public.blob.vercel-storage.com/open-timings-2026-11-16.jsonl.gz";

type Uploaded = { pathname: string; body: Buffer; options: unknown };

const uploads: Uploaded[] = [];

const blobAt = (pathname: string): PutBlobResult => ({
  url: `https://store.public.blob.vercel-storage.com/${pathname}`,
  downloadUrl: `https://store.public.blob.vercel-storage.com/${pathname}?download=1`,
  pathname,
  contentType: "application/octet-stream",
  contentDisposition: `attachment; filename="${pathname}"`,
  etag: "etag",
});

const keepUploads = () =>
  vi.mocked(put).mockImplementation(async (pathname, body, options) => {
    uploads.push({
      pathname,
      body: typeof body === "string" ? Buffer.from(body) : await buffer(body as Readable),
      options,
    });

    return blobAt(pathname);
  });

const seeded = async () => {
  const store = memoryStore();
  const cues = subtitle(3);

  await store.putFix(fix(cues, { submitter: submitterAt(1) }));
  await store.putFix(fix(cues, { submitter: submitterAt(2) }));
  await store.putMismatch({
    video: otherVideo,
    subtitleHashes: ["1111111111111111"],
    submitter: submitterAt(1),
    origin: "0000000000000001",
  });
  await store.putMismatch({
    video: otherVideo,
    subtitleHashes: ["1111111111111111"],
    submitter: submitterAt(2),
    origin: "0000000000000002",
  });
  await store.putMismatch({
    video: lonelyVideo,
    subtitleHashes: ["1111111111111111"],
    submitter: submitterAt(1),
    origin: "0000000000000001",
  });

  return store;
};

const linesOf = (body: Buffer) =>
  gunzipSync(body)
    .toString("utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown);

const appWith = (store: TimingsStore, overrides: { blobToken?: string; cronSecret?: string }) =>
  createApp({ secret, installSalt, timings: store, ...overrides });

const runCron = (app: ReturnType<typeof createApp>, authorization?: string) =>
  app.request("/api/cron/dump", authorization === undefined ? {} : { headers: { authorization } });

beforeEach(() => {
  uploads.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 10, 16, 3, 30));
  keepUploads();
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(put).mockReset();
  vi.mocked(get).mockReset();
});

describe("writeDump", () => {
  it("writes each video the public API has something for as one gzipped JSON line", async () => {
    const store = await seeded();
    const app = appWith(store, {});

    await writeDump(store, { groupingKey, blobToken }, new Date());

    const [dump] = uploads;

    const lines = linesOf(dump?.body ?? Buffer.alloc(0));
    const apiBodies = await Promise.all(
      [video, otherVideo].map(async ({ hash, size }) =>
        (await app.request(`/api/v1/fixes?video=${hash}:${size}`)).json(),
      ),
    );

    expect(dump?.pathname).toBe("open-timings-2026-11-16.jsonl.gz");
    expect(lines).toEqual([
      { video: "0123456789abcdef:7345678901", ...(apiBodies[0] as object) },
      { video: "fedcba9876543210:1000", ...(apiBodies[1] as object) },
    ]);
    expect(lines).toMatchObject([
      { fixes: [{ status: "confirmed", agreeing: 2, cueCount: 40 }], hidden: [] },
      { fixes: [], hidden: [{ reason: "mismatch", count: 2 }] },
    ]);
  });

  it("uploads the dump publicly under its date, then points to it", async () => {
    await writeDump(await seeded(), { groupingKey, blobToken }, new Date());

    expect(uploads.map(({ pathname, options }) => ({ pathname, options }))).toEqual([
      {
        pathname: "open-timings-2026-11-16.jsonl.gz",
        options: {
          access: "public",
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType: "application/gzip",
          multipart: true,
          token: "vercel_blob_rw_store_secret",
        },
      },
      {
        pathname: "open-timings-latest.json",
        options: {
          access: "public",
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType: "application/json",
          token: "vercel_blob_rw_store_secret",
        },
      },
    ]);
    expect(JSON.parse(uploads[1]?.body.toString("utf8") ?? "")).toEqual({
      url: dumpURL,
      date: "2026-11-16",
      videos: 2,
    });
  });

  it("leaves the pointer alone when the store fails partway", async () => {
    const store = await seeded();
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      hash: index.toString(16).padStart(16, "0"),
      size: 1,
    }));
    const failing: TimingsStore = {
      ...store,
      videoPage: async (after) => {
        if (after !== undefined) {
          throw new Error("connection lost");
        }

        return firstPage;
      },
    };

    await expect(writeDump(failing, { groupingKey, blobToken }, new Date())).rejects.toThrow(
      "connection lost",
    );
    expect(vi.mocked(put).mock.calls.map(([pathname]) => pathname)).toEqual([
      "open-timings-2026-11-16.jsonl.gz",
    ]);
  });

  it(
    "streams a million videos while holding at most a few pages of them",
    { timeout: 120_000 },
    async () => {
      const total = 1_000_000;
      const empty = memoryStore();
      const cues = subtitle(4, 1);
      const pageLimits: number[] = [];
      let fetched = 0;
      let lookedUp = 0;
      let consumed = 0;
      let mostRowsHeld = 0;
      let mostLinesBuffered = 0;

      const store: TimingsStore = {
        ...empty,
        fixesFor: async (key) => {
          lookedUp += 1;
          mostRowsHeld = Math.max(mostRowsHeld, fetched - lookedUp + 1);

          return [fix(cues, { video: key })];
        },
        videoPage: async (after, limit) => {
          const start = after === undefined ? 0 : Number.parseInt(after.hash, 16) + 1;
          const page = Array.from(
            { length: Math.max(0, Math.min(limit, total - start)) },
            (_, index) => ({
              hash: (start + index).toString(16).padStart(16, "0"),
              size: start + index + 1,
            }),
          );

          pageLimits.push(limit);
          fetched += page.length;
          mostRowsHeld = Math.max(mostRowsHeld, fetched - lookedUp);
          mostLinesBuffered = Math.max(mostLinesBuffered, fetched - consumed);

          return page;
        },
      };

      vi.mocked(put).mockImplementation(async (pathname, body) => {
        if (pathname.endsWith(".jsonl.gz")) {
          let last = "";

          for await (const chunk of (body as Readable).pipe(createGunzip())) {
            const text = last + (chunk as Buffer).toString("utf8");
            const lines = text.split("\n");

            last = lines.pop() ?? "";
            consumed += lines.length;
            await new Promise(setImmediate);
          }
        }

        return blobAt(pathname);
      });

      const result = await writeDump(store, { groupingKey, blobToken }, new Date());

      expect(result).toEqual({ url: dumpURL, date: "2026-11-16", videos: 1_000_000 });
      expect(consumed).toBe(1_000_000);
      expect(new Set(pageLimits)).toEqual(new Set([500]));
      expect(pageLimits).toHaveLength(2001);
      expect(mostRowsHeld).toBe(500);
      expect(mostLinesBuffered).toBeLessThan(20_000);
    },
  );
});

describe("GET /api/cron/dump", () => {
  it("refuses every caller when no cron secret is set", async () => {
    const response = await runCron(appWith(memoryStore(), { blobToken }), "Bearer undefined");

    expect(response.status).toBe(401);
    expect(uploads).toEqual([]);
  });

  it("refuses a missing or wrong bearer", async () => {
    const app = appWith(memoryStore(), { blobToken, cronSecret });

    expect((await runCron(app)).status).toBe(401);
    expect((await runCron(app, "Bearer not-the-cron-secret")).status).toBe(401);
    expect(uploads).toEqual([]);
  });

  it("answers 503 when data dumps are not configured", async () => {
    const response = await runCron(appWith(memoryStore(), { cronSecret }), `Bearer ${cronSecret}`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Data dumps are not configured" });
  });

  it("writes the dump for the cron", async () => {
    const response = await runCron(
      appWith(await seeded(), { blobToken, cronSecret }),
      `Bearer ${cronSecret}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: dumpURL, date: "2026-11-16", videos: 2 });
    expect(uploads.map((upload) => upload.pathname)).toEqual([
      "open-timings-2026-11-16.jsonl.gz",
      "open-timings-latest.json",
    ]);
  });
});

const pointer = (text: string) =>
  vi.mocked(get).mockResolvedValue({
    statusCode: 200,
    stream: new Response(text).body ?? new ReadableStream(),
    headers: new Headers(),
    blob: {
      url: "https://store.public.blob.vercel-storage.com/open-timings-latest.json",
      downloadUrl:
        "https://store.public.blob.vercel-storage.com/open-timings-latest.json?download=1",
      pathname: "open-timings-latest.json",
      contentDisposition: 'attachment; filename="open-timings-latest.json"',
      cacheControl: "public, max-age=2592000",
      uploadedAt: new Date(),
      etag: "etag",
      contentType: "application/json",
      size: text.length,
    },
  });

describe("GET /api/v1/dump", () => {
  it("answers 404 when data dumps are not configured", async () => {
    const response = await appWith(memoryStore(), {}).request("/api/v1/dump");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "No data dump yet" });
    expect(get).not.toHaveBeenCalled();
  });

  it("answers 404 before the first dump", async () => {
    vi.mocked(get).mockResolvedValue(null);

    const response = await appWith(memoryStore(), { blobToken }).request("/api/v1/dump");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "No data dump yet" });
  });

  it("redirects to the latest dump", async () => {
    pointer(JSON.stringify({ url: dumpURL, date: "2026-11-16", videos: 2 }));

    const response = await appWith(memoryStore(), { blobToken }).request("/api/v1/dump");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(dumpURL);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600, s-maxage=3600");
    expect(vi.mocked(get).mock.calls).toEqual([
      [
        "open-timings-latest.json",
        { access: "public", token: "vercel_blob_rw_store_secret", useCache: false },
      ],
    ]);
  });
});
