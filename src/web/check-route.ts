import type { Context } from "hono";
import * as v from "valibot";
import type { RouteDeps } from "../app.ts";
import { configSchema, type Config } from "../config/config.ts";
import { defaultConfig } from "../config/default-config.ts";
import { invalidLinkMessage } from "../config/seal.ts";
import { fetchWithTimeout } from "../http.ts";
import type { Candidate } from "../sources/source.ts";
import { parseStremioId } from "../sources/stremio-addon.ts";
import {
  downloader,
  recordAttempts,
  resolveAttempts,
  servedCues,
  type Attempt,
} from "../stremio/file-route.ts";
import { bestSlotSize, searchVideo, toCandidateRef } from "../stremio/subtitles-route.ts";
import type { RetimeResult } from "../timing/retime.ts";
import { sealedConfigOf, unsealSafely } from "./config-route.ts";
import { languageOptions } from "./language-options.ts";
import { tooManyMessage } from "./source-check-route.ts";

export type CheckRow = {
  lang: string;
  source: string;
  release?: string;
  label: string;
  detail?: string;
  reason?: string;
};

type CheckDeps = RouteDeps & {
  secret: string;
  allow: (key: string) => boolean;
  clientKey: (context: Context) => string;
};

type Retimed = Extract<RetimeResult, { kind: "retimed" }>;
type CatalogType = "movie" | "series";

const budgetMs = 20_000;
const cinemetaURL = "https://v3-cinemeta.strem.io";
const cinemetaTimeoutMs = 4000;
const maximumTitles = 10;
const maximumQueryLength = 100;
const catalogTypes: CatalogType[] = ["movie", "series"];
const imdbIdPattern = /^tt\d+$/;
const invalidCheckMessage = "Pick a film or episode to check";
const unsupportedVideoMessage = "Unsupported video id";
const unreachableCatalogMessage = "Could not reach Stremio's catalog. Try again.";
const mismatchReason =
  "Made for another video. Its dialogue does not line up with this file anywhere.";
const unreadableReason = "Could not be read.";
const catalogCache = { "cache-control": "public, max-age=3600" };

const checkSchema = v.object({
  installURL: v.optional(v.string()),
  languages: v.optional(configSchema.entries.languages),
  type: v.picklist(catalogTypes),
  id: v.pipe(v.string(), v.maxLength(64)),
  videoHash: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{16}$/))),
  videoSize: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  filename: v.optional(v.pipe(v.string(), v.maxLength(512))),
});

const catalogSchema = v.object({
  metas: v.array(
    v.object({ id: v.string(), name: v.string(), releaseInfo: v.optional(v.string()) }),
  ),
});

const seriesSchema = v.object({
  meta: v.object({
    videos: v.optional(
      v.array(
        v.object({
          season: v.number(),
          episode: v.optional(v.number()),
          number: v.optional(v.number()),
          name: v.optional(v.string()),
          title: v.optional(v.string()),
        }),
      ),
      [],
    ),
  }),
});

const languageNames = new Map(languageOptions.map(({ code, name }) => [code, name]));

const nameOf = (code: string) => languageNames.get(code) ?? code;

const seconds = (ms: number) => `${ms < 0 ? "-" : "+"}${Math.abs(ms / 1000).toFixed(2)} s`;

const fpsText = (fps: number) => String(Number(fps.toFixed(3)));

const speedText = (ratio: number, fps: number | undefined) =>
  fps === undefined
    ? `speed ${ratio.toFixed(4)}`
    : `speed ${fpsText(fps)} to ${fpsText(fps / ratio)}`;

const retimedDetail = ({ offsetMs, speedRatio, cuts }: Retimed, fps: number | undefined) =>
  [
    seconds(offsetMs),
    ...(speedRatio === 1 ? [] : [speedText(speedRatio, fps)]),
    ...(cuts > 0 ? [`${cuts} ${cuts === 1 ? "cut" : "cuts"}`] : []),
  ].join(" · ");

const timingOf = ({ result }: Attempt, fps: number | undefined) => {
  switch (result?.kind) {
    case "made-for-file":
      return { label: "Made for this file", detail: "fingerprint match" };
    case "retimed":
      return {
        label: result.byReleaseName ? "Retimed by release name" : "Retimed",
        detail: retimedDetail(result, fps),
      };
    default:
      return { label: "Not retimed" };
  }
};

const madeFor = (candidate: Candidate) => ({
  lang: nameOf(candidate.lang),
  source: candidate.sourceName,
  release: candidate.releaseName,
});

const reasonOf = ({ result }: Attempt) =>
  result?.kind === "mismatch" ? mismatchReason : unreadableReason;

const referenceText = (config: Config, references: Candidate[]) => {
  const first = references[0];

  if (config.timing === "off" || first === undefined) {
    return undefined;
  }

  return `${nameOf(first.lang)}, ${first.hashMatch ? "made for this exact file" : "same release name"}`;
};

const configOf = (installURL: string | undefined, languages: string[], secret: string) => {
  if (installURL === undefined) {
    return defaultConfig(languages);
  }

  const sealed = sealedConfigOf(installURL);

  return sealed === undefined ? undefined : unsealSafely(sealed, secret);
};

const videoOf = (type: string, id: string) => {
  try {
    return parseStremioId(type, id);
  } catch {
    return undefined;
  }
};

const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));

export const checkRoute =
  ({ sourcesFor, secret, allow, clientKey }: CheckDeps) =>
  async (context: Context) => {
    const started = performance.now();

    context.header("Cache-Control", "no-store");

    if (!allow(clientKey(context))) {
      return context.json({ error: tooManyMessage }, 429);
    }

    const body = v.safeParse(checkSchema, await context.req.json().catch(() => undefined), {
      message: invalidCheckMessage,
    });

    if (!body.success) {
      return context.json({ error: body.issues[0].message }, 400);
    }

    const {
      installURL,
      languages = ["eng"],
      type,
      id,
      videoHash,
      videoSize,
      filename,
    } = body.output;
    const config = configOf(installURL, languages, secret);
    const video = videoOf(type, id);

    if (config === undefined) {
      return context.json({ error: invalidLinkMessage }, 400);
    }

    if (video === undefined) {
      return context.json({ error: unsupportedVideoMessage }, 400);
    }

    const sources = sourcesFor(config);
    const found = await searchVideo(sources, {
      ...video,
      videoHash,
      videoSize,
      filename,
      languages: config.languages,
    });
    const searchedMs = Math.round(performance.now() - started);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs - searchedMs);
    const download = downloader(sources, controller.signal);
    const references = found.references.map(toCandidateRef);
    const slots = config.languages.map((lang) => {
      const candidates = found.ranked(lang).slice(0, bestSlotSize);
      const attempts: Attempt[] = [];

      return { candidates, attempts };
    });
    const runs = slots.map(({ candidates, attempts }) =>
      recordAttempts(
        resolveAttempts(
          { c: candidates.map(toCandidateRef), x: references },
          config,
          download,
          controller.signal,
        ),
        attempts,
      ),
    );

    await Promise.race([Promise.all(runs), aborted(controller.signal)]);
    clearTimeout(timer);
    controller.abort();

    const tried = slots.flatMap(({ candidates, attempts }) =>
      attempts.flatMap((attempt, index) => {
        const candidate = candidates[index];

        return candidate === undefined ? [] : [{ candidate, attempt }];
      }),
    );
    const shown: CheckRow[] = tried.flatMap(({ candidate, attempt }) =>
      servedCues(attempt, config) === undefined
        ? []
        : [{ ...madeFor(candidate), ...timingOf(attempt, candidate.fps) }],
    );
    const leftOut: CheckRow[] = tried.flatMap(({ candidate, attempt }) =>
      servedCues(attempt, config) === undefined
        ? [{ ...madeFor(candidate), label: "Not retimed", reason: reasonOf(attempt) }]
        : [],
    );

    return context.json({
      shown,
      leftOut,
      reference: referenceText(config, found.references),
      searchedMs,
      sources: sources.listed.length + sources.references.length,
    });
  };

const searchCatalog = async (type: CatalogType, query: string) => {
  const response = await fetchWithTimeout(
    `${cinemetaURL}/catalog/${type}/top/search=${encodeURIComponent(query)}.json`,
    {},
    cinemetaTimeoutMs,
  );

  if (!response.ok) {
    throw new Error(`Cinemeta answered ${response.status}`);
  }

  const { metas } = v.parse(catalogSchema, await response.json());

  return metas
    .filter((meta) => imdbIdPattern.test(meta.id))
    .map(({ id, name, releaseInfo }) => ({
      id,
      type,
      name,
      year: releaseInfo?.match(/^\d{4}/)?.[0],
    }));
};

export const titlesRoute = async (context: Context) => {
  const query = (context.req.query("q") ?? "").trim().slice(0, maximumQueryLength);
  const type = context.req.query("type");
  const types = catalogTypes.filter((each) => type === undefined || each === type);

  if (query === "") {
    return context.json([], 200, catalogCache);
  }

  const results = await Promise.allSettled(types.map((each) => searchCatalog(each, query)));
  const lists = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));

  if (lists.length === 0) {
    return context.json({ error: unreachableCatalogMessage }, 502);
  }

  const interleaved = Array.from({ length: maximumTitles }, (_, index) =>
    lists.flatMap((list) => list.slice(index, index + 1)),
  ).flat();

  return context.json(interleaved.slice(0, maximumTitles), 200, catalogCache);
};

export const episodesRoute = async (context: Context) => {
  const id = context.req.param("id") ?? "";

  if (!imdbIdPattern.test(id)) {
    return context.json({ error: unsupportedVideoMessage }, 400);
  }

  const meta = await fetchWithTimeout(
    `${cinemetaURL}/meta/series/${id}.json`,
    {},
    cinemetaTimeoutMs,
  )
    .then(async (response) => v.parse(seriesSchema, await response.json()).meta)
    .catch(() => undefined);

  if (meta === undefined) {
    return context.json({ error: unreachableCatalogMessage }, 502);
  }

  const episodes = meta.videos
    .flatMap(({ season, episode, number, name, title }) => {
      const episodeNumber = episode ?? number;

      return episodeNumber === undefined
        ? []
        : [{ season, episode: episodeNumber, name: name ?? title ?? "" }];
    })
    .toSorted((a, b) => a.season - b.season || a.episode - b.episode);

  return context.json(episodes, 200, catalogCache);
};
