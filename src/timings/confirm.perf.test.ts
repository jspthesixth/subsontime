import { describe, expect, it } from "vitest";
import { fastestOfThree } from "../timing/test-tracks.ts";
import {
  differentFixes,
  digest,
  fixesOnly,
  mostlyAgreeingFixes,
  nearIdenticalFixes,
  partlySimilarFixes,
} from "./test-fixes.ts";

describe("summarize limits", () => {
  it("summarizes 500 fixes of 2000 cues in under 300 ms", async () => {
    const fixes = mostlyAgreeingFixes();

    expect(await fastestOfThree(() => fixesOnly(fixes))).toBeLessThan(300);
  });

  it("summarizes 500 crafted near-identical rows of 2000 lines in under 500 ms", async () => {
    const fixes = nearIdenticalFixes();

    expect(await fastestOfThree(() => fixesOnly(fixes))).toBeLessThan(500);
  });
});

describe("summarize grouping bounds", () => {
  it("summarizes 500 rows about 0.82 similar to each other in under 500 ms", async () => {
    const fixes = partlySimilarFixes();

    expect(await fastestOfThree(() => fixesOnly(fixes))).toBeLessThan(500);
  });

  it("keeps 64 groups of 500 different subtitles from 500 origins in under 500 ms", async () => {
    const fixes = differentFixes();

    expect(await fastestOfThree(() => digest(fixes, [], []))).toBeLessThan(500);
  });
});
