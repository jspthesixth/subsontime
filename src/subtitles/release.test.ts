import { describe, expect, it } from "vitest";
import { parseRelease, releaseSimilarity, sameRelease } from "./release.ts";

describe("parseRelease", () => {
  it("reads source, resolution and group from a web release", () => {
    expect(parseRelease("Example.Movie.2024.1080p.WEB-DL.DDP5.1.H.264-GROUP.mkv")).toEqual({
      source: "web-dl",
      resolution: "1080p",
      group: "GROUP",
      extended: false,
    });
  });

  it("flags extended cuts", () => {
    expect(parseRelease("Movie.2024.EXTENDED.2160p.BluRay.x265-FLUX")).toEqual({
      source: "bluray",
      resolution: "2160p",
      group: "FLUX",
      extended: true,
    });
  });

  it("reads a Sonarr-style episode name", () => {
    expect(parseRelease("Show.Name.S02E05.720p.HDTV.x264-KILLERS.mkv")).toEqual({
      source: "hdtv",
      resolution: "720p",
      group: "KILLERS",
      extended: false,
    });
  });

  it("ignores a bracketed site tag after the group", () => {
    expect(parseRelease("Movie.2023.1080p.BluRay.x264-SPARKS[rarbg]").group).toBe("SPARKS");
  });

  it("has no group without a dash in the last token", () => {
    expect(parseRelease("Movie 2020 1080p WEBRip")).toEqual({
      source: "webrip",
      resolution: "1080p",
      group: undefined,
      extended: false,
    });
  });

  it("recognizes directors cut", () => {
    expect(parseRelease("Movie.Directors.Cut.1080p.BluRay-AAA").extended).toBe(true);
  });
});

describe("sameRelease", () => {
  const web = parseRelease("Example.Movie.2024.1080p.WEB-DL.DDP5.1.H.264-GROUP.mkv");

  it("is true when source, resolution and group match", () => {
    expect(sameRelease(web, parseRelease("Other.Name.1080p.WEB-DL.x264-GROUP.srt"))).toBe(true);
  });

  it("ignores the case of the group", () => {
    expect(sameRelease(web, parseRelease("Other.Name.1080p.WEB-DL.x264-group.srt"))).toBe(true);
  });

  it("is false when either group is missing", () => {
    const noGroup = parseRelease("Movie 2020 1080p WEB-DL");

    expect(sameRelease(web, noGroup)).toBe(false);
    expect(sameRelease(noGroup, web)).toBe(false);
  });

  it("is false when the resolution differs", () => {
    expect(sameRelease(web, parseRelease("Movie.720p.WEB-DL.x264-GROUP"))).toBe(false);
  });
});

describe("releaseSimilarity", () => {
  it("is 0 for unrelated releases", () => {
    const a = parseRelease("Example.Movie.2024.1080p.WEB-DL.DDP5.1.H.264-GROUP.mkv");
    const b = parseRelease("Movie.2024.EXTENDED.2160p.BluRay.x265-FLUX");

    expect(releaseSimilarity(a, b)).toBe(0);
  });

  it("counts one point per matching field", () => {
    const a = parseRelease("A.1080p.WEB-DL.x264-GROUP");

    expect(releaseSimilarity(a, parseRelease("B.720p.WEB-DL.x264-GROUP"))).toBe(2);
    expect(releaseSimilarity(a, a)).toBe(3);
  });
});
