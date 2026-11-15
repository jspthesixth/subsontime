import { describe, expect, it } from "vitest";
import { fastestOfThree } from "../timing/test-tracks.ts";
import { digest, fix, fixesOnly, hashLike, shifted, submitterAt, subtitle } from "./test-fixes.ts";

describe("summarize limits", () => {
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
});
