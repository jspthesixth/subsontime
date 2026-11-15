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

  it("reads a release kept in trailing parentheses", () => {
    expect(parseRelease("Modern Family S01E23 Hawaii  (1080p x265 10bit Joy).mkv")).toEqual({
      source: undefined,
      resolution: "1080p",
      group: "Joy",
      extended: false,
    });
  });

  it("reads the source from trailing parentheses", () => {
    expect(parseRelease("Movie (2019) (1080p BluRay x265 10bit AAC 5.1 Tigole)")).toEqual({
      source: "bluray",
      resolution: "1080p",
      group: "Tigole",
      extended: false,
    });
  });

  it("takes no codec as the group of trailing parentheses", () => {
    expect(parseRelease("Movie (1080p BluRay x265 AAC)").group).toBeUndefined();
  });

  it("ignores a bracketed tag without release labels", () => {
    expect(parseRelease("Show S01E23 1080p BluRay [Tvdb-95011]")).toEqual({
      source: "bluray",
      resolution: "1080p",
      group: undefined,
      extended: false,
    });
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

describe("parseRelease with language codes and glued groups", () => {
  it("drops a language code before the extension", () => {
    expect(parseRelease("Movie.2021.1080p.WEB-DL.x264-GROUP.hr.srt")).toEqual({
      source: "web-dl",
      resolution: "1080p",
      group: "GROUP",
      extended: false,
    });
  });

  it("drops a language code and a forced marker", () => {
    expect(parseRelease("Movie.2021.1080p.WEB-DL.x264-GROUP.eng.forced.srt").group).toBe("GROUP");
  });

  it("reads the source from a token with the group glued on", () => {
    expect(parseRelease("Example.Movie.2024.1080p.WEB-DL-GROUP.mkv")).toEqual({
      source: "web-dl",
      resolution: "1080p",
      group: "GROUP",
      extended: false,
    });
    expect(parseRelease("Movie.2021.1080p.BluRay-GROUP")).toMatchObject({
      source: "bluray",
      group: "GROUP",
    });
  });

  it("prefers the last matching source over a title word", () => {
    expect(parseRelease("The.Web.2020.720p.HDTV.x264-GRP").source).toBe("hdtv");
  });

  it("matches a video against its subtitle with a language code", () => {
    const video = parseRelease("Movie.2021.1080p.WEB-DL.x264-GROUP.mkv");

    expect(sameRelease(video, parseRelease("Movie.2021.1080p.WEB-DL.x264-GROUP.hr.srt"))).toBe(
      true,
    );
  });

  it("is not the same release when only the source differs", () => {
    const video = parseRelease("Movie.2021.1080p.WEB-DL.x264-GROUP.mkv");

    expect(sameRelease(video, parseRelease("Movie.2021.1080p.BluRay.x264-GROUP.srt"))).toBe(false);
  });
});
