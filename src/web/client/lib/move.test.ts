import { describe, expect, it } from "vitest";
import { move } from "./move.ts";

describe("move", () => {
  it("moves a language one place earlier", () => {
    expect(move(["hrv", "eng", "deu"], 2, 1)).toEqual(["hrv", "deu", "eng"]);
  });

  it("moves a language to the first place", () => {
    expect(move(["hrv", "eng", "deu"], 2, 0)).toEqual(["deu", "hrv", "eng"]);
  });

  it("moves a language later", () => {
    expect(move(["hrv", "eng", "deu"], 0, 2)).toEqual(["eng", "deu", "hrv"]);
  });

  it("keeps the order for a place that does not exist", () => {
    expect(move(["hrv", "eng"], 5, 0)).toEqual(["hrv", "eng"]);
  });
});
