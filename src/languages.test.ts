import { describe, expect, it } from "vitest";
import { toISO6391, toISO6392 } from "./languages.ts";

describe("languages", () => {
  it.each([
    ["hrv", "hr"],
    ["eng", "en"],
    ["pob", "pt-br"],
    ["por", "pt-pt"],
    ["zho", "zh-cn"],
    ["zht", "zh-tw"],
    ["deu", "de"],
    ["fra", "fr"],
    ["nld", "nl"],
  ])("round trips %s and %s", (code6392, code6391) => {
    expect(toISO6391(code6392)).toBe(code6391);
    expect(toISO6392(code6391)).toBe(code6392);
  });

  it.each([
    ["ger", "de"],
    ["fre", "fr"],
    ["dut", "nl"],
    ["cze", "cs"],
    ["slo", "sk"],
    ["rum", "ro"],
    ["gre", "el"],
    ["per", "fa"],
    ["chi", "zh-cn"],
  ])("reads the alias %s as %s", (code6392, code6391) => {
    expect(toISO6391(code6392)).toBe(code6391);
  });

  it("returns the first code for a language with aliases", () => {
    expect(toISO6392("de")).toBe("deu");
    expect(toISO6392("zh-cn")).toBe("zho");
  });

  it("is case insensitive and rejects unknown codes", () => {
    expect(toISO6392("PT-BR")).toBe("pob");
    expect(toISO6391("xxx")).toBeUndefined();
    expect(toISO6392("xx")).toBeUndefined();
  });
});
