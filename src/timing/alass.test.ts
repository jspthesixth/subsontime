import { describe, expect, it } from "vitest";
import type { Cue } from "../subtitles/cue.ts";
import { alignCues, alignOffset, bestSpeedRatio, speedRatioFromFPS, speedRatios } from "./alass.ts";
import { fastestOfThree, resegment, syntheticTrack, transform } from "./test-tracks.ts";

const reference = syntheticTrack(1, 200);
const related = resegment(reference, 7);

const unchangedError = (aligned: Cue[]) =>
  Math.max(
    ...related.flatMap((cue, index) => {
      const source = reference[cue.origin];
      const result = aligned[index];

      if (!cue.unchanged || source === undefined || result === undefined) {
        return [];
      }

      return [Math.abs(result.start - source.start), Math.abs(result.end - source.end)];
    }),
  );

const relatedError = (aligned: Cue[]) =>
  Math.max(
    ...related.flatMap((cue, index) => {
      const result = aligned[index];

      if (!cue.unchanged || result === undefined) {
        return [];
      }

      return [Math.abs(result.start - cue.start), Math.abs(result.end - cue.end)];
    }),
  );

describe("alignCues", () => {
  it("removes a constant offset from a re-segmented subtitle", async () => {
    const { cues, score } = await alignCues(
      reference,
      transform(related, (time) => time + 2000),
    );

    expect(unchangedError(cues)).toBeLessThanOrEqual(300);
    expect(relatedError(cues)).toBeLessThanOrEqual(60);
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it("aligns a 25 fps subtitle to a 23.976 fps reference", async () => {
    const speedRatio = speedRatioFromFPS(25, 23.976);
    const { cues, score } = await alignCues(
      reference,
      transform(related, (time) => (time * 25) / 23.976),
      { speedRatio },
    );

    expect(speedRatio).toBeCloseTo(1.042709, 6);
    expect(unchangedError(cues)).toBeLessThanOrEqual(300);
    expect(relatedError(cues)).toBeLessThanOrEqual(60);
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it("closes a gap cut into the middle", async () => {
    const { cues, score } = await alignCues(
      reference,
      transform(related, (time, cue) => (cue.origin >= 100 ? time + 90_000 : time)),
    );

    expect(unchangedError(cues)).toBeLessThanOrEqual(300);
    expect(relatedError(cues)).toBeLessThanOrEqual(60);
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it("scores an unrelated track low", async () => {
    const { score } = await alignCues(reference, syntheticTrack(2, 200));

    expect(score).toBeLessThan(0.3);
  });

  it("keeps the text of every cue", async () => {
    const { cues } = await alignCues(reference, related);

    expect(cues.map((cue) => cue.text)).toEqual(related.map((cue) => cue.text));
  });

  it("aligns two 1500-cue tracks in under 1500 ms", async () => {
    const long = syntheticTrack(3, 1500);
    const shifted = transform(long, (time) => time + 2000);

    expect(await fastestOfThree(() => alignCues(long, shifted))).toBeLessThan(1500);
  }, 10_000);
});

describe("alignOffset", () => {
  it("removes a constant offset with one delta", () => {
    const { cues, score } = alignOffset(
      reference,
      transform(related, (time) => time - 3000),
    );

    expect(unchangedError(cues)).toBeLessThanOrEqual(300);
    expect(relatedError(cues)).toBeLessThanOrEqual(60);
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it("aligns a 25 fps subtitle to a 23.976 fps reference with one delta", () => {
    const { cues, score } = alignOffset(
      reference,
      transform(related, (time) => (time * 25) / 23.976 - 3000),
      { speedRatio: speedRatioFromFPS(25, 23.976) },
    );

    expect(relatedError(cues)).toBeLessThanOrEqual(60);
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it("aligns two 1500-cue tracks in under 300 ms", async () => {
    const long = syntheticTrack(3, 1500);
    const shifted = transform(long, (time) => time + 2000);

    expect(await fastestOfThree(() => alignOffset(long, shifted))).toBeLessThan(300);
  });
});

describe("bestSpeedRatio", () => {
  it("picks 25 / 23.976 for a subtitle scaled by it", () => {
    const scaled = transform(related, (time) => (time * 25) / 23.976 + 2000);

    expect(bestSpeedRatio(reference, scaled, speedRatios)).toBe(25 / 23.976);
  });

  it("picks 1 for an unscaled subtitle", () => {
    const shifted = transform(related, (time) => time + 2000);

    expect(bestSpeedRatio(reference, shifted, speedRatios)).toBe(1);
  });

  it("falls back to 1 without candidate ratios", () => {
    expect(bestSpeedRatio(reference, related, [])).toBe(1);
  });
});

it("lists every frame rate pairing and its inverse", () => {
  expect(speedRatios).toEqual([
    1,
    25 / 23.976,
    23.976 / 25,
    24 / 23.976,
    23.976 / 24,
    25 / 24,
    24 / 25,
  ]);
});
