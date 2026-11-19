import { describe, expect, it } from "vitest";
import type { Candidate } from "../sources/source.ts";
import type { Cue } from "../subtitles/cue.ts";
import { changeMarkMs, retimeToFile } from "./anchor.ts";
import { syntheticTrack, transform } from "./test-tracks.ts";

const candidate = (ref: string, hashMatch: boolean): Candidate => ({
  sourceName: ref,
  ref,
  lang: "eng",
  release: { extended: false },
  hashMatch,
});
const film = syntheticTrack(3, 1500);
const file = { candidate: candidate("file", true), cues: film };
const startsOf = async (cues: Cue[]) => {
  const result = await retimeToFile({ candidate: candidate("subtitle", false), cues }, file);

  return result.kind === "retimed"
    ? [0, 700, 1499].map((index) => result.cues[index]?.start)
    : result.kind;
};

describe("retimeToFile", () => {
  it("moves a subtitle that is late by the same amount throughout", async () => {
    expect(await startsOf(transform(film, (time) => time + 3850))).toEqual([
      2245, 2908857, 6210294,
    ]);
  });

  it("moves each part of a subtitle that jumps partway through", async () => {
    const jumping = transform(film, (time) => (time < 3_000_000 ? time + 3850 : time + 5850));

    expect(await startsOf(jumping)).toEqual([2245, 2908857, 6210294]);
  });

  it("finds a subtitle for another video a mismatch", async () => {
    expect(await startsOf(syntheticTrack(4, 1500))).toBe("mismatch");
  });

  it("moves a subtitle to an image track that only marks when each picture changes", async () => {
    const changes = film
      .flatMap(({ start, end }) => [start, end])
      .map((time) => ({ start: time, end: time + changeMarkMs, text: "" }));
    const result = await retimeToFile(
      { candidate: candidate("subtitle", false), cues: transform(film, (time) => time + 3850) },
      { candidate: candidate("file", true), cues: changes },
      true,
    );

    expect(
      result.kind === "retimed"
        ? [0, 700, 1499].map((index) => [result.cues[index]?.start, result.cues[index]?.end])
        : result.kind,
    ).toEqual([
      [2245, 3361],
      [2908857, 2910061],
      [6210294, 6213595],
    ]);
  });
});
