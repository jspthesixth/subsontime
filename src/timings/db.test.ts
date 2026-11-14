import { afterAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { memoryStore, postgresStore, subtitleKey } from "./db.ts";
import type { NewFix, NewMismatch, NewReport, TimingsStore } from "./db.ts";

const video = { hash: "0123456789abcdef", size: 7_345_678_901 };
const otherVideo = { hash: "fedcba9876543210", size: 1_000 };
const submitterA = "a".repeat(32);
const submitterB = "b".repeat(32);

const fix = (overrides: Partial<NewFix> = {}): NewFix => ({
  video,
  subtitleHashes: ["1111111111111111", "2222222222222222"],
  cues: [{ h: "1111111111111111", s: 1000, e: 2000 }],
  method: "audio",
  submitter: submitterA,
  ...overrides,
});

const mismatch = (overrides: Partial<NewMismatch> = {}): NewMismatch => ({
  video,
  subtitleHashes: ["1111111111111111"],
  submitter: submitterA,
  ...overrides,
});

const report = (overrides: Partial<NewReport> = {}): NewReport => ({
  video,
  subtitleHashes: ["1111111111111111"],
  reason: "timing-off",
  submitter: submitterA,
  ...overrides,
});

const contract = (makeStore: () => TimingsStore) => {
  let store = makeStore();

  beforeEach(() => {
    store = makeStore();
  });

  it("returns a stored fix with its video size as a number", async () => {
    await store.putFix(fix({ method: "reference", referenceKey: "ref-1" }));

    const rows = await store.fixesFor(video);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(fix({ method: "reference", referenceKey: "ref-1" }));
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("replaces a submitter's fix for the same video and subtitle", async () => {
    await store.putFix(fix({ method: "audio" }));
    await store.putFix(
      fix({ method: "release-name", cues: [{ h: "2222222222222222", s: 5, e: 9 }] }),
    );

    const rows = await store.fixesFor(video);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      method: "release-name",
      cues: [{ h: "2222222222222222", s: 5, e: 9 }],
    });
  });

  it("moves a re-put fix to the end", async () => {
    await store.putFix(fix({ submitter: submitterA }));
    await store.putFix(fix({ submitter: submitterB }));
    await store.putFix(fix({ submitter: submitterA }));

    const rows = await store.fixesFor(video);

    expect(rows.map((row) => row.submitter)).toEqual([submitterB, submitterA]);
  });

  it("keeps fixes from other submitters and for other subtitles", async () => {
    await store.putFix(fix());
    await store.putFix(fix({ submitter: submitterB }));
    await store.putFix(fix({ subtitleHashes: ["3333333333333333"] }));

    expect(await store.fixesFor(video)).toHaveLength(3);
  });

  it("returns fixes oldest first", async () => {
    await store.putFix(fix({ submitter: submitterA }));
    await store.putFix(fix({ submitter: submitterB }));

    const rows = await store.fixesFor(video);

    expect(rows.map((row) => row.submitter)).toEqual([submitterA, submitterB]);
  });

  it("returns rows for the requested video only", async () => {
    await store.putFix(fix());
    await store.putFix(fix({ video: otherVideo }));
    await store.putMismatch(mismatch());
    await store.putMismatch(mismatch({ video: otherVideo }));
    await store.putReport(report());
    await store.putReport(report({ video: otherVideo }));

    expect((await store.fixesFor(otherVideo)).map((row) => row.video)).toEqual([otherVideo]);
    expect((await store.mismatchesFor(otherVideo)).map((row) => row.video)).toEqual([otherVideo]);
    expect((await store.reportsFor(otherVideo)).map((row) => row.video)).toEqual([otherVideo]);
    expect(await store.fixesFor({ hash: video.hash, size: video.size + 1 })).toEqual([]);
  });

  it("returns the newest rows up to the limit, oldest first", async () => {
    const submitters = [submitterA, submitterB, "c".repeat(32)];

    for (const submitter of submitters) {
      await store.putFix(fix({ submitter }));
      await store.putMismatch(mismatch({ submitter }));
      await store.putReport(report({ submitter }));
    }

    const newest = submitters.slice(1);

    expect((await store.fixesFor(video, 2)).map((row) => row.submitter)).toEqual(newest);
    expect((await store.mismatchesFor(video, 2)).map((row) => row.submitter)).toEqual(newest);
    expect((await store.reportsFor(video, 2)).map((row) => row.submitter)).toEqual(newest);
  });

  it("reads at most 500 rows by default", async () => {
    for (const index of Array.from({ length: 501 }, (_, at) => at)) {
      await store.putMismatch(mismatch({ submitter: index.toString(16).padStart(32, "0") }));
    }

    const rows = await store.mismatchesFor(video);

    expect(rows).toHaveLength(500);
    expect(rows[0]?.submitter).toBe((1).toString(16).padStart(32, "0"));
  });

  it("keeps an older honest pair readable after 600 rows from one origin", async () => {
    const flood = "f".repeat(16);
    const honest = [submitterA, submitterB];

    for (const [index, submitter] of honest.entries()) {
      await store.putFix(fix({ submitter, origin: String(index).repeat(16) }));
    }

    for (const index of Array.from({ length: 600 }, (_, at) => at)) {
      await store.putFix(fix({ submitter: index.toString(16).padStart(32, "0"), origin: flood }));
    }

    const rows = await store.fixesFor(video);

    expect(rows.map((row) => row.submitter)).toEqual(expect.arrayContaining(honest));
    expect(rows.filter((row) => row.origin === flood)).toHaveLength(8);
  });

  it("reads at most 8 newest mismatches and reports per origin, or per submitter without one", async () => {
    const origin = "e".repeat(16);
    const submitters = Array.from({ length: 10 }, (_, at) => at.toString(16).padStart(32, "0"));

    for (const submitter of submitters) {
      await store.putMismatch(mismatch({ submitter, origin }));
      await store.putReport(report({ submitter, origin }));
    }

    for (const index of Array.from({ length: 10 }, (_, at) => at)) {
      await store.putMismatch(
        mismatch({ subtitleHashes: [index.toString(16).padStart(16, "0")], submitter: submitterA }),
      );
    }

    const mismatches = await store.mismatchesFor(video);

    expect(mismatches.filter((row) => row.origin === origin).map((row) => row.submitter)).toEqual(
      submitters.slice(2),
    );
    expect(mismatches.filter((row) => row.origin === undefined)).toHaveLength(8);
    expect((await store.reportsFor(video)).map((row) => row.submitter)).toEqual(
      submitters.slice(2),
    );
  });

  it("keeps the origin of each row and replaces it on a re-put", async () => {
    const origin = "0123456789abcdef";
    const later = "fedcba9876543210";

    await store.putFix(fix({ origin }));
    await store.putMismatch(mismatch({ origin }));
    await store.putReport(report({ origin }));
    await store.putFix(fix({ origin: later }));

    expect((await store.fixesFor(video)).map((row) => row.origin)).toEqual([later]);
    expect((await store.mismatchesFor(video)).map((row) => row.origin)).toEqual([origin]);
    expect((await store.reportsFor(video)).map((row) => row.origin)).toEqual([origin]);
  });

  it("returns a row without an origin as having none", async () => {
    await store.putMismatch(mismatch());

    expect((await store.mismatchesFor(video))[0]?.origin).toBeUndefined();
  });

  it("replaces a submitter's mismatch for the same video and subtitle", async () => {
    await store.putMismatch(mismatch());
    await store.putMismatch(mismatch());
    await store.putMismatch(mismatch({ submitter: submitterB }));

    expect(await store.mismatchesFor(video)).toHaveLength(2);
  });

  it("counts fixes, videos, and videos with fixes or mismatches from two origins", async () => {
    const third = { hash: "00000000000000ff", size: 5 };

    await store.putFix(fix({ origin: "1".repeat(16) }));
    await store.putFix(fix({ submitter: submitterB, origin: "2".repeat(16) }));
    await store.putFix(fix({ video: otherVideo, origin: "1".repeat(16) }));
    await store.putFix(fix({ video: otherVideo, submitter: submitterB, origin: "1".repeat(16) }));
    await store.putFix(fix({ video: otherVideo, submitter: "c".repeat(32) }));
    await store.putMismatch(mismatch({ video: otherVideo, origin: "1".repeat(16) }));
    await store.putMismatch(
      mismatch({ video: otherVideo, submitter: submitterB, origin: "2".repeat(16) }),
    );
    await store.putMismatch(mismatch({ origin: "1".repeat(16) }));
    await store.putMismatch(mismatch({ submitter: submitterB }));
    await store.putReport(report({ video: third }));

    expect(await store.stats()).toEqual({ fixes: 5, confirmed: 1, videos: 3, hidden: 1 });
  });

  it("counts nothing in an empty store", async () => {
    expect(await store.stats()).toEqual({ fixes: 0, confirmed: 0, videos: 0, hidden: 0 });
  });

  it("replaces a submitter's report for the same video and subtitle", async () => {
    await store.putReport(report({ reason: "timing-off" }));
    await store.putReport(report({ reason: "wrong-language" }));

    const rows = await store.reportsFor(video);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "wrong-language" });
  });
};

describe("memoryStore", () => {
  contract(memoryStore);
});

const databaseURL = process.env.DATABASE_URL_TEST;

describe.skipIf(databaseURL === undefined)(
  "postgresStore (needs DATABASE_URL_TEST, skipped when unset)",
  () => {
    if (databaseURL !== undefined && !new URL(databaseURL).pathname.includes("test")) {
      throw new Error('DATABASE_URL_TEST must name a database containing "test"');
    }

    const sql = postgres(databaseURL ?? "", { max: 1, onnotice: () => {} });

    beforeEach(async () => {
      await sql`truncate fixes, mismatches, reports restart identity`;
    });

    afterAll(() => sql.end());

    const store = postgresStore(databaseURL ?? "");

    contract(() => store);

    it("computes the subtitle key the way the database does", async () => {
      const hashes = ["1111111111111111", "2222222222222222", "1111111111111111"];
      const [row] = await sql<{ key: string }[]>`select subtitle_hashes_key(${hashes}) as key`;

      expect(subtitleKey(hashes)).toBe(row?.key);
    });
  },
);
