import { parseAudioCodec, parseSeason, parseVideoCodec } from "@ctrl/video-filename-parser";
import type { Candidate, VideoQuery } from "../sources/source.ts";
import {
  inReleaseFamily,
  isDiscOrWeb,
  parseRelease,
  type Release,
  type ReleaseFamily,
} from "./release.ts";

const episodeScores = {
  hash: 971,
  series: 486,
  country: 162,
  year: 162,
  episode: 54,
  season: 54,
  release_group: 18,
  source: 4,
  audio_codec: 2,
  resolution: 1,
  video_codec: 1,
};

const movieScores = {
  hash: 323,
  title: 162,
  country: 54,
  year: 54,
  release_group: 18,
  source: 4,
  audio_codec: 2,
  resolution: 1,
  video_codec: 1,
};

type Match = keyof typeof episodeScores | keyof typeof movieScores;

const equivalentGroups = [
  ["lol", "dimension"],
  ["asap", "immerse", "fleet"],
  ["avs", "sva"],
];

const groupsOf = (group: string) =>
  equivalentGroups.find((groups) => groups.includes(group)) ?? [group];

const sameGroup = (a: Release, b: Release) =>
  a.group !== undefined &&
  b.group !== undefined &&
  groupsOf(a.group.toLowerCase()).includes(b.group.toLowerCase());

const same = <T>(a: T | undefined, b: T | undefined) => a !== undefined && a === b;

type Video = Pick<VideoQuery, "type" | "season" | "episode" | "filename">;

type ScoreContext = { video: Video; family?: ReleaseFamily; ripGuess?: boolean };

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

const matchesOf = (candidate: Candidate, { video, family, ripGuess }: ScoreContext) => {
  const name = candidate.releaseName ?? "";
  const filename = video.filename ?? "";
  const fileRelease = parseRelease(filename);
  const { season, episode } = sameEpisode(name, video);
  const matches: [Match, boolean][] = [
    ["series", video.type === "series"],
    ["title", video.type === "movie"],
    ["year", true],
    ["country", true],
    ["season", video.type === "series" && season],
    ["episode", video.type === "series" && episode],
    [
      "release_group",
      sameGroup(candidate.release, fileRelease) ||
        (family !== undefined && inReleaseFamily(candidate.release, family)),
    ],
    [
      "source",
      same(candidate.release.source, fileRelease.source) ||
        (ripGuess === true && isDiscOrWeb(candidate.release)),
    ],
    ["resolution", same(candidate.release.resolution, fileRelease.resolution)],
    ["video_codec", same(parseVideoCodec(name).codec, parseVideoCodec(filename).codec)],
    ["audio_codec", same(parseAudioCodec(name).codec, parseAudioCodec(filename).codec)],
  ];

  return matches.flatMap(([match, matched]) => (matched ? [match] : []));
};

const scoresOf = (type: Video["type"]): Partial<Record<Match, number>> =>
  type === "series" ? episodeScores : movieScores;

export const scoreOf = (candidate: Candidate, context: ScoreContext) => {
  const scores = scoresOf(context.video.type);
  const maximum = scores.hash ?? 0;

  if (candidate.hashMatch) {
    return maximum;
  }

  const score = matchesOf(candidate, context).reduce(
    (total, match) => total + (scores[match] ?? 0),
    0,
  );

  return Math.min(Math.max(score, 0), maximum);
};

export const minimumScoreOf = (type: Video["type"]) =>
  Math.trunc(((scoresOf(type).hash ?? 0) * (type === "series" ? 90 : 70)) / 100);
