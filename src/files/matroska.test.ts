import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { subtitleTracksOf } from "./matroska.ts";

const fixture = (name: string) =>
  readFile(join(import.meta.dirname, "../../test/fixtures/files", name));

const readerOf = (bytes: Uint8Array) => ({
  size: bytes.length,
  read: async (start: number, length: number) => bytes.subarray(start, start + length),
});

describe("subtitleTracksOf", () => {
  it("reads every subtitle line's timing from the file's index", async () => {
    const tracks = await subtitleTracksOf(readerOf(await fixture("two-subtitles.mkv")));

    expect(tracks).toEqual([
      {
        number: 2,
        language: "eng",
        name: "Full",
        codec: "S_TEXT/UTF8",
        forced: false,
        cues: [
          { start: 1500, end: 3000, text: "" },
          { start: 5250, end: 6000, text: "" },
          { start: 9000, end: 11500, text: "" },
          { start: 14200, end: 16000, text: "" },
        ],
        changes: [1500, 5250, 9000, 14200],
      },
      {
        number: 3,
        language: "rus",
        name: undefined,
        codec: "S_TEXT/UTF8",
        forced: true,
        cues: [{ start: 5250, end: 6000, text: "" }],
        changes: [5250],
      },
    ]);
  });

  it("finds no subtitle tracks in a file without them", async () => {
    expect(await subtitleTracksOf(readerOf(await fixture("no-subtitles.mkv")))).toEqual([]);
  });

  it("finds no subtitle tracks in a file that is not Matroska", async () => {
    expect(await subtitleTracksOf(readerOf(new TextEncoder().encode("not a video")))).toEqual([]);
  });
});
