import { basename, extname } from "node:path";
import type { VideoQuery } from "../sources/source.ts";
import { searchCatalog } from "../web/catalog.ts";

export type Title = Pick<VideoQuery, "type" | "imdbId" | "season" | "episode">;

export type Identified =
  | { kind: "found"; title: Title; name?: string; year?: string }
  | { kind: "skipped"; reason: string };

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
  const cut = Math.min(
    ...[episode, releasePattern.exec(words)].map((match) => match?.index ?? words.length),
  );
  const year = [...words.matchAll(yearPattern)]
    .filter((match) => match.index > 0 && match.index < cut)
    .at(-1);

  return {
    title: words
      .slice(0, year?.index ?? cut)
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

const unreachableReason = "Could not reach Stremio's catalog to identify this title";
const unknownReason = "Could not identify this title";
const severalReason = "Several titles match; use --imdb";

export const identify = async (fileName: string, imdbId?: string): Promise<Identified> => {
  const { title, year, season, episode } = cleanName(fileName);

  if (imdbId !== undefined) {
    return { kind: "found", title: titleOf(imdbId, season, episode) };
  }

  if (title === "") {
    return { kind: "skipped", reason: unknownReason };
  }

  const metas = await searchCatalog(season === undefined ? "movie" : "series", title).catch(
    () => undefined,
  );

  if (metas === undefined) {
    return { kind: "skipped", reason: unreachableReason };
  }

  const named = metas.filter((meta) => folded(meta.name) === folded(title));
  const matching = year === undefined ? named : named.filter((meta) => meta.year === year);
  const [best] = matching;

  if (matching.length > 1 && year === undefined) {
    return { kind: "skipped", reason: severalReason };
  }

  return best === undefined
    ? { kind: "skipped", reason: unknownReason }
    : { kind: "found", title: titleOf(best.id, season, episode), name: best.name, year: best.year };
};
