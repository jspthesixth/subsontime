import { readFileSync } from "node:fs";
import iconv from "iconv-lite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeSubtitle } from "./decode.ts";
import { SubtitleError } from "./cue.ts";
import { parseSubtitle } from "./parse.ts";
import { writeSRT } from "./write.ts";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../test/fixtures/subtitles/${name}`, import.meta.url)));

const encode = (text: string, encoding: string) => new Uint8Array(iconv.encode(text, encoding));

const croatian =
  "Dobro jutro, čokolada je ćudna. Žurimo se, šuma je daleko. Đurđevak čeka u šetnji.";
const slovenian = "Dober dan, čaj je že pripravljen. Šola se začne ob osmih, žoga je v vrtu.";
const serbianLatin = "Dobar dan, kako ste? Šetamo kroz park, a đaci čekaju ispred škole.";
const serbianCyrillic = "Добар дан, како сте? Шетамо кроз парк, а ђаци чекају испред школе.";
const macedonian = "Здраво, како си? Јас сум добро, ти благодарам. Ќе се видиме утре.";

describe("decodeSubtitle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("decodes Windows-1250 text", () => {
    expect(decodeSubtitle(fixture("cp1250.srt"))).toContain("čćžšđ ČĆŽŠĐ");
  });

  it("decodes Windows-1251 text", () => {
    expect(decodeSubtitle(fixture("cp1251.srt"))).toContain("Здраво, како си?");
  });

  it("drops the UTF-8 byte order mark", () => {
    expect(decodeSubtitle(fixture("utf8-bom.srt")).startsWith("﻿")).toBe(false);
  });

  it("decodes UTF-16 with a byte order mark", () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("1\nčž", "utf16le")]);

    expect(decodeSubtitle(bytes)).toBe("1\nčž");
  });

  it.each([undefined, "hrv"])("decodes short Croatian Windows-1250 with hint %s", (lang) => {
    expect(decodeSubtitle(encode(croatian, "windows-1250"), lang)).toBe(croatian);
  });

  it("decodes short Slovenian Windows-1250 with a hint", () => {
    expect(decodeSubtitle(encode(slovenian, "windows-1250"), "slv")).toBe(slovenian);
  });

  it.each([undefined, "srp"])("decodes short Serbian Cyrillic with hint %s", (lang) => {
    expect(decodeSubtitle(encode(serbianCyrillic, "windows-1251"), lang)).toBe(serbianCyrillic);
  });

  it.each([undefined, "mkd"])("decodes short Macedonian with hint %s", (lang) => {
    expect(decodeSubtitle(encode(macedonian, "windows-1251"), lang)).toBe(macedonian);
  });

  it("keeps Serbian Latin Windows-1250 Latin", () => {
    expect(decodeSubtitle(encode(serbianLatin, "windows-1250"), "srp")).toBe(serbianLatin);
  });

  it("decodes Russian with a hint", () => {
    expect(decodeSubtitle(encode("Привет, как дела?", "windows-1251"), "rus")).toBe(
      "Привет, как дела?",
    );
  });

  it("decodes UTF-16BE with a byte order mark", () => {
    const bytes = Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode("1\nčž", "utf16-be")]);

    expect(decodeSubtitle(bytes)).toBe("1\nčž");
  });

  it("throws SubtitleError when iconv-lite cannot decode", () => {
    vi.spyOn(iconv, "decode").mockImplementation(() => {
      throw new Error("Encoding not recognized");
    });

    expect(() => decodeSubtitle(encode(croatian, "windows-1250"))).toThrow(
      new SubtitleError("Could not decode subtitle"),
    );
  });

  it("throws on empty input", () => {
    expect(() => decodeSubtitle(fixture("empty.srt"))).toThrow(SubtitleError);
  });

  it("throws on an archive", () => {
    expect(() => decodeSubtitle(fixture("binary.zip"))).toThrow(SubtitleError);
  });
});

describe("parseSubtitle", () => {
  it("parses VTT", () => {
    const cues = parseSubtitle(decodeSubtitle(fixture("sample.vtt")));

    expect(cues).toEqual([
      { start: 1000, end: 3000, text: "Hello there." },
      { start: 4000, end: 6500, text: "General Kenobi." },
    ]);
  });

  it("strips ASS override blocks and converts line breaks", () => {
    const cues = parseSubtitle(decodeSubtitle(fixture("sample.ass")));

    expect(cues.map((cue) => cue.text)).toEqual([
      "Top line here.",
      "Two rows\nin one cue.",
      "Italic words.",
    ]);
  });

  it("throws when nothing parses", () => {
    expect(() => parseSubtitle("not a subtitle")).toThrow(SubtitleError);
  });
});

describe("writeSRT", () => {
  it("round-trips a normalized SRT", () => {
    const written = writeSRT(parseSubtitle(decodeSubtitle(fixture("utf8-bom.srt"))));

    expect(written).toBe(
      [
        "1\n00:00:01,000 --> 00:00:03,500\nFirst line.\n",
        "2\n00:00:05,000 --> 00:00:07,500\nSecond line\nover two rows.\n",
        "3\n00:00:09,000 --> 00:00:11,500\nThird line.\n",
      ].join("\n"),
    );
  });

  it("formats hours and milliseconds", () => {
    expect(writeSRT([{ start: 3_661_007, end: 3_662_000, text: "x" }])).toBe(
      "1\n01:01:01,007 --> 01:01:02,000\nx\n",
    );
  });
});
