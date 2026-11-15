import { describe, expect, it } from "vitest";
import { retime } from "./retime.ts";
import { byHash, subtitleOf } from "./test-candidates.ts";
import { fastestOfThree, resegment, syntheticTrack, transform } from "./test-tracks.ts";

describe("retime", () => {
  it("retimes a 1500-cue subtitle against one hash reference in under 1500 ms", async () => {
    const long = syntheticTrack(3, 1500);
    const subtitle = subtitleOf(transform(resegment(long, 7), (time) => time + 2000));

    expect(await fastestOfThree(() => retime(subtitle, [byHash(long)]))).toBeLessThan(1500);
  }, 10_000);
});
