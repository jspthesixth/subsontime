import { describe, expect, it } from "vitest";
import { fixRows, timingsOf } from "./fix-rows.ts";

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
        {
          id: "0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7",
          subtitleSketch: ["3333333333333333"],
          status: "confirmed" as const,
          method: "release-name",
          agreeing: 2,
          fromAudio: false,
          cueCount: 96,
        },
      ],
      hidden: [
        { subtitleSketch: ["12eeb7c400000000"], reason: "mismatch" as const, count: 3 },
        { subtitleSketch: ["7f0231bd00000000"], reason: "machine-translated" as const, count: 3 },
      ],
    };

    expect(fixRows(response)).toEqual([
      {
        subtitle: "a41c5e9f",
        lines: "1,240",
        timedBy: "Audio",
        agreement: "4 agree",
        status: "Confirmed",
        accent: true,
      },
      {
        subtitle: "c9d80a55",
        lines: "812",
        timedBy: "Reference",
        agreement: "1 submission",
        status: "Hint",
        accent: false,
      },
      {
        subtitle: "0e1f2a3b",
        lines: "96",
        timedBy: "Release name",
        agreement: "2 agree",
        status: "Confirmed",
        accent: true,
      },
      {
        subtitle: "12eeb7c4",
        lines: "-",
        timedBy: "-",
        agreement: "3 agree",
        status: "Wrong video",
        accent: false,
      },
      {
        subtitle: "7f0231bd",
        lines: "-",
        timedBy: "-",
        agreement: "3 agree",
        status: "Reported",
        accent: false,
      },
    ]);
  });

  it("maps an empty response to no rows", () => {
    expect(fixRows({ fixes: [], hidden: [] })).toEqual([]);
  });
});

describe("timingsOf", () => {
  it("accepts a lookup response", () => {
    const response = {
      fixes: [
        {
          id: "a41c5e9f0b7d2c31e8f4a6b9c0d1e2f3",
          subtitleSketch: ["1111111111111111"],
          status: "hint",
          method: "reference",
          agreeing: 1,
          fromAudio: false,
          cueCount: 12,
        },
      ],
      hidden: [{ subtitleSketch: ["2222222222222222"], reason: "mismatch", count: 2 }],
    };

    expect(timingsOf(response)).toEqual(response);
  });

  it.each([
    ["nothing", undefined],
    ["an error body", { error: "Try again in a moment" }],
    ["a fix without a line count", { fixes: [{ id: "a", status: "hint" }], hidden: [] }],
    [
      "an unknown hidden reason",
      { fixes: [], hidden: [{ subtitleSketch: [], reason: "boring", count: 1 }] },
    ],
  ])("rejects %s", (_, body) => {
    expect(timingsOf(body)).toBeUndefined();
  });
});
