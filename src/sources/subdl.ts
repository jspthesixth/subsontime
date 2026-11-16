import * as v from "valibot";
import { fetchWithTimeout } from "../http.ts";
import { verdictOf } from "./check.ts";
import { toISO6391, toISO6392 } from "../languages.ts";
import { parseRelease } from "../subtitles/release.ts";
import {
  episodeTagOf,
  isSeries,
  maximumDownloadBytes,
  maximumSearchBytes,
  type Candidate,
  type Series,
  type Source,
  type VideoQuery,
} from "./source.ts";
import { pickSubtitleEntry } from "./zip.ts";

export const sourceName = "SubDL";
const searchURL = "https://api.subdl.com/api/v1/subtitles";
const downloadURL = "https://dl.subdl.com";
const searchTimeoutMs = 4000;
const downloadTimeoutMs = 8000;
const refPattern = /^(\/subtitle\/[A-Za-z0-9_-]+\.zip)(?:#(S\d{2,}E\d{2,}))?$/;

const searchSchema = v.object({
  status: v.literal(true),
  subtitles: v.nullish(v.array(v.unknown())),
});

const rowSchema = v.object({
  release_name: v.nullish(v.string()),
  name: v.nullish(v.string()),
  language: v.string(),
  url: v.pipe(v.string(), v.minLength(1)),
  season: v.nullish(v.number()),
  episode: v.nullish(v.number()),
  episode_from: v.nullish(v.number()),
  episode_end: v.nullish(v.number()),
  full_season: v.nullish(v.boolean()),
});

type Row = v.InferOutput<typeof rowSchema>;

const toSubDLCode = (lang: string) => {
  const special: Record<string, string> = { pob: "br_pt", por: "pt" };

  return special[lang] ?? toISO6391(lang);
};

const fromSubDLCode = (code: string) => {
  const lower = code.toLowerCase();
  const special: Record<string, string> = { br_pt: "pob", pt: "por" };

  return special[lower] ?? toISO6392(lower);
};

const matchesEpisode = (query: Series, row: Row) => {
  const inRange =
    typeof row.episode_from === "number" &&
    typeof row.episode_end === "number" &&
    row.episode_from <= query.episode &&
    query.episode <= row.episode_end;
  const fullSeason =
    row.full_season === true || (row.episode_from === null && row.episode_end === 0);

  return row.season === query.season && (row.episode === query.episode || inRange || fullSeason);
};

const toCandidate = (row: Row, query: VideoQuery): Candidate[] => {
  const lang = fromSubDLCode(row.language);

  if (lang === undefined) {
    return [];
  }

  const releaseName = row.release_name || row.name || undefined;
  const tag = isSeries(query) ? `#${episodeTagOf(query.season, query.episode)}` : "";

  return [
    {
      sourceName,
      ref: `${row.url}${tag}`,
      lang,
      release: parseRelease(releaseName ?? ""),
      releaseName,
      hashMatch: false,
      fps: undefined,
    },
  ];
};

export const subdlSource = (apiKey: string): Source => ({
  name: sourceName,
  async search(query, signal) {
    const codes = [...new Set(query.languages.flatMap((lang) => toSubDLCode(lang) ?? []))];

    if (codes.length === 0) {
      return [];
    }

    const params = new URLSearchParams({
      api_key: apiKey,
      imdb_id: query.imdbId,
      languages: codes.join(","),
      type: query.type === "series" ? "tv" : "movie",
      ...(isSeries(query)
        ? { season_number: String(query.season), episode_number: String(query.episode) }
        : {}),
      subs_per_page: "30",
    });
    const response = await fetchWithTimeout(
      `${searchURL}?${params}`,
      { signal, maxBytes: maximumSearchBytes },
      searchTimeoutMs,
    );
    const parsed = v.safeParse(searchSchema, await response.json().catch(() => undefined));

    if (!response.ok || !parsed.success) {
      return [];
    }

    return (parsed.output.subtitles ?? [])
      .map((row) => v.safeParse(rowSchema, row))
      .flatMap((row) => {
        const keep = row.success && (!isSeries(query) || matchesEpisode(query, row.output));

        return keep ? toCandidate(row.output, query) : [];
      });
  },
  async download(ref, signal) {
    const match = refPattern.exec(ref);

    if (match === null) {
      throw new Error("SubDL download failed");
    }

    const [, path = "", tag] = match;

    const response = await fetchWithTimeout(
      `${downloadURL}${path}`,
      { signal, maxBytes: maximumDownloadBytes },
      downloadTimeoutMs,
    );

    if (!response.ok) {
      throw new Error("SubDL download failed");
    }

    try {
      return pickSubtitleEntry(new Uint8Array(await response.arrayBuffer()), tag);
    } catch {
      throw new Error("SubDL download failed");
    }
  },
});

export const checkSubDL = async (apiKey: string, timeoutMs: number) => {
  const params = new URLSearchParams({
    api_key: apiKey,
    imdb_id: "tt0111161",
    languages: "en",
    type: "movie",
    subs_per_page: "1",
  });

  return verdictOf(
    await fetchWithTimeout(`${searchURL}?${params}`, { maxBytes: maximumSearchBytes }, timeoutMs),
    searchSchema,
  );
};
