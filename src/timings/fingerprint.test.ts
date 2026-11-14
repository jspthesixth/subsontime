import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import type { Cue } from "../subtitles/cue.ts";
import { decodeSubtitle } from "../subtitles/decode.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import { writeSRT } from "../subtitles/write.ts";
import {
  croatianWords,
  dialogueTrack,
  isSoundOnly,
  withSoundDescriptions,
} from "../timing/test-tracks.ts";
import { cueHashes, normalizeCueText, similarity, toFixCues } from "./fingerprint.ts";

const definedHashes = (cues: Cue[]) => toFixCues(cues).map((cue) => cue.h);

const hashesOf = (bytes: Uint8Array) => cueHashes(parseSubtitle(decodeSubtitle(bytes, "hrv")));

describe("normalizeCueText", () => {
  it.each([
    ["<i>[DOOR SLAMS]</i> Hello,   world!", "hello world"],
    ["Hello,   World!", "hello world"],
    ["{\\an8}Up\\Nthere", "up there"],
    ["Šta?", "šta"],
    ["Ｈｅｌｌｏ ﬁne", "hello fine"],
    ["- JOHN: Wait...\n- What?!", "wait what"],
    ["[MUSIC PLAYING]", ""],
  ])("normalizes %j to %j", (text, expected) => {
    expect(normalizeCueText(text)).toBe(expected);
  });
});

describe("cueHashes", () => {
  it("hashes the first 8 bytes of SHA-256 over the normalized text", () => {
    expect(cueHashes([{ start: 0, end: 1000, text: "Hello,   World!" }])).toEqual([
      "b94d27b9934d3e08",
    ]);
  });

  it("leaves cues that normalize to empty without a hash", () => {
    const hashes = cueHashes([
      { start: 0, end: 1000, text: "[DOOR SLAMS]" },
      { start: 1000, end: 2000, text: "Hello." },
    ]);

    expect(hashes[0]).toBeUndefined();
    expect(hashes[1]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("gives Windows-1250 and UTF-8 copies of one subtitle the same hashes", () => {
    const srt = writeSRT(dialogueTrack(3, 60, croatianWords));
    const legacy = new Uint8Array(iconv.encode(srt, "windows-1250"));
    const utf8 = new TextEncoder().encode(srt);

    expect(Buffer.from(legacy).equals(Buffer.from(utf8))).toBe(false);
    expect(hashesOf(legacy)).toEqual(hashesOf(utf8));
    expect(hashesOf(utf8).every((hash) => hash !== undefined)).toBe(true);
  });
});

describe("toFixCues", () => {
  it("keeps the first cue of a repeated line and skips cues without a hash", () => {
    const fix = toFixCues([
      { start: 0, end: 500, text: "Yes." },
      { start: 1000, end: 1500, text: "[DOOR SLAMS]" },
      { start: 2000, end: 2500, text: "yes!" },
      { start: 3000, end: 3500, text: "No." },
    ]);

    expect(fix.map((cue) => [cue.s, cue.e])).toEqual([
      [0, 500],
      [3000, 3500],
    ]);
  });
});

describe("similarity", () => {
  it("is above 0.9 between a copy without sound descriptions and the full copy", () => {
    const dialogue = dialogueTrack(1, 200);
    const full = withSoundDescriptions(dialogue);
    const stripped = dialogue.filter((_, index) => !isSoundOnly(index));

    expect(similarity(definedHashes(full), definedHashes(stripped))).toBeGreaterThan(0.9);
  });

  it("is low between two different subtitles", () => {
    expect(
      similarity(definedHashes(dialogueTrack(1, 200)), definedHashes(dialogueTrack(2, 200))),
    ).toBeLessThan(0.1);
  });

  it("is 0 for two empty lists", () => {
    expect(similarity([], [])).toBe(0);
  });
});
