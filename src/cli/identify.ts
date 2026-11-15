import { basename, extname } from "node:path";
import type { VideoQuery } from "../sources/source.ts";
import { searchCatalog } from "../web/check-route.ts";

export type Title = Pick<VideoQuery, "type" | "imdbId" | "season" | "episode">;

const episodePattern = /\bs(\d{1,2})e(\d{1,3})\b/i;
const yearPattern = /\b(?:19|20)\d{2}\b/g;
const releasePattern =
  /\b(?:2160p|1080p|720p|576p|480p|4k|uhd|blu-?ray|bdrip|brrip|bdremux|remux|web-?dl|webrip|web|hdtv|dvdrip|x264|x265|h264|h265|hevc|proper|repack)\b/i;

const folded = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export const cleanName = (fileName: string) => {
  const words = basename(fileName, extname(fileName)).replace(/[._]+/g, " ");
  const episode = episodePattern.exec(words);
  const year = [...words.matchAll(yearPattern)].find((match) => match.index > 0);
  const end = Math.min(
    ...[episode, year, releasePattern.exec(words)].map((match) => match?.index ?? words.length),
  );

  return {
    title: words
      .slice(0, end)
      .replace(/[\s([-]+$/, "")
      .trim(),
    year: year?.[0],
    season: episode === null ? undefined : Number(episode[1]),
    episode: episode === null ? undefined : Number(episode[2]),
  };
};

const titleOf = (imdbId: string, season?: number, episode?: number): Title =>
  season === undefined || episode === undefined
    ? { type: "movie", imdbId }
    : { type: "series", imdbId, season, episode };

export const identify = async (fileName: string, imdbId?: string): Promise<Title | undefined> => {
  const { title, year, season, episode } = cleanName(fileName);

  if (imdbId !== undefined) {
    return titleOf(imdbId, season, episode);
  }

  if (title === "") {
    return undefined;
  }

  const named = (await searchCatalog(season === undefined ? "movie" : "series", title)).filter(
    (meta) => folded(meta.name) === folded(title),
  );
  const best =
    named.find((meta) => meta.year === year) ??
    (year === undefined || named.length === 1 ? named[0] : undefined);

  return best === undefined ? undefined : titleOf(best.id, season, episode);
};
