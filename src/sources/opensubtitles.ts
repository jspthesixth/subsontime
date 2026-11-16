import { createHash } from "node:crypto";
import * as v from "valibot";
import packageJSON from "../../package.json" with { type: "json" };
import { fetchWithTimeout } from "../http.ts";
import { toISO6391, toISO6392 } from "../languages.ts";
import { parseRelease } from "../subtitles/release.ts";
import { verdictOf } from "./check.ts";
import {
  maximumDownloadBytes,
  maximumSearchBytes,
  type Candidate,
  type Source,
  type VideoQuery,
} from "./source.ts";
import type { TokenCache } from "./token-cache.ts";

const sourceName = "OpenSubtitles";
const defaultBaseURL = "https://api.opensubtitles.com/api/v1";
const searchTimeoutMs = 4000;
const requestTimeoutMs = 8000;
const tokenTtlSeconds = 12 * 60 * 60;

export const restEntrySchema = v.object({
  attributes: v.object({
    language: v.string(),
    release: v.optional(v.string()),
    fps: v.optional(v.unknown()),
    moviehash_match: v.optional(v.unknown()),
    foreign_parts_only: v.optional(v.unknown()),
    legacy_subtitle_id: v.nullish(v.union([v.number(), v.pipe(v.string(), v.digits())])),
    files: v.array(v.object({ file_id: v.number() })),
  }),
});

const searchSchema = v.object({ data: v.array(v.unknown()) });
const loginSchema = v.object({ token: v.string(), base_url: v.optional(v.string()) });
const sessionSchema = v.object({ token: v.string(), baseURL: v.string() });
const downloadSchema = v.object({ link: v.string() });

export type RESTEntry = v.InferOutput<typeof restEntrySchema>;
type Credentials = { username: string; password: string };
type Session = v.InferOutput<typeof sessionSchema>;

const baseHeaders = (appKey: string) => ({
  "Api-Key": appKey,
  "User-Agent": `SubsOnTime v${packageJSON.version}`,
  Accept: "application/json",
});

const imdbDigits = (imdbId: string) => imdbId.replace(/^tt0*/, "");

export const movieHashOf = (query: VideoQuery) => {
  const hash = query.videoHash?.toLowerCase();

  return hash !== undefined && /^[0-9a-f]{16}$/.test(hash) ? hash : undefined;
};

export const restQueryString = (query: VideoQuery, byDownloads = false) => {
  const languages = [
    ...new Set(query.languages.flatMap((lang) => toISO6391(lang) ?? [])),
  ].toSorted();
  const hash = movieHashOf(query);
  const params = {
    languages: languages.join(","),
    ...(hash === undefined ? {} : { moviehash: hash }),
    ...(byDownloads ? { order_by: "download_count", order_direction: "desc" } : {}),
    ...(query.type === "series"
      ? {
          parent_imdb_id: imdbDigits(query.imdbId),
          season_number: String(query.season),
          episode_number: String(query.episode),
        }
      : { imdb_id: imdbDigits(query.imdbId) }),
  };

  if (languages.length === 0) {
    return undefined;
  }

  return Object.entries(params)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
};

export const searchRESTEntries = async (
  appKey: string,
  queryString: string | undefined,
  signal: AbortSignal,
  timeoutMs = searchTimeoutMs,
): Promise<RESTEntry[] | undefined> => {
  if (queryString === undefined) {
    return [];
  }

  const response = await fetchWithTimeout(
    `${defaultBaseURL}/subtitles?${queryString}`,
    { headers: baseHeaders(appKey), signal, maxBytes: maximumSearchBytes },
    timeoutMs,
  );
  const parsed = v.safeParse(searchSchema, await response.json().catch(() => undefined));

  if (!response.ok || !parsed.success) {
    return undefined;
  }

  return parsed.output.data.flatMap((entry) => {
    const result = v.safeParse(restEntrySchema, entry);

    return result.success ? [result.output] : [];
  });
};

export const restCandidate = (entry: RESTEntry): Candidate[] => {
  const { attributes } = entry;

  const file = attributes.files[0];
  const lang = toISO6392(attributes.language);

  if (file === undefined || lang === undefined) {
    return [];
  }

  const releaseName = attributes.release;
  const fps = typeof attributes.fps === "number" && attributes.fps > 0 ? attributes.fps : undefined;

  return [
    {
      sourceName,
      ref: String(file.file_id),
      lang,
      release: parseRelease(releaseName ?? ""),
      releaseName,
      hashMatch: attributes.moviehash_match === true,
      fps,
      foreignPartsOnly: attributes.foreign_parts_only === true || undefined,
    },
  ];
};

const requestLogin = (user: Credentials, appKey: string, timeoutMs: number, signal?: AbortSignal) =>
  fetchWithTimeout(
    `${defaultBaseURL}/login`,
    {
      method: "POST",
      headers: { ...baseHeaders(appKey), "Content-Type": "application/json" },
      body: JSON.stringify({ username: user.username, password: user.password }),
      signal,
      maxBytes: maximumSearchBytes,
    },
    timeoutMs,
  );

export const checkOpenSubtitles = async (user: Credentials, appKey: string, timeoutMs: number) =>
  verdictOf(await requestLogin(user, appKey, timeoutMs), loginSchema);

export const openSubtitlesSource = (
  credentials: Credentials | undefined,
  appKey: string,
  tokens: TokenCache,
): Source => {
  const login = async (user: Credentials, signal: AbortSignal): Promise<Session> => {
    const key = createHash("sha256").update(user.username).digest("hex");
    const cached = v.safeParse(
      sessionSchema,
      JSON.parse((await tokens.get(key)) ?? "null") as unknown,
    );

    if (cached.success) {
      return cached.output;
    }

    const response = await requestLogin(user, appKey, requestTimeoutMs, signal);
    const parsed = v.safeParse(loginSchema, await response.json().catch(() => undefined));

    if (!response.ok || !parsed.success) {
      throw new Error("OpenSubtitles login failed");
    }

    const session = {
      token: parsed.output.token,
      baseURL:
        parsed.output.base_url === undefined
          ? defaultBaseURL
          : `https://${parsed.output.base_url}/api/v1`,
    };

    await tokens.set(key, JSON.stringify(session), tokenTtlSeconds);

    return session;
  };

  return {
    name: sourceName,
    async search(query, signal) {
      return (
        (await searchRESTEntries(appKey, restQueryString(query), signal))?.flatMap(restCandidate) ??
        []
      );
    },
    async download(ref, signal) {
      const session = credentials === undefined ? undefined : await login(credentials, signal);
      const response = await fetchWithTimeout(
        `${session?.baseURL ?? defaultBaseURL}/download`,
        {
          method: "POST",
          headers: {
            ...baseHeaders(appKey),
            "Content-Type": "application/json",
            ...(session === undefined ? {} : { Authorization: `Bearer ${session.token}` }),
          },
          body: JSON.stringify({ file_id: Number(ref) }),
          signal,
          maxBytes: maximumSearchBytes,
        },
        requestTimeoutMs,
      );
      const parsed = v.safeParse(downloadSchema, await response.json().catch(() => undefined));

      if (!response.ok || !parsed.success) {
        throw new Error(`Download failed with status ${response.status}`);
      }

      const file = await fetchWithTimeout(
        parsed.output.link,
        { signal, maxBytes: maximumDownloadBytes },
        requestTimeoutMs,
      );

      if (!file.ok) {
        throw new Error(`Download failed with status ${file.status}`);
      }

      return new Uint8Array(await file.arrayBuffer());
    },
  };
};
