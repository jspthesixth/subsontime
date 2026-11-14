import { describe, expect, it } from "vitest";
import { dialogueTrack, fastestOfThree } from "../timing/test-tracks.ts";
import { summarize } from "./confirm.ts";
import type { FixRow, MismatchRow, NewFix, ReportRow } from "./db.ts";
import { toFixCues, type CueHash, type FixCue } from "./fingerprint.ts";

const video = { hash: "0123456789abcdef", size: 7_345_678_901 };
const alice = "a".repeat(32);
const bob = "b".repeat(32);
const carol = "c".repeat(32);
const dave = "d".repeat(32);
const referenceOne = "1111111111111111";
const referenceTwo = "2222222222222222";

let clock = Date.UTC(2026, 10, 1);

const nextTime = () => {
  clock += 1000;

  return new Date(clock);
};

const subtitle = (seed: number, count = 40) => toFixCues(dialogueTrack(seed, count));

const shifted = (cues: FixCue[], by: number) =>
  cues.map((cue) => ({ ...cue, s: cue.s + by, e: cue.e + by }));

const hashesOf = (cues: FixCue[]) => cues.map((cue) => cue.h);

const fix = (cues: FixCue[], overrides: Partial<NewFix> = {}): FixRow => ({
  video,
  subtitleHashes: hashesOf(cues),
  cues,
  method: "audio",
  submitter: alice,
  ...overrides,
  createdAt: nextTime(),
});

const mismatch = (subtitleHashes: CueHash[], submitter: string): MismatchRow => ({
  video,
  subtitleHashes,
  submitter,
  createdAt: nextTime(),
});

const report = (
  subtitleHashes: CueHash[],
  submitter: string,
  reason: ReportRow["reason"] = "timing-off",
): ReportRow => ({ video, subtitleHashes, reason, submitter, createdAt: nextTime() });

const fixesOnly = (fixes: FixRow[]) => summarize(fixes, [], []).fixes;

describe("summarize confirmation", () => {
  const cues = subtitle(1);

  it("confirms two agreeing audio fixes from different submitters", () => {
    expect(fixesOnly([fix(cues), fix(shifted(cues, 40), { submitter: bob })])).toEqual([
      {
        subtitleHashes: hashesOf(cues),
        cues: shifted(cues, 20),
        status: "confirmed",
        method: "audio",
        agreeing: 2,
        fromAudio: true,
      },
    ]);
  });

  it("confirms an audio fix agreeing with a reference fix", () => {
    const [view] = fixesOnly([
      fix(cues, { method: "reference", referenceKey: referenceOne }),
      fix(cues, { submitter: bob }),
    ]);

    expect(view).toMatchObject({ status: "confirmed", method: "audio", fromAudio: true });
  });

  it("gives a hint for two reference fixes from the same reference", () => {
    const oldest = fix(cues, { method: "reference", referenceKey: referenceOne });
    const newest = fix(shifted(cues, 30), {
      method: "reference",
      referenceKey: referenceOne,
      submitter: bob,
    });

    expect(fixesOnly([oldest, newest])).toEqual([
      {
        subtitleHashes: newest.subtitleHashes,
        cues: newest.cues,
        status: "hint",
        method: "reference",
        agreeing: 1,
        fromAudio: false,
      },
    ]);
  });

  it("confirms two reference fixes from different references", () => {
    const [view] = fixesOnly([
      fix(cues, { method: "reference", referenceKey: referenceOne }),
      fix(cues, { method: "reference", referenceKey: referenceTwo, submitter: bob }),
    ]);

    expect(view).toMatchObject({ status: "confirmed", method: "reference", fromAudio: false });
  });

  it("confirms a reference fix and a release-name fix from different references", () => {
    const [view] = fixesOnly([
      fix(cues, { method: "reference", referenceKey: referenceOne }),
      fix(cues, { method: "release-name", referenceKey: referenceTwo, submitter: bob }),
    ]);

    expect(view?.status).toBe("confirmed");
  });

  it("gives a hint for two release-name fixes with the same key", () => {
    const [view] = fixesOnly([
      fix(cues, { method: "release-name", referenceKey: referenceOne }),
      fix(cues, { method: "release-name", referenceKey: referenceOne, submitter: bob }),
    ]);

    expect(view?.status).toBe("hint");
  });

  it("gives a hint when only one submitter holds the different references", () => {
    const [view] = fixesOnly([
      fix(cues, { method: "reference", referenceKey: referenceOne }),
      fix(cues.slice(1), { method: "reference", referenceKey: referenceTwo }),
      fix(cues, { method: "release-name", submitter: bob }),
    ]);

    expect(view?.status).toBe("hint");
  });

  it("gives a hint for two audio fixes from one submitter", () => {
    expect(fixesOnly([fix(cues), fix(cues.slice(1))])).toMatchObject([
      { status: "hint", agreeing: 1 },
    ]);
  });

  it("does not let a disagreeing third fix break a confirmed pair", () => {
    const [view, ...rest] = fixesOnly([
      fix(cues),
      fix(cues, { submitter: bob }),
      fix(shifted(cues, 2000), { submitter: carol }),
    ]);

    expect(rest).toEqual([]);
    expect(view).toMatchObject({ status: "confirmed", agreeing: 2, cues });
  });

  it("takes the median of the agreeing fixes and ignores the outlier", () => {
    const [view] = fixesOnly([
      fix(cues),
      fix(shifted(cues, 40), { submitter: bob }),
      fix(shifted(cues, 3000), { submitter: dave }),
      fix(shifted(cues, 80), { submitter: carol }),
    ]);

    expect(view).toMatchObject({ status: "confirmed", agreeing: 3, cues: shifted(cues, 40) });
  });

  it("joins fixes that agree through a third", () => {
    const [view] = fixesOnly([
      fix(cues),
      fix(shifted(cues, 160), { submitter: bob }),
      fix(shifted(cues, 80), { submitter: carol }),
    ]);

    expect(view).toMatchObject({ status: "confirmed", agreeing: 3 });
  });

  it("does not join fixes through two fixes of one submitter", () => {
    const [view] = fixesOnly([
      fix(cues),
      fix(shifted(cues.slice(1), 90)),
      fix(shifted(cues, -60), { submitter: bob }),
      fix(shifted(cues, 160), { submitter: carol }),
    ]);

    expect(view).toMatchObject({ status: "confirmed", agreeing: 2, cues: shifted(cues, -30) });
  });

  it("needs at least 20 shared cues to agree", () => {
    const short = subtitle(2, 19);
    const enough = subtitle(2, 20);

    expect(fixesOnly([fix(short), fix(short, { submitter: bob })])).toMatchObject([
      { status: "hint" },
    ]);
    expect(fixesOnly([fix(enough), fix(enough, { submitter: bob })])).toMatchObject([
      { status: "confirmed" },
    ]);
  });

  it("needs 80 % of the shared cues within 100 ms", () => {
    const offBy = (count: number) =>
      cues.map((cue, index) => (index < count ? { ...cue, e: cue.e + 101 } : cue));

    expect(fixesOnly([fix(cues), fix(offBy(8), { submitter: bob })])[0]?.status).toBe("confirmed");
    expect(fixesOnly([fix(cues), fix(offBy(9), { submitter: bob })])[0]?.status).toBe("hint");
  });

  it("leaves out a line that repeats in any agreeing fix", () => {
    const [first, second, ...others] = cues;
    const repeated = [
      ...(first === undefined ? [] : [first]),
      ...(second === undefined || first === undefined ? [] : [{ ...second, h: first.h }]),
      ...others,
    ];
    const [view] = fixesOnly([fix(cues), fix(repeated, { submitter: bob })]);

    expect(view?.status).toBe("confirmed");
    expect(hashesOf(view?.cues ?? [])).toEqual(hashesOf(cues).slice(1));
  });

  it.each([21, 22, 23])("groups ten lines with any one missing (seed %i)", (seed) => {
    const ten = subtitle(seed, 10);

    ten.forEach((_, missing) => {
      const nine = ten.toSpliced(missing, 1);

      expect(fixesOnly([fix(ten), fix(nine, { submitter: bob })])).toHaveLength(1);
    });
    expect(fixesOnly([fix(ten), fix(ten.slice(2), { submitter: bob })])).toHaveLength(2);
  });

  it("keeps fixes for different subtitles apart", () => {
    const other = subtitle(3);

    expect(fixesOnly([fix(cues), fix(other, { submitter: bob })])).toMatchObject([
      { status: "hint", subtitleHashes: hashesOf(other) },
      { status: "hint", subtitleHashes: hashesOf(cues) },
    ]);
  });
});

describe("summarize hiding", () => {
  const cues = subtitle(4);
  const other = subtitle(5);
  const fixes = [fix(cues), fix(other, { submitter: bob })];
  const nearlyCues = hashesOf(cues).slice(2);

  it("hides a mismatch only for its submitter", () => {
    const mismatches = [mismatch(nearlyCues, carol)];
    const forCarol = summarize(fixes, mismatches, [], carol);

    expect(summarize(fixes, mismatches, [])).toEqual(summarize(fixes, [], []));
    expect(forCarol.hidden).toEqual([{ subtitleHashes: nearlyCues, reason: "mismatch", count: 1 }]);
    expect(forCarol.fixes.map((view) => view.subtitleHashes)).toEqual([hashesOf(other)]);
  });

  it("hides a subtitle for everyone after mismatches from two submitters", () => {
    const timings = summarize(
      fixes,
      [mismatch(nearlyCues, carol), mismatch(hashesOf(cues), dave)],
      [],
    );

    expect(timings.hidden).toEqual([
      { subtitleHashes: hashesOf(cues), reason: "mismatch", count: 2 },
    ]);
    expect(timings.fixes.map((view) => view.subtitleHashes)).toEqual([hashesOf(other)]);
  });

  it("hides a subtitle nobody fixed after mismatches from two submitters", () => {
    const hashes = hashesOf(subtitle(6));

    expect(summarize([], [mismatch(hashes, carol), mismatch(hashes, dave)], []).hidden).toEqual([
      { subtitleHashes: hashes, reason: "mismatch", count: 2 },
    ]);
  });

  it("counts a one-line list and its repeat as one subtitle", () => {
    const [line = ""] = hashesOf(cues);

    expect(summarize([], [mismatch([line], carol), mismatch([line, line], dave)], [])).toEqual({
      fixes: [],
      hidden: [{ subtitleHashes: [line, line], reason: "mismatch", count: 2 }],
    });
  });

  it("does not hide for everyone after two mismatches from one submitter", () => {
    const mismatches = [mismatch(hashesOf(cues), carol), mismatch(nearlyCues, carol)];

    expect(summarize(fixes, mismatches, [])).toEqual(summarize(fixes, [], []));
  });

  it("hides a subtitle after three reports with one reason", () => {
    const reports = [
      report(hashesOf(cues), carol),
      report(nearlyCues, dave),
      report(hashesOf(cues), bob),
    ];

    const timings = summarize(fixes, [], reports);

    expect(summarize(fixes, [], reports.slice(0, 2))).toEqual(summarize(fixes, [], []));
    expect(timings.hidden).toEqual([
      { subtitleHashes: hashesOf(cues), reason: "timing-off", count: 3 },
    ]);
    expect(timings.fixes.map((view) => view.subtitleHashes)).toEqual([hashesOf(other)]);
  });

  it("keeps a subtitle visible after three reports with different reasons", () => {
    const reports = [
      report(hashesOf(cues), carol, "timing-off"),
      report(hashesOf(cues), dave, "wrong-language"),
      report(hashesOf(cues), bob, "machine-translated"),
    ];

    expect(summarize(fixes, [], reports).hidden).toEqual([]);
  });

  it("keeps a subtitle visible after three reports from one submitter", () => {
    const reports = [
      report(hashesOf(cues), carol),
      report(nearlyCues, carol),
      report(hashesOf(cues).slice(1), carol),
    ];

    expect(summarize(fixes, [], reports).hidden).toEqual([]);
  });
});

describe("summarize limits", () => {
  it("returns 20 views, confirmed first, then by agreement, then newest, with cues for 5 hints", () => {
    const pair = subtitle(10);
    const trio = subtitle(11);
    const hints = Array.from({ length: 25 }, (_, index) =>
      fix(subtitle(100 + index, 25), { submitter: index.toString(16).padStart(32, "0") }),
    );
    const views = fixesOnly([
      fix(pair),
      fix(pair, { submitter: bob }),
      fix(trio),
      fix(trio, { submitter: bob }),
      fix(trio, { submitter: carol }),
      ...hints,
    ]);
    const newestHints = hints.toReversed().slice(0, 18);

    expect(views).toHaveLength(20);
    expect(views.slice(0, 2)).toMatchObject([
      { status: "confirmed", agreeing: 3, cues: trio },
      { status: "confirmed", agreeing: 2, cues: pair },
    ]);
    expect(views.slice(2).map((view) => view.subtitleHashes)).toEqual(
      newestHints.map((row) => row.subtitleHashes),
    );
    expect(views.slice(2, 7).map((view) => view.cues)).toEqual(
      newestHints.slice(0, 5).map((row) => row.cues),
    );
    expect(views.slice(7)).toEqual(
      newestHints.slice(5).map((row) => ({
        subtitleHashes: row.subtitleHashes,
        cues: [],
        cuesOmitted: true,
        status: "hint",
        method: "audio",
        agreeing: 1,
        fromAudio: true,
      })),
    );
  });

  it("keeps the response for 60 large fixes from 60 submitters under 2 MB", () => {
    const fixes = Array.from({ length: 60 }, (_, index) =>
      fix(subtitle(1000 + index, 2000), { submitter: index.toString(16).padStart(32, "0") }),
    );
    const body = JSON.stringify(summarize(fixes, [], []));

    expect(Buffer.byteLength(body)).toBeLessThan(2 * 1024 * 1024);
  });

  it("summarizes 500 fixes of 2000 cues in under 300 ms", async () => {
    const cues = subtitle(7, 2000);
    const fixes = Array.from({ length: 500 }, (_, index) =>
      fix(index % 10 === 0 ? shifted(cues, 1000 + index * 250) : shifted(cues, index % 50), {
        submitter: index.toString(16).padStart(32, "0"),
      }),
    );
    const views = fixesOnly(fixes);

    expect(views).toMatchObject([{ status: "confirmed", agreeing: 450 }]);
    expect(await fastestOfThree(() => fixesOnly(fixes))).toBeLessThan(300);
  });
});
