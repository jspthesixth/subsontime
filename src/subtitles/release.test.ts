import { describe, expect, it } from "vitest";
import {
  inReleaseFamily,
  parseRelease,
  releaseFamilyOf,
  releaseSignatureOf,
  releaseSimilarity,
  sameRelease,
} from "./release.ts";

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
    expect(parseRelease("Movie (2160p WEB-DL HDR10)").group).toBeUndefined();
    expect(parseRelease("Movie (1080p WEB-DL AV1)").group).toBeUndefined();
  });

  it("reads trailing parentheses before a language and a forced tag", () => {
    expect(
      parseRelease("Modern Family S01E23 Hawaii (1080p x265 10bit Joy).en.forced.srt").group,
    ).toBe("Joy");
  });

  it("drops a hearing-impaired tag inside trailing parentheses", () => {
    expect(parseRelease("Movie (1080p BluRay x265 Tigole SDH)").group).toBe("Tigole");
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

describe("releaseSignatureOf", () => {
  it("reads group, resolution and codec from a video file name", () => {
    expect(
      releaseSignatureOf("Modern Family S01E24 Family Portrait  (1080p x265 10bit Joy).mkv"),
    ).toBe("joy|1080p|h265");
  });

  it("treats x265, H.265 and HEVC as one codec", () => {
    expect(releaseSignatureOf("Show.S01E01.1080p.WEB-DL.H.265-GROUP.mkv")).toBe(
      releaseSignatureOf("Show.S01E02.1080p.WEB-DL.HEVC-group.mkv"),
    );
  });

  it("has no signature without a group", () => {
    expect(releaseSignatureOf("Show S01E01 1080p x265.mkv")).toBeUndefined();
  });
});

describe("releaseFamilyOf", () => {
  it("is the source and group a subtitle was made for", () => {
    expect(
      releaseFamilyOf(parseRelease("modern.family.s01e24.family.portrait.dvdrip.xvid-clerks.srt")),
    ).toEqual({ source: "dvdrip", group: "clerks" });
  });

  it("has no family without a group", () => {
    expect(releaseFamilyOf(parseRelease("Modern Family S01E24.DVDRip.srt"))).toBeUndefined();
  });

  it("matches a release of the same family whatever the case", () => {
    const family = { source: "dvdrip" as const, group: "clerks" };

    expect(inReleaseFamily(parseRelease("Show.S01E02.DVDRip.XviD-CLERKS.srt"), family)).toBe(true);
    expect(inReleaseFamily(parseRelease("Show.S01E02.HDTV.XviD-CLERKS.srt"), family)).toBe(false);
    expect(inReleaseFamily(parseRelease("Show.S01E02.DVDRip.XviD-LOL.srt"), family)).toBe(false);
  });
});
