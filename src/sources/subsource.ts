import * as v from "valibot";
import { fetchWithTimeout } from "../http.ts";
import { verdictOf } from "./check.ts";
import { parseRelease } from "../subtitles/release.ts";
import {
  maximumDownloadBytes,
  maximumSearchBytes,
  type Candidate,
  type Source,
  type VideoQuery,
} from "./source.ts";
import { pickSubtitleEntry } from "./zip.ts";

const sourceName = "SubSource";
const baseURL = "https://api.subsource.net/api/v1";
const searchTimeoutMs = 4000;
const downloadTimeoutMs = 8000;
const refPattern = /^(\d+)(?:#(S\d{2,}E\d{2,}))?$/;

const languageNames = new Map([
  ["eng", "english"],
  ["pol", "polish"],
  ["spa", "spanish"],
  ["fre", "french"],
  ["fra", "french"],
  ["ger", "german"],
  ["deu", "german"],
  ["ita", "italian"],
  ["por", "portuguese"],
  ["rus", "russian"],
  ["ara", "arabic"],
  ["chi", "chinese"],
  ["zho", "chinese"],
  ["jpn", "japanese"],
  ["kor", "korean"],
  ["tur", "turkish"],
  ["dut", "dutch"],
  ["nld", "dutch"],
  ["swe", "swedish"],
  ["nor", "norwegian"],
  ["dan", "danish"],
  ["fin", "finnish"],
  ["cze", "czech"],
  ["ces", "czech"],
  ["hun", "hungarian"],
  ["rum", "romanian"],
  ["ron", "romanian"],
  ["gre", "greek"],
  ["ell", "greek"],
  ["heb", "hebrew"],
  ["tha", "thai"],
  ["vie", "vietnamese"],
  ["hrv", "croatian"],
  ["srp", "serbian"],
  ["bos", "bosnian"],
  ["slv", "slovenian"],
  ["mkd", "macedonian"],
  ["bul", "bulgarian"],
  ["ukr", "ukrainian"],
  ["slk", "slovak"],
  ["slo", "slovak"],
]);

const envelopeSchema = v.object({
  success: v.literal(true),
  data: v.nullish(v.array(v.unknown())),
});

const titleSchema = v.object({ movieId: v.number() });

const rowSchema = v.object({
  subtitleId: v.number(),
  releaseInfo: v.nullish(v.array(v.string())),
  commentary: v.nullish(v.string()),
  framerate: v.nullish(v.union([v.number(), v.string()])),
});

type Row = v.InferOutput<typeof rowSchema>;
type Series = VideoQuery & { type: "series"; season: number; episode: number };

const pad = (value: number) => String(value).padStart(2, "0");

const isSeries = (query: VideoQuery): query is Series =>
  query.type === "series" && query.season !== undefined && query.episode !== undefined;

const rowText = (row: Row) => [...(row.releaseInfo ?? []), row.commentary ?? ""].join(" ");

const matchesEpisode = (query: Series, row: Row) => {
  const text = rowText(row);
  const tag = `S${pad(query.season)}E${pad(query.episode)}`;

  return new RegExp(`${tag}(?!\\d)`, "i").test(text) || !/S\d+E\d+/i.test(text);
};

const toFPS = (framerate: Row["framerate"]) => {
  const value = typeof framerate === "string" ? Number(framerate) : framerate;

  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
};

const toCandidate = (row: Row, lang: string, query: VideoQuery): Candidate => {
  const releaseName = row.releaseInfo?.find((entry) => entry !== "") || row.commentary || undefined;
  const tag = isSeries(query) ? `#S${pad(query.season)}E${pad(query.episode)}` : "";

  return {
    sourceName,
    ref: `${row.subtitleId}${tag}`,
    lang,
    release: parseRelease(releaseName ?? ""),
    releaseName,
    hashMatch: false,
    fps: toFPS(row.framerate),
  };
};

const getData = async (
  path: string,
  params: URLSearchParams,
  apiKey: string,
  signal: AbortSignal,
) => {
  const response = await fetchWithTimeout(
    `${baseURL}${path}?${params}`,
    { headers: { "X-API-Key": apiKey }, signal, maxBytes: maximumSearchBytes },
    searchTimeoutMs,
  );
  const parsed = v.safeParse(envelopeSchema, await response.json().catch(() => undefined));

  return response.ok && parsed.success ? (parsed.output.data ?? []) : [];
};

const findMovieId = async (query: VideoQuery, apiKey: string, signal: AbortSignal) => {
  const params = new URLSearchParams({
    searchType: "imdb",
    imdb: query.imdbId,
    type: query.type === "series" ? "series" : "movie",
    ...(isSeries(query) ? { season: String(query.season) } : {}),
  });
  const data = await getData("/movies/search", params, apiKey, signal);
  const title = v.safeParse(titleSchema, data[0]);

  return title.success ? title.output.movieId : undefined;
};

const listLanguage = async (
  movieId: number,
  [name, lang]: [string, string],
  query: VideoQuery,
  apiKey: string,
  signal: AbortSignal,
): Promise<Candidate[]> => {
  const params = new URLSearchParams({
    movieId: String(movieId),
    language: name,
    page: "1",
    limit: "50",
  });
  const data = await getData("/subtitles", params, apiKey, signal).catch(() => []);

  return data
    .map((row) => v.safeParse(rowSchema, row))
    .flatMap((row) =>
      row.success && (!isSeries(query) || matchesEpisode(query, row.output))
        ? [toCandidate(row.output, lang, query)]
        : [],
    );
};

export const subSourceSource = (apiKey: string): Source => ({
  name: sourceName,
  async search(query, signal) {
    const requested = new Map(
      query.languages.flatMap((lang) => {
        const name = languageNames.get(lang);

        return name === undefined ? [] : [[name, lang] as [string, string]];
      }),
    );

    if (requested.size === 0) {
      return [];
    }

    try {
      const movieId = await findMovieId(query, apiKey, signal);

      if (movieId === undefined) {
        return [];
      }

      const lists = await Promise.all(
        [...requested].map((entry) => listLanguage(movieId, entry, query, apiKey, signal)),
      );

      return lists.flat();
    } catch {
      return [];
    }
  },
  async download(ref, signal) {
    const match = refPattern.exec(ref);

    if (match === null) {
      throw new Error("SubSource download failed");
    }

    const [, id = "", tag] = match;

    try {
      const response = await fetchWithTimeout(
        `${baseURL}/subtitles/${id}/download`,
        { headers: { "X-API-Key": apiKey }, signal, maxBytes: maximumDownloadBytes },
        downloadTimeoutMs,
      );

      if (!response.ok) {
        throw new Error("bad status");
      }

      return pickSubtitleEntry(new Uint8Array(await response.arrayBuffer()), tag);
    } catch {
      throw new Error("SubSource download failed");
    }
  },
});

export const checkSubSource = async (apiKey: string, timeoutMs: number) => {
  const params = new URLSearchParams({ searchType: "imdb", imdb: "tt0111161", type: "movie" });
  const response = await fetchWithTimeout(
    `${baseURL}/movies/search?${params}`,
    { headers: { "X-API-Key": apiKey }, maxBytes: maximumSearchBytes },
    timeoutMs,
  );

  return verdictOf(response, envelopeSchema);
};
