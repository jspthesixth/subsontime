import { afterAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { memoryStore, postgresStore } from "./db.ts";
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

  it("replaces a submitter's mismatch for the same video and subtitle", async () => {
    await store.putMismatch(mismatch());
    await store.putMismatch(mismatch());
    await store.putMismatch(mismatch({ submitter: submitterB }));

    expect(await store.mismatchesFor(video)).toHaveLength(2);
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
  },
);
