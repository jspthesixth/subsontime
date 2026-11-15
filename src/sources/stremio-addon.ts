import * as v from "valibot";
import { fetchWithTimeout } from "../http.ts";
import { parseRelease } from "../subtitles/release.ts";
import {
  maximumDownloadBytes,
  maximumSearchBytes,
  type Candidate,
  type Source,
  type VideoQuery,
} from "./source.ts";

const searchTimeoutMs = 4000;
const downloadTimeoutMs = 8000;

const entrySchema = v.object({
  id: v.optional(v.string()),
  url: v.string(),
  lang: v.string(),
  m: v.optional(v.unknown()),
  subtitleFileName: v.optional(v.string()),
  movieReleaseName: v.optional(v.string()),
  fpsMilli: v.optional(v.unknown()),
});

const responseSchema = v.object({ subtitles: v.array(v.unknown()) });

export const parseStremioId = (
  type: string,
  id: string,
): Pick<VideoQuery, "type" | "imdbId" | "season" | "episode"> => {
  const [imdbId = "", season, episode, ...rest] = id.split(":");
  const valid = /^tt\d+$/.test(imdbId);

  if (type === "movie" && valid && season === undefined) {
    return { type, imdbId };
  }

  if (
    type === "series" &&
    valid &&
    rest.length === 0 &&
    /^\d+$/.test(season ?? "") &&
    /^\d+$/.test(episode ?? "")
  ) {
    return { type, imdbId, season: Number(season), episode: Number(episode) };
  }

  throw new Error("Unsupported video id");
};

const videoId = (query: VideoQuery) => {
  if (query.type === "movie") {
    return query.imdbId;
  }

  if (query.season === undefined || query.episode === undefined) {
    throw new Error("Unsupported video id");
  }

  return `${query.imdbId}:${query.season}:${query.episode}`;
};

const requestURL = (manifestURL: string, query: VideoQuery) => {
  const id = videoId(query);
  const extras = [
    query.videoHash === undefined ? [] : [`videoHash=${query.videoHash}`],
    query.videoSize === undefined ? [] : [`videoSize=${query.videoSize}`],
    query.filename === undefined ? [] : [`filename=${encodeURIComponent(query.filename)}`],
  ].flat();
  const suffix = extras.length === 0 ? "" : `/${extras.join("&")}`;

  return `${manifestURL.replace(/\/manifest\.json$/, "")}/subtitles/${query.type}/${id}${suffix}.json`;
};

const toCandidate = (name: string, entry: v.InferOutput<typeof entrySchema>): Candidate => {
  const releaseName = entry.subtitleFileName ?? entry.movieReleaseName;
  const fps =
    typeof entry.fpsMilli === "number" && entry.fpsMilli > 0 ? entry.fpsMilli / 1000 : undefined;

  return {
    sourceName: name,
    ref: entry.url,
    lang: entry.lang,
    release: parseRelease(releaseName ?? ""),
    releaseName,
    hashMatch: entry.m === "h",
    fps,
  };
};

export type AddonEntry = { id?: string; candidate: Candidate };

export const addonEntries = async (
  manifestURL: string,
  name: string,
  query: VideoQuery,
  signal: AbortSignal,
): Promise<AddonEntry[]> => {
  const response = await fetchWithTimeout(
    requestURL(manifestURL, query),
    { signal, maxBytes: maximumSearchBytes },
    searchTimeoutMs,
  );
  const body = await response.json().catch(() => undefined);
  const parsed = v.safeParse(responseSchema, body);

  if (!response.ok || !parsed.success) {
    return [];
  }

  return parsed.output.subtitles
    .map((entry) => v.safeParse(entrySchema, entry))
    .flatMap((entry) =>
      entry.success ? [{ id: entry.output.id, candidate: toCandidate(name, entry.output) }] : [],
    )
    .filter(({ candidate }) => query.languages.includes(candidate.lang));
};

export const stremioAddonSource = (manifestURL: string, name: string): Source => ({
  name,
  async search(query, signal) {
    return (await addonEntries(manifestURL, name, query, signal)).map(({ candidate }) => candidate);
  },
  async download(ref, signal) {
    const response = await fetchWithTimeout(
      ref,
      { signal, maxBytes: maximumDownloadBytes },
      downloadTimeoutMs,
    );

    if (!response.ok) {
      throw new Error(`Download failed with status ${response.status}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  },
});

export const openSubtitlesV3 = stremioAddonSource(
  "https://opensubtitles-v3.strem.io/manifest.json",
  "OpenSubtitles",
);
