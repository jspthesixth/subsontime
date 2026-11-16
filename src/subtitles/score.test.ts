import { describe, expect, it } from "vitest";
import type { Candidate } from "../sources/source.ts";
import { parseRelease } from "./release.ts";
import { minimumScoreOf, scoreOf } from "./score.ts";

const named = (releaseName: string, overrides: Partial<Candidate> = {}): Candidate => ({
  sourceName: "OpenSubtitles",
  ref: releaseName,
  lang: "hrv",
  release: parseRelease(releaseName),
  releaseName,
  hashMatch: false,
  ...overrides,
});

const episode = (filename: string) => ({
  type: "series" as const,
  season: 1,
  episode: 24,
  filename,
});

const film = (filename: string) => ({ type: "movie" as const, filename });

describe("scoreOf", () => {
  it("scores an episode hash match alone at the episode maximum", () => {
    expect(
      scoreOf(named("Other.Show.S09E09.HDTV-X", { hashMatch: true }), {
        video: episode("Show.S01E24.1080p.BluRay.x264-GRP.mkv"),
      }),
    ).toBe(971);
  });

  it("scores a film hash match at the film maximum", () => {
    expect(
      scoreOf(named("Film.2001.DVDRip-X", { hashMatch: true }), {
        video: film("Film.2001.1080p.BluRay.x264-GRP.mkv"),
      }),
    ).toBe(323);
  });

  it("adds group, source, resolution and codec to the episode found by id", () => {
    expect(
      scoreOf(named("Show.S01E24.1080p.BluRay.x264-GRP"), {
        video: episode("Show.S01E24.1080p.BluRay.x264-GRP.mkv"),
      }),
    ).toBe(486 + 162 + 162 + 54 + 54 + 18 + 4 + 1 + 1);
  });

  it("drops the episode for a subtitle named after another episode", () => {
    expect(scoreOf(named("Show.S01E25.HDTV.XviD-LOL"), { video: episode("Show.S01E24.mkv") })).toBe(
      486 + 162 + 162 + 54,
    );
  });

  it("counts equivalent release groups as one", () => {
    expect(
      scoreOf(named("Show.S01E24.720p.HDTV.X264-DIMENSION"), {
        video: episode("Show.S01E24.720p.HDTV.x264-LOL.mkv"),
      }),
    ).toBe(486 + 162 + 162 + 54 + 54 + 18 + 4 + 1 + 1);
  });

  it("counts the learned family as a release group match", () => {
    const family = { source: "dvdrip" as const, group: "clerks" };

    expect(
      scoreOf(named("modern.family.s01e24.family.portrait.dvdrip.xvid-clerks"), {
        video: episode("Modern Family S01E24 Family Portrait  (1080p x265 10bit Joy).mkv"),
        family,
      }),
    ).toBe(486 + 162 + 162 + 54 + 54 + 18);
  });

  it("counts a disc or web subtitle as the source of a file that looks like a rip", () => {
    expect(
      scoreOf(named("modern.family.s01e24.family.portrait.dvdrip.xvid-clerks"), {
        video: episode("Modern Family S01E24 Family Portrait  (1080p x265 10bit Joy).mkv"),
        ripGuess: true,
      }),
    ).toBe(486 + 162 + 162 + 54 + 54 + 4);
  });

  it("ranks hash, exact release, learned family and the rip guess in that order", () => {
    const video = episode("Show.S01E24.1080p.BluRay.x264-GRP.mkv");
    const family = { source: "dvdrip" as const, group: "clerks" };
    const scores = [
      named("Show.S01E24.HDTV-X", { hashMatch: true }),
      named("Show.S01E24.1080p.BluRay-GRP"),
      named("Show.S01E24.DVDRip.XviD-clerks"),
      named("Show.S01E24.WEBRip-Y"),
    ].map((candidate) => scoreOf(candidate, { video, family, ripGuess: true }));

    expect(scores).toEqual(scores.toSorted((a, b) => b - a));
    expect(new Set(scores).size).toBe(4);
  });
});

describe("minimumScoreOf", () => {
  it("takes Bazarr's 90% for episodes and 70% for films", () => {
    expect(minimumScoreOf("series")).toBe(873);
    expect(minimumScoreOf("movie")).toBe(226);
  });
});
