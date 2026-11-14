import { describe, expect, it } from "vitest";
import { fixRows } from "./fix-rows.ts";

describe("fixRows", () => {
  it("maps fixes and hidden entries from a lookup response to table rows", () => {
    const response = {
      fixes: [
        {
          id: "a41c5e9f0b7d2c31e8f4a6b9c0d1e2f3",
          subtitleSketch: ["1111111111111111"],
          status: "confirmed" as const,
          method: "audio",
          agreeing: 4,
          fromAudio: true,
          cueCount: 1240,
        },
        {
          id: "c9d80a55b7c412ee0f1e2d3c4b5a6978",
          subtitleSketch: ["2222222222222222"],
          status: "hint" as const,
          method: "reference",
          agreeing: 1,
          fromAudio: false,
          cueCount: 812,
        },
      ],
      hidden: [
        { subtitleSketch: ["12eeb7c400000000"], reason: "mismatch" as const, count: 3 },
        { subtitleSketch: ["7f0231bd00000000"], reason: "machine-translated" as const, count: 3 },
      ],
    };

    expect(fixRows(response)).toEqual([
      {
        lines: "1,240",
        subtitle: "a41c5e9f",
        fix: "1,240 lines · from audio",
        foundBy: "4 agree",
        status: "Confirmed",
        accent: true,
      },
      {
        lines: "812",
        subtitle: "c9d80a55",
        fix: "812 lines",
        foundBy: "1 submission",
        status: "Hint",
        accent: false,
      },
      {
        lines: "-",
        subtitle: "12eeb7c4",
        fix: "none",
        foundBy: "3 agree",
        status: "Wrong video",
        accent: false,
      },
      {
        lines: "-",
        subtitle: "7f0231bd",
        fix: "none",
        foundBy: "3 agree",
        status: "Reported",
        accent: false,
      },
    ]);
  });

  it("maps an empty response to no rows", () => {
    expect(fixRows({ fixes: [], hidden: [] })).toEqual([]);
  });
});
