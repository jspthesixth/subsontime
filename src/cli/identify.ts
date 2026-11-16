import { basename, extname } from "node:path";
import { filenameParse } from "@ctrl/video-filename-parser";
import type { VideoQuery } from "../sources/source.ts";
import { normalizedLine } from "../subtitles/lines.ts";
import { searchCatalog } from "../web/catalog.ts";
import { searchKey } from "../web/search-key.ts";

export type Title = Pick<VideoQuery, "type" | "imdbId" | "season" | "episode">;

export type Identified =
  | { kind: "found"; title: Title; name?: string; year?: string }
  | { kind: "skipped"; reason: string };

const episodePattern = /\bs(\d{1,2})e(\d{1,3})\b/i;

const folded = (text: string) => normalizedLine(searchKey(text));

export const cleanName = (fileName: string) => {
  const name = basename(fileName, extname(fileName));
  const episode = episodePattern.exec(name.replace(/[._]+/g, " "));
  const { title, year } = filenameParse(name, episode !== null);

  return {
    title,
    year: year ?? undefined,
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
