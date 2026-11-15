import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Candidate } from "../sources/source.ts";
import type { Cue } from "../subtitles/cue.ts";
import { parseRelease } from "../subtitles/release.ts";
import { alignCues, alignOffset } from "./alass.ts";
import { pickReferences } from "./references.ts";
import { mismatchMaximumScore, retime, retimedMinimumScore } from "./retime.ts";
import { byHash, candidate, fileRelease, subtitleOf } from "./test-candidates.ts";
import { resegment, syntheticTrack, transform } from "./test-tracks.ts";

const byReleaseName = (cues: Cue[], fps?: number) => ({
  candidate: candidate({ ref: "reference", fps }),
  cues,
});

const track = syntheticTrack(1, 200);
const nudged = transform(track, (time) => time + 100);
const shifted = transform(resegment(track, 7), (time) => time + 2000);
const outlier = transform(track, (time) => time + 5000);
const weakOutlier = transform(
  track.filter((_, index) => index % 10 !== 0),
  (time) => time + 5000,
);
const unrelated = syntheticTrack(2, 200);
const differentCut = transform(
  resegment(track, 7),
  (time, cue) => time + 2000 + (cue.origin >= 100 ? 90_000 : 0),
);
const withSilence = [
  ...track.slice(0, 100),
  ...transform(track.slice(100), (time) => time + 60_000),
];

const cuesOf = (spans: number[][]) =>
  spans.map(([start = 0, end = 0]) => ({ start, end, text: "" }));

const actBreaks = (() => {
  const { subtitle, reference } = JSON.parse(
    readFileSync(new URL("../../test/fixtures/subtitles/act-breaks.json", import.meta.url), "utf8"),
  ) as { subtitle: number[][]; reference: number[][] };

  return { subtitle: cuesOf(subtitle), reference: cuesOf(reference) };
})();

const filmRate = 24 / 23.976;

const steppedAt = (index: number) => (index >= 70 ? 800 : 0) + (index >= 140 ? 800 : 0);

const sloped = track.map((cue, index) => ({
  ...cue,
  start: cue.start * filmRate - steppedAt(index),
  end: cue.end * filmRate - steppedAt(index),
}));

const shareWithin = (cues: Cue[], expected: Cue[], ms: number) =>
  expected.filter((cue, index) => Math.abs((cues[index]?.start ?? 0) - cue.start) <= ms).length /
  expected.length;

const largestStartError = (cues: Cue[]) =>
  Math.max(...cues.map((cue, index) => Math.abs(cue.start - (track[index]?.start ?? Infinity))));

const partlyUnrelated = (() => {
  const kept = Math.round(track.length / 2);
  const head = resegment(resegment(track.slice(0, kept), 7), 8);
  const tail = transform(
    syntheticTrack(9, track.length - kept),
    (time) => time + (head.at(-1)?.end ?? 0),
  );

  return transform([...head, ...tail], (time) => time + 2000);
})();

describe("retime", () => {
  it("returns a hash-matched subtitle untouched as made for the file", async () => {
    const subtitle = { candidate: candidate({ hashMatch: true }), cues: shifted };

    const result = await retime(subtitle, [byHash(track)]);

    expect(result).toEqual({ kind: "made-for-file", cues: shifted });
    expect(result.kind === "made-for-file" && result.cues).toBe(shifted);
  });

  it("slows a 25 fps subtitle down to a 23.976 fps reference", async () => {
    const pal = transform(track, (time) => (time * 23.976) / 25 + 2000);

    const result = await retime(subtitleOf(pal, 25), [byHash(track, 23.976)]);

    expect(result).toMatchObject({ kind: "retimed", speedRatio: 23.976 / 25 });
    expect(result.kind === "retimed" && largestStartError(result.cues)).toBeLessThanOrEqual(10);
  });

  it("speeds a 23.976 fps subtitle up to a 25 fps reference", async () => {
    const film = transform(track, (time) => (time * 25) / 23.976 + 2000);

    const result = await retime(subtitleOf(film, 23.976), [byHash(track, 25)]);

    expect(result).toMatchObject({ kind: "retimed", speedRatio: 25 / 23.976 });
    expect(result.kind === "retimed" && largestStartError(result.cues)).toBeLessThanOrEqual(10);
  });

  it("falls back to the speed search when the frame rate tag is wrong", async () => {
    const result = await retime(subtitleOf(shifted, 25), [byHash(track, 23.976)]);

    expect(result).toMatchObject({ kind: "retimed", speedRatio: 1 });
  });

  it("uses a frame rate ratio that no speed search would try", async () => {
    const scaled = transform(resegment(track, 7), (time) => (time * 25) / 30 + 2000);

    const result = await retime(subtitleOf(scaled, 30), [byHash(track, 25)]);

    expect(result).toMatchObject({ kind: "retimed", speedRatio: 25 / 30 });
  });

  it("retimes against two hash references that agree", async () => {
    const result = await retime(subtitleOf(shifted), [byHash(track), byHash(nudged)]);

    expect(result).toMatchObject({ kind: "retimed", byReleaseName: false, speedRatio: 1 });
    expect(result.kind === "retimed" && Math.abs(result.offsetMs + 2000)).toBeLessThanOrEqual(150);
    expect(result.kind === "retimed" && result.score).toBeGreaterThanOrEqual(retimedMinimumScore);
    expect(result.kind === "retimed" && result.score).toBeLessThan(0.85);
  });

  it("follows the two references that agree over one 5 s off", async () => {
    const result = await retime(subtitleOf(shifted), [
      byHash(outlier),
      byHash(track),
      byHash(nudged),
    ]);

    expect(result.kind === "retimed" && Math.abs(result.offsetMs + 2000)).toBeLessThanOrEqual(150);
  });

  it("follows the higher-scoring reference when two references disagree", async () => {
    const result = await retime(subtitleOf(shifted), [byHash(weakOutlier), byHash(track)]);

    expect(result.kind === "retimed" && Math.abs(result.offsetMs + 2000)).toBeLessThanOrEqual(150);
  });

  it("measures offset and cuts on the speed-scaled times", async () => {
    const scaled = transform(resegment(withSilence, 7), (time) => ((time + 2000) * 23.976) / 25);

    const result = await retime(subtitleOf(scaled, 25), [byHash(withSilence, 23.976)]);

    expect(result).toMatchObject({ kind: "retimed", cuts: 0 });
    expect(result.kind === "retimed" && Math.abs(result.offsetMs + 2000)).toBeLessThanOrEqual(150);
  });

  it("ignores a reference that is the subtitle itself", async () => {
    const self = (sourceName: string) => ({
      candidate: candidate({ sourceName, ref: "subtitle" }),
      cues: shifted,
    });

    expect(await retime(subtitleOf(shifted), [self("test")])).toEqual({
      kind: "not-retimed",
      cues: shifted,
    });
    expect(await retime(subtitleOf(shifted), [self("other")])).toMatchObject({
      kind: "retimed",
      offsetMs: 0,
    });
  });

  it("stops at the first hash reference that fits well", async () => {
    const exact = transform(track, (time) => time + 2000);

    const result = await retime(subtitleOf(exact), [
      byHash(track),
      byHash(outlier),
      byHash(outlier),
    ]);

    expect(result).toMatchObject({ kind: "retimed", offsetMs: -2000, cuts: 0 });
  });

  it("marks a result built on release-name references", async () => {
    const result = await retime(subtitleOf(shifted), [byReleaseName(track)]);

    expect(result).toMatchObject({ kind: "retimed", byReleaseName: true });
  });

  it("reports a mismatch when every hash reference is unrelated", async () => {
    const offset = alignOffset(track, unrelated);
    const split = await alignCues(track, unrelated);

    expect(offset.score).toBeLessThan(mismatchMaximumScore);
    expect(split.score).toBeGreaterThanOrEqual(mismatchMaximumScore);
    expect(split.score).toBeLessThan(retimedMinimumScore);
    expect(await retime(subtitleOf(unrelated, 25), [byHash(track, 25)])).toEqual({
      kind: "mismatch",
    });
  });

  it("retimes a different cut that only the split alignment fits", async () => {
    const offset = alignOffset(track, differentCut);
    const split = await alignCues(track, differentCut);

    expect(offset.score).toBeGreaterThanOrEqual(mismatchMaximumScore);
    expect(offset.score).toBeLessThan(retimedMinimumScore);
    expect(split.score).toBeGreaterThanOrEqual(retimedMinimumScore);
    expect(await retime(subtitleOf(differentCut, 25), [byHash(track, 25)])).toMatchObject({
      kind: "retimed",
      cuts: 1,
    });
  });

  it("never reports a mismatch from a release-name reference", async () => {
    expect(alignOffset(track, unrelated).score).toBeLessThan(mismatchMaximumScore);
    expect(await retime(subtitleOf(unrelated, 25), [byReleaseName(track, 25)])).toEqual({
      kind: "not-retimed",
      cues: unrelated,
    });
  });

  it("does not retime against a hash reference that only partly fits", async () => {
    const offset = alignOffset(track, partlyUnrelated);
    const split = await alignCues(track, partlyUnrelated);

    expect(offset.score).toBeGreaterThanOrEqual(mismatchMaximumScore);
    expect(Math.max(offset.score, split.score)).toBeLessThan(retimedMinimumScore);
    expect(await retime(subtitleOf(partlyUnrelated, 25), [byHash(track, 25)])).toEqual({
      kind: "not-retimed",
      cues: partlyUnrelated,
    });
  });

  it("follows act-break steps instead of a slope", async () => {
    const { subtitle, reference } = actBreaks;

    const result = await retime(subtitleOf(subtitle), [byHash(reference)]);

    const cues = result.kind === "retimed" ? result.cues : [];

    expect(result).toMatchObject({ kind: "retimed", speedRatio: 1 });
    expect(shareWithin(cues, reference.slice(0, -1), 100)).toBeGreaterThan(0.75);
  });

  it("keeps a true film-rate slope under act-break steps", async () => {
    const result = await retime(subtitleOf(sloped), [byHash(track)]);

    const cues = result.kind === "retimed" ? result.cues : [];

    expect(result).toMatchObject({ kind: "retimed", speedRatio: filmRate });
    expect(shareWithin(cues, track, 100)).toBeGreaterThan(0.9);
  });

  it("does not retime without references", async () => {
    expect(await retime(subtitleOf(shifted), [])).toEqual({ kind: "not-retimed", cues: shifted });
  });
});

const sameRelease = (ref: string) => candidate({ ref });

const otherRelease = (ref: string) =>
  candidate({ ref, release: parseRelease("Movie.2024.720p.WEB-DL-OTHER") });

const hashMatch = (ref: string, lang: string) =>
  candidate({ ref, lang, hashMatch: true, release: parseRelease("Movie.2024.720p.HDTV-X") });

const refs = (candidates: Candidate[]) => candidates.map((picked) => picked.ref);

describe("pickReferences", () => {
  it("takes up to three hash matches in any language, in input order", () => {
    const candidates = [
      sameRelease("a"),
      hashMatch("b", "hrv"),
      otherRelease("c"),
      hashMatch("d", "eng"),
      hashMatch("e", "spa"),
      hashMatch("f", "fre"),
    ];

    expect(refs(pickReferences(candidates, fileRelease))).toEqual(["b", "d", "e"]);
  });

  it("falls back to up to three same-release candidates without a hash match", () => {
    const candidates = [
      otherRelease("a"),
      sameRelease("b"),
      sameRelease("c"),
      otherRelease("d"),
      sameRelease("e"),
      sameRelease("f"),
    ];

    expect(refs(pickReferences(candidates, fileRelease))).toEqual(["b", "c", "e"]);
  });

  it("spends no quota on a reference while a free hash match exists", () => {
    const candidates = [
      { ...hashMatch("a", "hrv"), metered: true },
      hashMatch("b", "eng"),
      hashMatch("c", "spa"),
    ];

    expect(refs(pickReferences(candidates, fileRelease))).toEqual(["b", "c"]);
  });

  it("takes a metered hash match when nothing free matches", () => {
    const candidates = [{ ...hashMatch("a", "hrv"), metered: true }, sameRelease("b")];

    expect(refs(pickReferences(candidates, fileRelease))).toEqual(["a"]);
  });

  it("picks nothing when no candidate matches", () => {
    expect(pickReferences([otherRelease("a")], fileRelease)).toEqual([]);
  });

  it("falls back to the release family in any language without a hash match", () => {
    const family = { source: "dvdrip" as const, group: "clerks" };
    const candidates = [
      otherRelease("a"),
      candidate({ ref: "b", lang: "hrv", release: parseRelease("Show.S01E24.DVDRip.XviD-clerks") }),
      candidate({ ref: "c", release: parseRelease("Show.S01E24.DVDRip.XviD-CLERKS") }),
    ];

    expect(refs(pickReferences(candidates, fileRelease, family))).toEqual(["b", "c"]);
  });

  it("prefers a hash match over the release family", () => {
    const family = { source: "dvdrip" as const, group: "clerks" };
    const candidates = [
      candidate({ ref: "b", release: parseRelease("Show.S01E24.DVDRip.XviD-clerks") }),
      hashMatch("h", "eng"),
    ];

    expect(refs(pickReferences(candidates, fileRelease, family))).toEqual(["h"]);
  });
});
