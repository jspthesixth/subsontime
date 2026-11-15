import type { Candidate } from "../sources/source.ts";
import {
  inReleaseFamily,
  sameRelease,
  type Release,
  type ReleaseFamily,
} from "../subtitles/release.ts";

const maximumReferences = 3;

export const freeFirst = (pool: Candidate[]) => {
  const free = pool.filter(({ metered }) => metered !== true);

  return (free.length > 0 ? free : pool).slice(0, maximumReferences);
};

export const pickReferences = (
  candidates: Candidate[],
  fileRelease: Release,
  family?: ReleaseFamily,
): Candidate[] => {
  const hashMatches = candidates.filter((candidate) => candidate.hashMatch);
  const pool =
    hashMatches.length > 0
      ? hashMatches
      : candidates.filter(
          ({ release }) =>
            sameRelease(release, fileRelease) ||
            (family !== undefined && inReleaseFamily(release, family)),
        );

  return freeFirst(pool);
};
