import { searchAll } from "../sources/search-all.ts";
import {
  openSubtitlesAPIName,
  openSubtitlesV3Name,
  type SourceSet,
} from "../sources/from-config.ts";
import type { Candidate, VideoQuery } from "../sources/source.ts";
import {
  inReleaseFamily,
  isDiscOrWeb,
  looksLikeRip,
  parseRelease,
  releaseFamilyOf,
  sourceFitsFile,
  type Release,
  type ReleaseFamily,
} from "../subtitles/release.ts";
import { minimumScoreOf, rankingOf, scoreOf } from "../subtitles/score.ts";
import { anchorWithGuardsOf, asGoodAsAnchor, guardChecks } from "../timing/anchor.ts";
import { freeOnly, pickReferences } from "../timing/references.ts";
import type { CandidateRef } from "./refs.ts";

export const bestSlotSize = 4;
const displayNames = new Map([[openSubtitlesAPIName, "OpenSubtitles"]]);

const displayNameOf = ({ sourceName }: Candidate) => displayNames.get(sourceName) ?? sourceName;

export const withFree = (group: Candidate[], pool: Candidate[]) => {
  const free = pool.find(({ metered }) => metered !== true);

  return free === undefined || !group.every(({ metered }) => metered === true)
    ? group
    : [...group.slice(0, bestSlotSize - 1), free];
};

export const bySource = (candidates: Candidate[], pool: Candidate[]) =>
  [...Map.groupBy(candidates, displayNameOf)].map(([name, group]) =>
    withFree(
      group.slice(0, bestSlotSize),
      pool.filter((candidate) => displayNameOf(candidate) === name),
    ),
  );

export const labelOf = (candidates: Candidate[], note?: string) => {
  const sources = new Set(candidates.map(displayNameOf));
  const notes = [
    candidates.every(({ hashMatch }) => hashMatch) ? ["made for this file"] : [],
    note === undefined ? [] : [note],
  ].flat();
  const name = [...sources].join(", ");

  return notes.length === 0 ? name : `${name} (${notes.join(", ")})`;
};

export const toCandidateRef = (candidate: Candidate): CandidateRef => ({
  n: candidate.sourceName,
  r: candidate.ref,
  l: candidate.lang,
  h: candidate.hashMatch ? 1 : undefined,
  p: candidate.fps,
  m: candidate.metered === true ? 1 : undefined,
});

const familySources = new Set([openSubtitlesV3Name, openSubtitlesAPIName]);

const isForeignPartsOnly = ({ foreignPartsOnly }: Candidate) => foreignPartsOnly === true;

export const searchVideo = async (
  sources: SourceSet,
  query: VideoQuery,
  learnedFamily: Promise<ReleaseFamily | undefined> = Promise.resolve(undefined),
) => {
  const [found, referenceOnly, learned] = await Promise.all([
    searchAll(sources.listed, query),
    searchAll(sources.references, query),
    learnedFamily,
  ]);

  const listed = found.filter((candidate) => !isForeignPartsOnly(candidate));
  const everything = [
    ...listed,
    ...referenceOnly.filter((candidate) => !isForeignPartsOnly(candidate)),
  ];
  const all = everything.filter(({ lang }) => query.languages.includes(lang));

  const arrangedFor = (fileRelease: Release, filename = query.filename) => {
    const family =
      learned !== undefined && sourceFitsFile(learned.source, fileRelease) ? learned : undefined;
    const inFamily = ({ release }: Candidate) =>
      family !== undefined && inReleaseFamily(release, family);
    const picked = pickReferences(all, fileRelease, family);
    const ripGuess = family === undefined && looksLikeRip(filename ?? "");
    const guessed = ({ release }: Candidate) =>
      ripGuess && isDiscOrWeb(release) && sourceFitsFile(release.source, fileRelease);
    const fromGuess = picked.length === 0 && ripGuess;
    const references = fromGuess ? freeOnly(all.filter(guessed)) : picked;
    const scoreContext = { video: { ...query, filename }, fileRelease, family, ripGuess };
    const ranking = rankingOf(scoreContext);

    const free = everything.filter(({ metered }) => metered !== true).toSorted(ranking);
    const anchors = anchorWithGuardsOf(free, scoreContext);
    const [anchor] = anchors;

    return {
      references,
      anchors,
      pool: free.slice(0, guardChecks + 1),
      asGoodAsAnchor: (candidate: Candidate) =>
        anchor !== undefined && asGoodAsAnchor(candidate, anchor, scoreContext),
      referencesFor: (candidates: Candidate[]) => {
        const first = candidates[0];
        const allInFamily = candidates.every(
          (candidate) => !candidate.hashMatch && inFamily(candidate),
        );
        const guessedFirst = fromGuess && first !== undefined && guessed(first);

        return allInFamily || guessedFirst ? [] : references;
      },
      observedFamily: all
        .filter(
          ({ hashMatch, sourceName, release }) =>
            hashMatch && familySources.has(sourceName) && release.source !== undefined,
        )
        .map(({ release }) => releaseFamilyOf(release))
        .find((observed) => observed !== undefined),
      ranked: (lang: string) =>
        listed.filter((candidate) => candidate.lang === lang).toSorted(ranking),
      foreignPartsOnly: (lang: string) =>
        found
          .filter((candidate) => isForeignPartsOnly(candidate) && candidate.lang === lang)
          .toSorted(ranking),
      passing: (candidates: Candidate[]) => {
        const minimum = minimumScoreOf(query.type);
        const kept = candidates.filter((candidate) => scoreOf(candidate, scoreContext) >= minimum);

        return kept.length > 0 ? kept : candidates;
      },
    };
  };

  return {
    ...arrangedFor(parseRelease(query.filename ?? "")),
    arrangedFor: (fileRelease: Release) => arrangedFor(fileRelease, undefined),
  };
};

export type Arranged = ReturnType<Awaited<ReturnType<typeof searchVideo>>["arrangedFor"]>;

export const bestGroupsOf = (found: Arranged, lang: string) =>
  bySource(found.passing(found.ranked(lang)), found.ranked(lang));
