import { parseAudioCodec, parseSeason } from "@ctrl/video-filename-parser";
import type { Candidate, VideoQuery } from "../sources/source.ts";
import {
  inReleaseFamily,
  isDiscOrWeb,
  parseRelease,
  sameGroup,
  sameRelease,
  videoCodecOf,
  type Release,
  type ReleaseFamily,
} from "./release.ts";

type Match =
  | "hash"
  | "series"
  | "title"
  | "year"
  | "country"
  | "season"
  | "episode"
  | "releaseGroup"
  | "source"
  | "audioCodec"
  | "resolution"
  | "videoCodec";

type Scores = Record<Match, number>;

const episodeScores: Scores = {
  hash: 971,
  series: 486,
  title: 0,
  year: 162,
  country: 162,
  season: 54,
  episode: 54,
  releaseGroup: 18,
  source: 4,
  audioCodec: 2,
  resolution: 1,
  videoCodec: 1,
};

const movieScores: Scores = {
  hash: 323,
  series: 0,
  title: 162,
  year: 54,
  country: 54,
  season: 0,
  episode: 0,
  releaseGroup: 18,
  source: 4,
  audioCodec: 2,
  resolution: 1,
  videoCodec: 1,
};

const same = <T>(a: T | undefined, b: T | undefined) => a !== undefined && a === b;

type Video = Pick<VideoQuery, "type" | "season" | "episode" | "filename">;

type ScoreContext = {
  video: Video;
  fileRelease?: Release;
  family?: ReleaseFamily;
  ripGuess?: boolean;
};

const sameEpisode = (name: string, { season, episode }: Video) => {
  const parsed = parseSeason(name);

  return {
    season: parsed === null || parsed.seasons.length === 0 || parsed.seasons.includes(season ?? -1),
    episode:
      parsed === null ||
      parsed.episodeNumbers.length === 0 ||
      parsed.episodeNumbers.includes(episode ?? -1),
  };
};

const fileReleaseOf = ({ video, fileRelease }: ScoreContext) =>
  fileRelease ?? parseRelease(video.filename ?? "");

const matchesOf = (candidate: Candidate, context: ScoreContext): Match[] => {
  const { video, family, ripGuess } = context;

  const name = candidate.releaseName ?? "";
  const filename = video.filename ?? "";
  const fileRelease = fileReleaseOf(context);
  const { season, episode } = sameEpisode(name, video);

  const matches: [Match, boolean][] = [
    ["series", true],
    ["title", true],
    ["year", true],
    ["country", true],
    ["season", season],
    ["episode", episode],
    [
      "releaseGroup",
      sameGroup(candidate.release, fileRelease) ||
        (family !== undefined && inReleaseFamily(candidate.release, family)),
    ],
    [
      "source",
      same(candidate.release.source, fileRelease.source) ||
        (ripGuess === true && isDiscOrWeb(candidate.release)),
    ],
    ["resolution", same(candidate.release.resolution, fileRelease.resolution)],
    ["videoCodec", same(videoCodecOf(name), videoCodecOf(filename))],
    ["audioCodec", same(parseAudioCodec(name).codec, parseAudioCodec(filename).codec)],
  ];

  return matches.flatMap(([match, matched]) => (matched ? [match] : []));
};

const scoresOf = (type: Video["type"]) => (type === "series" ? episodeScores : movieScores);

export const scoreOf = (candidate: Candidate, context: ScoreContext) => {
  const scores = scoresOf(context.video.type);

  return candidate.hashMatch
    ? scores.hash
    : matchesOf(candidate, context).reduce((total, match) => total + scores[match], 0);
};

export const rankingOf = (context: ScoreContext) => {
  const fileRelease = fileReleaseOf(context);
  const scores = new Map<Candidate, number>();
  const exact = (candidate: Candidate) => sameRelease(candidate.release, fileRelease);
  const scored = (candidate: Candidate) => {
    const score = scores.get(candidate) ?? scoreOf(candidate, { ...context, fileRelease });

    scores.set(candidate, score);

    return score;
  };

  return (a: Candidate, b: Candidate) =>
    Number(b.hashMatch) - Number(a.hashMatch) ||
    Number(exact(b)) - Number(exact(a)) ||
    scored(b) - scored(a);
};

export const minimumScoreOf = (type: Video["type"]) =>
  Math.trunc((scoresOf(type).hash * (type === "series" ? 90 : 70)) / 100);
