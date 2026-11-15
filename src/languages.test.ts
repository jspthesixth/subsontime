import { iso6392 } from "iso-639-2";
import { describe, expect, it } from "vitest";
import { fromLocales, languageCodes, toISO6391, toISO6392 } from "./languages.ts";

const legacyPairs = [
  ["hrv", "hr"],
  ["srp", "sr"],
  ["bos", "bs"],
  ["slv", "sl"],
  ["mkd", "mk"],
  ["eng", "en"],
  ["deu", "de"],
  ["ger", "de"],
  ["fra", "fr"],
  ["fre", "fr"],
  ["spa", "es"],
  ["ita", "it"],
  ["por", "pt-pt"],
  ["pob", "pt-br"],
  ["nld", "nl"],
  ["dut", "nl"],
  ["pol", "pl"],
  ["ces", "cs"],
  ["cze", "cs"],
  ["slk", "sk"],
  ["slo", "sk"],
  ["hun", "hu"],
  ["ron", "ro"],
  ["rum", "ro"],
  ["bul", "bg"],
  ["rus", "ru"],
  ["ukr", "uk"],
  ["ell", "el"],
  ["gre", "el"],
  ["tur", "tr"],
  ["ara", "ar"],
  ["heb", "he"],
  ["fas", "fa"],
  ["per", "fa"],
  ["zho", "zh-cn"],
  ["chi", "zh-cn"],
  ["zht", "zh-tw"],
  ["jpn", "ja"],
  ["kor", "ko"],
  ["swe", "sv"],
  ["nor", "no"],
  ["dan", "da"],
  ["fin", "fi"],
];

const firstPairs = legacyPairs.filter(
  ([code6392, code6391]) => legacyPairs.find(([, other]) => other === code6391)?.[0] === code6392,
);

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

  it.each(legacyPairs)("keeps reading the sealed code %s as %s", (code6392, code6391) => {
    expect(toISO6391(code6392)).toBe(code6391);
  });

  it.each(firstPairs)("keeps writing %s for %s", (code6392, code6391) => {
    expect(toISO6392(code6391)).toBe(code6392);
  });

  it("keeps the codes that setup offers", () => {
    expect(languageCodes).toEqual(firstPairs.map(([code6392]) => code6392));
  });

  it("agrees with iso-639-2 on every offered code", () => {
    const standard = new Map(
      iso6392.flatMap((entry) =>
        entry.iso6391 === undefined ? [] : [[entry.iso6391, entry.iso6392T ?? entry.iso6392B]],
      ),
    );
    const iso = languageCodes.filter((code) => !["pob", "zht"].includes(code));

    expect(iso.map((code) => toISO6392(toISO6391(code) ?? ""))).toEqual(iso);
    expect(iso.map((code) => standard.get((toISO6391(code) ?? "").split("-")[0] ?? ""))).toEqual(
      iso,
    );
  });

  it.each([
    ["hr-HR", "hrv"],
    ["en-US", "eng"],
    ["pt-BR", "pob"],
    ["zh-TW", "zht"],
    ["de-AT", "deu"],
    ["sr-Latn-RS", "srp"],
  ])("maps the browser locale %s to %s", (locale, code) => {
    expect(fromLocales([locale])).toEqual([code]);
  });
});
