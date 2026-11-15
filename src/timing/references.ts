import type { Candidate } from "../sources/source.ts";
import { sameRelease, type Release } from "../subtitles/release.ts";

const maximumReferences = 3;

export const pickReferences = (candidates: Candidate[], fileRelease: Release): Candidate[] => {
  const hashMatches = candidates.filter((candidate) => candidate.hashMatch);
  const pool =
    hashMatches.length > 0
      ? hashMatches
      : candidates.filter((candidate) => sameRelease(candidate.release, fileRelease));
  const free = pool.filter(({ metered }) => metered !== true);

  return (free.length > 0 ? free : pool).slice(0, maximumReferences);
};
