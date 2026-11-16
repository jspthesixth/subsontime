import { describe, expect, it } from "vitest";
import { mergeDual } from "./dual.ts";

describe("mergeDual", () => {
  it("puts the overlapping second-language cue below the first in italics", () => {
    expect(
      mergeDual(
        [{ start: 0, end: 2000, text: "Hello." }],
        [{ start: 100, end: 1900, text: "Bok." }],
      ),
    ).toEqual([{ start: 0, end: 2000, text: "Hello.\n<i>Bok.</i>" }]);
  });

  it("attaches the split halves of each line to the line they came from", () => {
    const primary = [
      { start: 0, end: 2000, text: "One" },
      { start: 2000, end: 4000, text: "Two" },
    ];
    const secondary = [
      { start: 0, end: 1000, text: "Jedan a" },
      { start: 1000, end: 2000, text: "Jedan b" },
      { start: 2000, end: 3000, text: "Dva a" },
      { start: 3000, end: 4000, text: "Dva b" },
    ];

    expect(mergeDual(primary, secondary)).toEqual([
      { start: 0, end: 2000, text: "One\n<i>Jedan a</i>\n<i>Jedan b</i>" },
      { start: 2000, end: 4000, text: "Two\n<i>Dva a</i>\n<i>Dva b</i>" },
    ]);
  });

  it("attaches at most the two most overlapping lines and keeps the third on its own", () => {
    const secondary = [
      { start: 0, end: 500, text: "a" },
      { start: 500, end: 2000, text: "b" },
      { start: 2000, end: 3000, text: "c" },
    ];

    expect(mergeDual([{ start: 0, end: 3000, text: "Long line" }], secondary)).toEqual([
      { start: 0, end: 3000, text: "Long line\n<i>b</i>\n<i>c</i>" },
      { start: 0, end: 500, text: "<i>a</i>" },
    ]);
  });

  it("keeps a second-language cue that overlaps nothing on its own", () => {
    expect(
      mergeDual(
        [{ start: 0, end: 2000, text: "Hello." }],
        [{ start: 5000, end: 6000, text: "Sam." }],
      ),
    ).toEqual([
      { start: 0, end: 2000, text: "Hello." },
      { start: 5000, end: 6000, text: "<i>Sam.</i>" },
    ]);
  });

  it("gives a cue overlapping two lines equally to the earlier one", () => {
    expect(
      mergeDual(
        [
          { start: 0, end: 2000, text: "One" },
          { start: 2000, end: 4000, text: "Two" },
        ],
        [{ start: 1500, end: 2500, text: "Između" }],
      ),
    ).toEqual([
      { start: 0, end: 2000, text: "One\n<i>Između</i>" },
      { start: 2000, end: 4000, text: "Two" },
    ]);
  });

  it("joins a two-line second-language cue into one line", () => {
    expect(
      mergeDual(
        [{ start: 0, end: 2000, text: "Hello there." }],
        [{ start: 0, end: 2000, text: "Bok\ntamo." }],
      ),
    ).toEqual([{ start: 0, end: 2000, text: "Hello there.\n<i>Bok tamo.</i>" }]);
  });
});
