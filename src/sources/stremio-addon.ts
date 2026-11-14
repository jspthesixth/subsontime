import * as v from "valibot";
import { fetchWithTimeout } from "../http.ts";
import { parseRelease } from "../subtitles/release.ts";
import type { Candidate, Source, VideoQuery } from "./source.ts";

const searchTimeoutMs = 4000;
const downloadTimeoutMs = 8000;

const entrySchema = v.object({
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

const requestURL = (manifestURL: string, query: VideoQuery) => {
  const id =
    query.type === "series" ? `${query.imdbId}:${query.season}:${query.episode}` : query.imdbId;
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

export const stremioAddonSource = (manifestURL: string, name: string): Source => ({
  name,
  async search(query, signal) {
    const response = await fetchWithTimeout(
      requestURL(manifestURL, query),
      { signal },
      searchTimeoutMs,
    );
    const body = await response.json().catch(() => undefined);
    const parsed = v.safeParse(responseSchema, body);

    if (!response.ok || !parsed.success) {
      return [];
    }

    return parsed.output.subtitles
      .map((entry) => v.safeParse(entrySchema, entry))
      .flatMap((entry) => (entry.success ? [toCandidate(name, entry.output)] : []))
      .filter((candidate) => query.languages.includes(candidate.lang));
  },
  async download(ref, signal) {
    const response = await fetchWithTimeout(ref, { signal }, downloadTimeoutMs);

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
