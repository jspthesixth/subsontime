import { describe, expect, it } from "vitest";
import { fromLocales, languageCodes, toISO6391, toISO6392 } from "./languages.ts";

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

  it("lists every language once, by its first code", () => {
    expect(languageCodes).toContain("hrv");
    expect(languageCodes).toContain("pob");
    expect(languageCodes).not.toContain("ger");
    expect(new Set(languageCodes.map(toISO6391)).size).toBe(languageCodes.length);
  });

  it.each([
    [
      ["hr-HR", "en-US", "en"],
      ["hrv", "eng"],
    ],
    [["pt-BR", "pt"], ["pob"]],
    [["sr-Latn-RS"], ["srp"]],
    [["xx", "tlh"], ["eng"]],
    [[], ["eng"]],
  ])("reads the browser languages %j as %j", (locales, codes) => {
    expect(fromLocales(locales)).toEqual(codes);
  });
});
