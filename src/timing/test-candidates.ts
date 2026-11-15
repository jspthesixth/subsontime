import type { Candidate } from "../sources/source.ts";
import type { Cue } from "../subtitles/cue.ts";
import { parseRelease } from "../subtitles/release.ts";

export const fileRelease = parseRelease("Movie.2024.1080p.BluRay.x264-GROUP");

export const candidate = (overrides: Partial<Candidate>): Candidate => ({
  sourceName: "test",
  ref: "ref",
  lang: "eng",
  release: fileRelease,
  hashMatch: false,
  ...overrides,
});

export const byHash = (cues: Cue[], fps?: number) => ({
  candidate: candidate({ ref: "reference", hashMatch: true, fps }),
  cues,
});

export const subtitleOf = (cues: Cue[], fps?: number) => ({
  candidate: candidate({ ref: "subtitle", fps }),
  cues,
});
