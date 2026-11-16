import type { Release } from "../subtitles/release.ts";

export type VideoQuery = {
  type: "movie" | "series";
  imdbId: string;
  season?: number;
  episode?: number;
  videoHash?: string;
  videoSize?: number;
  filename?: string;
  languages: string[];
};

export type Candidate = {
  sourceName: string;
  ref: string;
  lang: string;
  release: Release;
  releaseName?: string;
  hashMatch: boolean;
  fps?: number;
  metered?: boolean;
  foreignPartsOnly?: boolean;
};

export interface Source {
  name: string;
  search(query: VideoQuery, signal: AbortSignal): Promise<Candidate[]>;
  download(ref: string, signal: AbortSignal, served?: boolean): Promise<Uint8Array>;
}

export type Series = VideoQuery & { type: "series"; season: number; episode: number };

const pad = (value: number) => String(value).padStart(2, "0");

export const isSeries = (query: VideoQuery): query is Series =>
  query.type === "series" && query.season !== undefined && query.episode !== undefined;

export const episodeTagOf = (season: number, episode: number) => `S${pad(season)}E${pad(episode)}`;

export const maximumSearchBytes = 2 * 1024 * 1024;
export const maximumDownloadBytes = 5 * 1024 * 1024;
