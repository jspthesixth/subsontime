import { describe, expect, it } from "vitest";
import { defaultForm } from "../../../config/default-config.ts";
import { withoutFirstAsDual } from "./dual-language.ts";

const form = defaultForm(["hrv", "eng"]);

describe("withoutFirstAsDual", () => {
  it("turns dual subtitles off when the second language becomes the first", () => {
    expect(
      withoutFirstAsDual({ ...form, extras: { ...form.extras, dualLanguage: "hrv" } }).extras
        .dualLanguage,
    ).toBeUndefined();
  });

  it("keeps a second language other than the first", () => {
    expect(
      withoutFirstAsDual({ ...form, extras: { ...form.extras, dualLanguage: "eng" } }).extras
        .dualLanguage,
    ).toBe("eng");
  });
});
