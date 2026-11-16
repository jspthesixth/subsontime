import { createHash } from "node:crypto";
import * as v from "valibot";
import { fetchWithTimeout } from "../http.ts";
import { parseJSON } from "../json.ts";
import { verdictOf } from "./check.ts";
import { parseRelease } from "../subtitles/release.ts";
import {
  maximumDownloadBytes,
  maximumSearchBytes,
  type Candidate,
  type Source,
  type VideoQuery,
} from "./source.ts";
import type { TokenCache } from "./token-cache.ts";
import { pickSubtitleEntry } from "./zip.ts";

const sourceName = "Titlovi.com";
const baseURL = "https://kodi.titlovi.com/api/subtitles";
const downloadURL = "https://titlovi.com/download/";
const searchTimeoutMs = 4000;
const requestTimeoutMs = 8000;
const downloadTimeoutMs = 8000;
const expiryMarginSeconds = 10 * 60;
const minimumTtlSeconds = 60;

const languagePairs: [string, string][] = [
  ["hrv", "Hrvatski"],
  ["srp", "Srpski"],
  ["bos", "Bosanski"],
  ["slv", "Slovenski"],
  ["mkd", "Makedonski"],
  ["eng", "English"],
];

const toTitloviName = new Map(languagePairs);
const toISO6392 = new Map(languagePairs.map(([code, name]) => [name, code]));

const loginSchema = v.object({
  ExpirationDate: v.string(),
  Token: v.string(),
  UserId: v.number(),
});

const sessionSchema = v.object({ token: v.string(), userId: v.number() });
const searchSchema = v.object({ SubtitleResults: v.nullish(v.array(v.unknown())) });

const rowSchema = v.object({
  Id: v.number(),
  Type: v.number(),
  Title: v.string(),
  Release: v.nullish(v.string()),
  Lang: v.string(),
  Season: v.nullish(v.number()),
  Episode: v.nullish(v.number()),
});

type Credentials = { username: string; password: string };
type Session = v.InferOutput<typeof sessionSchema>;
type Row = v.InferOutput<typeof rowSchema>;

const pad = (value: number) => String(value).padStart(2, "0");

const episodeTag = (season: number, episode: number) => `S${pad(season)}E${pad(episode)}`;

const zagrebOffset = (instant: number) =>
  new Intl.DateTimeFormat("en", { timeZone: "Europe/Zagreb", timeZoneName: "longOffset" })
    .formatToParts(instant)
    .find(({ type }) => type === "timeZoneName")
    ?.value.replace("GMT", "") ?? "Z";

const ttlSeconds = (expirationDate: string) => {
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(expirationDate)
    ? expirationDate
    : `${expirationDate}${zagrebOffset(Date.now())}`;
  const seconds = Math.floor((Date.parse(zoned) - Date.now()) / 1000) - expiryMarginSeconds;

  return Math.max(Number.isNaN(seconds) ? 0 : seconds, minimumTtlSeconds);
};

const searchURL = (query: VideoQuery, names: string[], session: Session) => {
  const params = {
    imdbID: query.imdbId,
    json: "true",
    lang: names.map(encodeURIComponent).join("|"),
    token: session.token,
    userid: String(session.userId),
    ...(query.type === "series"
      ? { season: String(query.season), episode: String(query.episode) }
      : {}),
  };
  const queryString = Object.entries(params)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${key === "lang" ? value : encodeURIComponent(value)}`)
    .join("&");

  return `${baseURL}/search?${queryString}`;
};

const matchesEpisode = (query: VideoQuery, row: Row) =>
  query.type !== "series" || (row.Season === query.season && row.Episode === query.episode);

const refOf = (row: Row, query: VideoQuery) =>
  query.type === "series" && typeof row.Season === "number" && typeof row.Episode === "number"
    ? `${row.Type}:${row.Id}:${episodeTag(row.Season, row.Episode)}`
    : `${row.Type}:${row.Id}`;

const refPattern = /^(\d+):(\d+)(?::(S\d{2,}E\d{2,}))?$/;

const toCandidate = (row: Row, query: VideoQuery): Candidate[] => {
  const lang = toISO6392.get(row.Lang);

  if (lang === undefined) {
    return [];
  }

  const releaseName =
    row.Release === null || row.Release === undefined || row.Release === ""
      ? row.Title
      : row.Release;

  return [
    {
      sourceName,
      ref: refOf(row, query),
      lang,
      release: parseRelease(releaseName),
      releaseName,
      hashMatch: false,
      fps: undefined,
    },
  ];
};

const fetchSearch = (query: VideoQuery, names: string[], session: Session, signal: AbortSignal) =>
  fetchWithTimeout(
    searchURL(query, names, session),
    { signal, maxBytes: maximumSearchBytes },
    searchTimeoutMs,
  );

const requestTokenResponse = (
  credentials: Credentials,
  timeoutMs: number,
  signal?: AbortSignal,
) => {
  const params = new URLSearchParams({
    username: credentials.username,
    password: credentials.password,
    json: "true",
  });

  return fetchWithTimeout(
    `${baseURL}/gettoken?${params}`,
    { method: "POST", signal, maxBytes: maximumSearchBytes },
    timeoutMs,
  );
};

const requestToken = async (credentials: Credentials, timeoutMs: number, signal?: AbortSignal) => {
  const response = await requestTokenResponse(credentials, timeoutMs, signal);
  const parsed = v.safeParse(loginSchema, await response.json().catch(() => undefined));

  return response.ok && parsed.success ? parsed.output : undefined;
};

export const checkTitlovi = async (credentials: Credentials, timeoutMs: number) =>
  verdictOf(await requestTokenResponse(credentials, timeoutMs), loginSchema);

export const titloviSource = (credentials: Credentials, tokens: TokenCache): Source => {
  const key = createHash("sha256").update(`titlovi:${credentials.username}`).digest("hex");

  const login = async (signal: AbortSignal): Promise<Session> => {
    const token = await requestToken(credentials, requestTimeoutMs, signal);

    if (token === undefined) {
      throw new Error("Titlovi.com login failed");
    }

    const session = { token: token.Token, userId: token.UserId };

    await tokens.set(key, JSON.stringify(session), ttlSeconds(token.ExpirationDate));

    return session;
  };

  const cachedSession = async (signal: AbortSignal): Promise<Session> => {
    const cached = v.safeParse(sessionSchema, parseJSON((await tokens.get(key)) ?? ""));

    return cached.success ? cached.output : login(signal);
  };

  return {
    name: sourceName,
    async search(query, signal) {
      const names = [
        ...new Set(query.languages.flatMap((lang) => toTitloviName.get(lang) ?? [])),
      ].toSorted();

      if (names.length === 0) {
        return [];
      }

      const first = await fetchSearch(query, names, await cachedSession(signal), signal);
      const response =
        first.status === 401 ? await fetchSearch(query, names, await login(signal), signal) : first;
      const parsed = v.safeParse(searchSchema, await response.json().catch(() => undefined));

      if (!response.ok || !parsed.success) {
        return [];
      }

      return (parsed.output.SubtitleResults ?? [])
        .map((row) => v.safeParse(rowSchema, row))
        .flatMap((row) => (row.success && matchesEpisode(query, row.output) ? [row.output] : []))
        .flatMap((row) => toCandidate(row, query));
    },
    async download(ref, signal) {
      const match = refPattern.exec(ref);

      if (match === null) {
        throw new Error("Titlovi.com download failed");
      }

      const [, type = "", id = "", tag] = match;

      const params = new URLSearchParams({ type, mediaid: id });
      const response = await fetchWithTimeout(
        `${downloadURL}?${params}`,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; SubsOnTime)",
            Referer: "https://titlovi.com",
          },
          signal,
          maxBytes: maximumDownloadBytes,
        },
        downloadTimeoutMs,
      );

      if (!response.ok) {
        throw new Error("Titlovi.com download failed");
      }

      try {
        return pickSubtitleEntry(new Uint8Array(await response.arrayBuffer()), tag);
      } catch {
        throw new Error("Titlovi.com download failed");
      }
    },
  };
};
