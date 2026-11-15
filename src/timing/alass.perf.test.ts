import { describe, expect, it } from "vitest";
import { alignCues, alignOffset } from "./alass.ts";
import { fastestOfThree, syntheticTrack, transform } from "./test-tracks.ts";

describe("alignCues", () => {
  it("aligns two 1500-cue tracks in under 1500 ms", async () => {
    const long = syntheticTrack(3, 1500);
    const shifted = transform(long, (time) => time + 2000);

    expect(await fastestOfThree(() => alignCues(long, shifted))).toBeLessThan(1500);
  }, 10_000);
});

describe("alignOffset", () => {
  it("aligns two 1500-cue tracks in under 300 ms", async () => {
    const long = syntheticTrack(3, 1500);
    const shifted = transform(long, (time) => time + 2000);

    expect(await fastestOfThree(() => alignOffset(long, shifted))).toBeLessThan(300);
  });
});
