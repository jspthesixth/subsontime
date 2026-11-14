import { describe, expect, it } from "vitest";
import type { Candidate } from "../sources/source.ts";
import type { Cue } from "../subtitles/cue.ts";
import { parseRelease } from "../subtitles/release.ts";
import { alignCues, alignOffset, speedRatioFromFPS } from "./alass.ts";
import { pickReferences } from "./references.ts";
import { mismatchMaximumScore, retime, retimedMinimumScore } from "./retime.ts";
import { fastestOfThree, resegment, syntheticTrack, transform } from "./test-tracks.ts";

const fileRelease = parseRelease("Movie.2024.1080p.BluRay.x264-GROUP");

const candidate = (overrides: Partial<Candidate>): Candidate => ({
  sourceName: "test",
  ref: "ref",
  lang: "eng",
  release: fileRelease,
  hashMatch: false,
  ...overrides,
});

const byHash = (cues: Cue[], fps?: number) => ({
  candidate: candidate({ ref: "reference", hashMatch: true, fps }),
  cues,
});

const byReleaseName = (cues: Cue[], fps?: number) => ({
  candidate: candidate({ ref: "reference", fps }),
  cues,
});

const subtitleOf = (cues: Cue[], fps?: number) => ({
  candidate: candidate({ ref: "subtitle", fps }),
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

  it("uses the frame rate ratio when both sides carry an fps", async () => {
    const speedRatio = speedRatioFromFPS(25, 23.976);
    const scaled = transform(resegment(track, 7), (time) => time * speedRatio + 2000);

    const result = await retime(subtitleOf(scaled, 25), [byHash(track, 23.976)]);

    expect(result).toMatchObject({ kind: "retimed", speedRatio });
  });

  it("uses a frame rate ratio that no speed search would try", async () => {
    const speedRatio = speedRatioFromFPS(30, 25);
    const scaled = transform(resegment(track, 7), (time) => time * speedRatio + 2000);

    const result = await retime(subtitleOf(scaled, 30), [byHash(track, 25)]);

    expect(result).toMatchObject({ kind: "retimed", speedRatio: 1.2 });
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
    const speedRatio = speedRatioFromFPS(25, 23.976);
    const scaled = transform(resegment(withSilence, 7), (time) => (time + 2000) * speedRatio);

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

    const result = await retime(subtitleOf(exact), [byHash(track), byHash(outlier)]);

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
    const { score } = await alignCues(track, partlyUnrelated);

    expect(score).toBeGreaterThanOrEqual(mismatchMaximumScore);
    expect(score).toBeLessThan(retimedMinimumScore);
    expect(await retime(subtitleOf(partlyUnrelated, 25), [byHash(track, 25)])).toEqual({
      kind: "not-retimed",
      cues: partlyUnrelated,
    });
  });

  it("does not retime without references", async () => {
    expect(await retime(subtitleOf(shifted), [])).toEqual({ kind: "not-retimed", cues: shifted });
  });

  it("retimes a 1500-cue subtitle against one hash reference in under 1500 ms", async () => {
    const long = syntheticTrack(3, 1500);
    const subtitle = subtitleOf(transform(resegment(long, 7), (time) => time + 2000));

    expect(await fastestOfThree(() => retime(subtitle, [byHash(long)]))).toBeLessThan(1500);
  }, 10_000);
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

  it("picks nothing when no candidate matches", () => {
    expect(pickReferences([otherRelease("a")], fileRelease)).toEqual([]);
  });
});
