import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dialogueTrack, fastestOfThree } from "../timing/test-tracks.ts";
import { digest, present, publicTimings, summarize, type Digest } from "./confirm.ts";
import { subtitleKey, type FixRow, type MismatchRow, type NewFix, type ReportRow } from "./db.ts";
import { subtitleSketch, toFixCues, type CueHash, type FixCue } from "./fingerprint.ts";

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

const originOf = (submitter: string) => submitter.slice(-16);

const submitterAt = (index: number) => index.toString(16).padStart(32, "0");

const idOf = (cues: FixCue[]) => subtitleKey(hashesOf(cues));

const hashLike = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

const fix = (cues: FixCue[], overrides: Partial<NewFix> = {}): FixRow => ({
  video,
  subtitleHashes: hashesOf(cues),
  cues,
  method: "audio",
  submitter: alice,
  origin: originOf(overrides.submitter ?? alice),
  ...overrides,
  createdAt: nextTime(),
});

const mismatch = (
  subtitleHashes: CueHash[],
  submitter: string,
  origin = originOf(submitter),
): MismatchRow => ({ video, subtitleHashes, submitter, origin, createdAt: nextTime() });

const report = (
  subtitleHashes: CueHash[],
  submitter: string,
  reason: ReportRow["reason"] = "timing-off",
  origin = originOf(submitter),
): ReportRow => ({ video, subtitleHashes, reason, submitter, origin, createdAt: nextTime() });

const listed = (sections: Digest) => sections.filter((section) => section.fixView).length;

const fixesOnly = (fixes: FixRow[]) => summarize(fixes, [], []).fixes;

describe("summarize confirmation", () => {
  const cues = subtitle(1);

  it("confirms two agreeing audio fixes from different submitters", () => {
    expect(fixesOnly([fix(cues), fix(shifted(cues, 40), { submitter: bob })])).toEqual([
      {
        id: idOf(cues),
        subtitleSketch: subtitleSketch(hashesOf(cues)),
        cues: shifted(cues, 20),
        cueCount: 40,
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
        id: idOf(cues),
        subtitleSketch: subtitleSketch(hashesOf(cues)),
        cues: newest.cues,
        cueCount: 40,
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

  it("gives a hint when the different references come from one origin", () => {
    const [view] = fixesOnly([
      fix(cues, { method: "reference", referenceKey: referenceOne }),
      fix(cues, {
        method: "reference",
        referenceKey: referenceTwo,
        submitter: bob,
        origin: originOf(alice),
      }),
      fix(cues, { method: "release-name", submitter: carol }),
    ]);

    expect(view?.status).toBe("hint");
  });

  it("gives a hint for two submitters from one origin", () => {
    expect(
      fixesOnly([fix(cues), fix(cues, { submitter: bob, origin: originOf(alice) })]),
    ).toMatchObject([{ status: "hint" }]);
  });

  it("gives a hint for two submitters without an origin", () => {
    expect(
      fixesOnly([
        fix(cues, { origin: undefined }),
        fix(cues, { submitter: bob, origin: undefined }),
      ]),
    ).toMatchObject([{ status: "hint" }]);
  });

  it("prefers two origins agreeing over many submitters from one origin", () => {
    const [view] = fixesOnly([
      fix(cues),
      fix(cues, { submitter: bob, origin: originOf(alice) }),
      fix(cues, { submitter: carol, origin: originOf(alice) }),
      fix(shifted(cues, 2000), { submitter: dave }),
      fix(shifted(cues, 2000), { submitter: submitterAt(1) }),
    ]);

    expect(view).toMatchObject({ status: "confirmed", agreeing: 2, cues: shifted(cues, 2000) });
  });

  it("does not let one origin chain fixes away from an honest one", () => {
    const sybils = Array.from({ length: 49 }, (_, index) =>
      fix(shifted(cues, (index + 1) * 95), {
        submitter: submitterAt(index + 1),
        origin: originOf(bob),
      }),
    );

    expect(fixesOnly([fix(cues), ...sybils])).toMatchObject([{ status: "hint", agreeing: 1 }]);
  });

  it("keeps an honest confirmed pair when one origin sends 50 more fixes", () => {
    const pair = [fix(cues), fix(cues, { submitter: bob })];
    const flood = Array.from({ length: 50 }, (_, index) =>
      fix(shifted(cues, 3000 + index * 250), {
        submitter: submitterAt(index + 1),
        origin: originOf(carol),
      }),
    );

    expect(fixesOnly([...pair, ...flood])).toMatchObject([
      { status: "confirmed", agreeing: 2, cues },
    ]);
  });

  it("counts agreeing by origin", () => {
    const [view] = fixesOnly([
      fix(cues),
      fix(cues.slice(1), { origin: originOf(dave) }),
      fix(cues, { submitter: bob }),
    ]);

    expect(view).toMatchObject({ status: "confirmed", agreeing: 3 });
  });

  it("keeps honest fixes together when an older row sends hashes that sort first", () => {
    const long = subtitle(12, 2000);
    const lowered = long.map((cue, at) =>
      at < 100 ? { ...cue, h: at.toString(16).padStart(16, "0") } : cue,
    );

    expect(
      fixesOnly([fix(lowered, { submitter: dave }), fix(long), fix(long, { submitter: bob })]),
    ).toMatchObject([{ status: "confirmed", agreeing: 2, id: idOf(long) }, { status: "hint" }]);
  });

  it("weighs only the 50 newest fixes of a subtitle", () => {
    const [view] = fixesOnly(
      Array.from({ length: 60 }, (_, index) => fix(cues, { submitter: submitterAt(index) })),
    );

    expect(view).toMatchObject({ status: "confirmed", agreeing: 50 });
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

  it("weighs only the newest fix of each origin", () => {
    const [view] = fixesOnly([
      fix(cues),
      fix(cues, { submitter: bob }),
      fix(shifted(cues.slice(1), 3000)),
    ]);

    expect(view).toMatchObject({ status: "hint", agreeing: 1 });
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
      { status: "hint", id: idOf(other) },
      { status: "hint", id: idOf(cues) },
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
    expect(forCarol.hidden).toEqual([
      { subtitleSketch: subtitleSketch(nearlyCues), reason: "mismatch", count: 1 },
    ]);
    expect(forCarol.fixes.map((view) => view.id)).toEqual([idOf(other)]);
  });

  it("hides a subtitle for everyone after mismatches from two submitters", () => {
    const timings = summarize(
      fixes,
      [mismatch(nearlyCues, carol), mismatch(hashesOf(cues), dave)],
      [],
    );

    expect(timings.hidden).toEqual([
      { subtitleSketch: subtitleSketch(hashesOf(cues)), reason: "mismatch", count: 2 },
    ]);
    expect(timings.fixes.map((view) => view.id)).toEqual([idOf(other)]);
  });

  it("does not hide for everyone after mismatches from two submitters of one origin", () => {
    const mismatches = [
      mismatch(nearlyCues, carol),
      mismatch(hashesOf(cues), dave, originOf(carol)),
    ];

    expect(summarize(fixes, mismatches, [])).toEqual(summarize(fixes, [], []));
    expect(summarize(fixes, mismatches, [], dave).hidden).toMatchObject([{ reason: "mismatch" }]);
  });

  it("hides a subtitle nobody fixed after mismatches from two submitters", () => {
    const hashes = hashesOf(subtitle(6));

    expect(summarize([], [mismatch(hashes, carol), mismatch(hashes, dave)], []).hidden).toEqual([
      { subtitleSketch: subtitleSketch(hashes), reason: "mismatch", count: 2 },
    ]);
  });

  it("counts a one-line list and its repeat as one subtitle", () => {
    const [line = ""] = hashesOf(cues);

    expect(summarize([], [mismatch([line], carol), mismatch([line, line], dave)], [])).toEqual({
      fixes: [],
      hidden: [{ subtitleSketch: [line], reason: "mismatch", count: 2 }],
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
      { subtitleSketch: subtitleSketch(hashesOf(cues)), reason: "timing-off", count: 3 },
    ]);
    expect(timings.fixes.map((view) => view.id)).toEqual([idOf(other)]);
  });

  it("keeps a subtitle visible after three reports from one origin", () => {
    const reports = [
      report(hashesOf(cues), carol),
      report(nearlyCues, dave, "timing-off", originOf(carol)),
      report(hashesOf(cues), bob, "timing-off", originOf(carol)),
    ];

    expect(summarize(fixes, [], reports).hidden).toEqual([]);
  });

  it("keeps a subtitle visible after three reports from two origins", () => {
    const reports = [
      report(hashesOf(cues), carol),
      report(nearlyCues, dave, "timing-off", originOf(carol)),
      report(hashesOf(cues), bob),
    ];

    expect(summarize(fixes, [], reports).hidden).toEqual([]);
  });

  it("counts hiding submitters by origin", () => {
    const mismatches = [
      mismatch(nearlyCues, carol),
      mismatch(nearlyCues.slice(1), dave, originOf(carol)),
      mismatch(hashesOf(cues), bob),
    ];

    expect(summarize(fixes, mismatches, []).hidden).toMatchObject([{ count: 2 }]);
  });

  it("lists at most 50 hidden subtitles and keeps the viewer's own", () => {
    const own = mismatch(hashesOf(subtitle(300, 5)), carol);
    const hidden = Array.from({ length: 60 }, (_, index) =>
      hashesOf(subtitle(400 + index, 5)),
    ).flatMap((hashes, index) => [
      mismatch(hashes, submitterAt(2 * index + 1)),
      mismatch(hashes, submitterAt(2 * index + 2)),
    ]);
    const timings = summarize([], [own, ...hidden], [], carol);

    expect(timings.hidden).toHaveLength(50);
    expect(timings.hidden).toContainEqual({
      subtitleSketch: subtitleSketch(own.subtitleHashes),
      reason: "mismatch",
      count: 1,
    });
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
  it("returns 20 views, confirmed first, then by agreement, then newest", () => {
    const pair = subtitle(10);
    const trio = subtitle(11);
    const hints = Array.from({ length: 25 }, (_, index) =>
      fix(subtitle(100 + index, 25), { submitter: submitterAt(index) }),
    );
    const views = fixesOnly([
      fix(pair),
      fix(pair, { submitter: bob }),
      fix(trio),
      fix(trio, { submitter: bob }),
      fix(trio, { submitter: carol }),
      ...hints,
    ]);

    expect(views).toHaveLength(20);
    expect(views.slice(0, 2)).toMatchObject([
      { status: "confirmed", agreeing: 3, cues: trio },
      { status: "confirmed", agreeing: 2, cues: pair },
    ]);
    expect(views.slice(2).map((view) => view.id)).toEqual(
      hints
        .toReversed()
        .slice(0, 18)
        .map((row) => idOf(row.cues)),
    );
  });

  it("keeps cues only for the groups that can be listed", () => {
    const hints = Array.from({ length: 30 }, (_, index) =>
      fix(subtitle(600 + index, 25), { submitter: submitterAt(index) }),
    );
    const newest = hints.at(-1);
    const withMismatch = digest(hints, [mismatch(newest?.subtitleHashes ?? [], carol)], []);

    expect(listed(digest(hints, [], []))).toBe(20);
    expect(listed(withMismatch)).toBe(21);
    expect(present(withMismatch, carol).fixes.map((view) => view.id)).toEqual(
      hints
        .slice(0, -1)
        .toReversed()
        .slice(0, 20)
        .map((row) => idOf(row.cues)),
    );
  });

  it("keeps the public response for 60 subtitles of 5000 lines from 60 submitters under 200 KB", () => {
    const fixes = Array.from({ length: 60 }, (_, index) =>
      fix(subtitle(1000 + index, 5000), { submitter: submitterAt(index) }),
    );
    const timings = publicTimings(summarize(fixes, [], []));

    expect(timings.fixes).toHaveLength(20);
    expect(timings.fixes[0]).toEqual({
      id: idOf(fixes[59]?.cues ?? []),
      subtitleSketch: subtitleSketch(fixes[59]?.subtitleHashes ?? []),
      status: "hint",
      method: "audio",
      agreeing: 1,
      fromAudio: true,
      cueCount: fixes[59]?.cues.length,
    });
    expect(Buffer.byteLength(JSON.stringify(timings))).toBeLessThan(200 * 1024);
  });

  it("summarizes 500 fixes of 2000 cues in under 300 ms", async () => {
    const cues = subtitle(7, 2000);
    const fixes = Array.from({ length: 500 }, (_, index) =>
      fix(index % 10 === 0 ? shifted(cues, 1000 + index * 250) : shifted(cues, index % 50), {
        submitter: submitterAt(index),
      }),
    );

    expect(fixesOnly(fixes)).toMatchObject([{ status: "confirmed", agreeing: 45 }]);
    expect(await fastestOfThree(() => fixesOnly(fixes))).toBeLessThan(300);
  });

  it("summarizes 500 crafted near-identical rows of 2000 lines in under 500 ms", async () => {
    const cues = subtitle(8, 2000);
    const fixes = Array.from({ length: 500 }, (_, index) => {
      const edited = cues.map((cue, at) =>
        at % 20 === index % 20 ? { ...cue, h: hashLike(`${index}-${at}`) } : cue,
      );

      return fix(shifted(index === 0 ? cues : edited, index * 150), {
        submitter: submitterAt(index),
      });
    });

    expect(digest(fixes, [], [])).toHaveLength(20);
    expect(await fastestOfThree(() => fixesOnly(fixes))).toBeLessThan(500);
  });
});

describe("summarize grouping bounds", () => {
  const base = subtitle(9, 2000);
  const edited = (index: number, edit: (at: number) => boolean) =>
    base.map((cue, at) => (edit(at) ? { ...cue, h: hashLike(`${index}-${at}`) } : cue));

  it("summarizes 500 rows about 0.82 similar to each other in under 500 ms", async () => {
    const fixes = Array.from({ length: 500 }, (_, index) =>
      fix(
        shifted(
          edited(index, (at) => at < 200),
          index * 150,
        ),
        {
          submitter: submitterAt(index),
        },
      ),
    );

    expect(fixesOnly(fixes)).toHaveLength(20);
    expect(await fastestOfThree(() => fixesOnly(fixes))).toBeLessThan(500);
  });

  it("keeps 64 groups of 500 different subtitles from 500 origins in under 500 ms", async () => {
    const fixes = Array.from({ length: 500 }, (_, index) =>
      fix(
        edited(index, () => true),
        { submitter: submitterAt(index) },
      ),
    );

    expect(digest(fixes, [], [])).toHaveLength(64);
    expect(await fastestOfThree(() => digest(fixes, [], []))).toBeLessThan(500);
  });

  it("lets one origin start at most 8 groups", () => {
    const fixes = Array.from({ length: 20 }, (_, index) =>
      fix(subtitle(700 + index, 30), { submitter: submitterAt(index), origin: originOf(carol) }),
    );

    expect(digest(fixes, [], [])).toHaveLength(8);
  });

  it("lets a ninth subtitle from one origin join a group another origin started", () => {
    const shared = subtitle(900, 30);
    const ninth = fix(shared, { origin: originOf(carol) });
    const other = fix(shared, { submitter: bob });
    const own = Array.from({ length: 8 }, (_, index) =>
      fix(subtitle(800 + index, 30), { submitter: submitterAt(index), origin: originOf(carol) }),
    );
    const sections = digest([ninth, other, ...own], [], []);

    expect(sections).toHaveLength(9);
    expect(sections.find((section) => section.fixView?.view.id === idOf(shared))).toMatchObject({
      fixView: { view: { status: "confirmed", agreeing: 2 } },
    });
    expect(digest([ninth, ...own], [], [])).toHaveLength(8);
  });

  it("still confirms an honest pair next to 60 skewed rows from one origin", () => {
    const pair = [fix(base), fix(base, { submitter: bob })];
    const skewed = Array.from({ length: 60 }, (_, index) =>
      fix(
        base.map((cue, at) =>
          at < 100 ? { ...cue, h: (index * 100 + at).toString(16).padStart(16, "0") } : cue,
        ),
        { submitter: submitterAt(index), origin: originOf(carol) },
      ),
    );

    expect(fixesOnly([...pair, ...skewed])).toContainEqual(
      expect.objectContaining({ status: "confirmed", agreeing: 2, id: idOf(base) }),
    );
  });
});
