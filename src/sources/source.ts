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
};

export interface Source {
  name: string;
  search(query: VideoQuery, signal: AbortSignal): Promise<Candidate[]>;
  download(ref: string, signal: AbortSignal): Promise<Uint8Array>;
}
