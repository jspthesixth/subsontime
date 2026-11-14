import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { pickSubtitleEntry } from "./zip.ts";

const megabyte = 1024 * 1024;
const subtitle = new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,000\nHello\n");

const lyingAboutSize = (zip: Uint8Array, declared: number) => {
  const patched = zip.slice();
  const view = new DataView(patched.buffer);

  view.setUint32(22, declared, true);
  Array.from({ length: patched.length - 4 }, (_, offset) => offset)
    .filter((offset) => view.getUint32(offset, true) === 0x02014b50)
    .forEach((offset) => view.setUint32(offset + 24, declared, true));

  return patched;
};

describe("pickSubtitleEntry", () => {
  it("skips a subtitle entry that declares more than 5 MB", () => {
    const zip = zipSync({ "huge.srt": new Uint8Array(5 * megabyte + 1), "small.srt": subtitle });

    expect(pickSubtitleEntry(zip)).toEqual(subtitle);
  });

  it("refuses an archive whose subtitle entries declare more than 20 MB together", () => {
    const zip = zipSync(
      Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [
          `part-${index}.srt`,
          new Uint8Array(4.5 * megabyte),
        ]),
      ),
    );

    expect(() => pickSubtitleEntry(zip)).toThrow("Subtitle archive too large");
  });

  it("does not count entries that are not subtitles", () => {
    const zip = zipSync({ "sample.mkv": new Uint8Array(30 * megabyte), "movie.srt": subtitle });

    expect(pickSubtitleEntry(zip)).toEqual(subtitle);
  });

  it("never inflates an entry past the size it declares", () => {
    const zip = lyingAboutSize(zipSync({ "bomb.srt": new Uint8Array(20 * megabyte) }), 1024);

    expect(pickSubtitleEntry(zip).length).toBeLessThanOrEqual(1024);
  });
});
