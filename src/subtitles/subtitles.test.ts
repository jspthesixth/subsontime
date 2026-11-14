import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeSubtitle } from "./decode.ts";
import { SubtitleError } from "./cue.ts";
import { parseSubtitle } from "./parse.ts";
import { writeSRT } from "./write.ts";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../test/fixtures/subtitles/${name}`, import.meta.url)));

describe("decodeSubtitle", () => {
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
