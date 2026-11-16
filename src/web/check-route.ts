import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import * as v from "valibot";
import type { RouteDeps } from "../app.ts";
import { languagesSchema, type Config } from "../config/config.ts";
import { defaultConfig } from "../config/default-config.ts";
import { invalidLinkMessage } from "../config/seal.ts";
import { fetchWithTimeout } from "../http.ts";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";
import type { SourceSet } from "../sources/from-config.ts";
import { maximumSearchBytes, type Candidate, type VideoQuery } from "../sources/source.ts";
import { parseStremioId } from "../sources/stremio-addon.ts";
import { installKeyOf, tokenCacheFor } from "../sources/token-cache.ts";
import {
  downloader,
  recordAttempts,
  resolveAttempts,
  servedCues,
  type Attempt,
} from "../stremio/file-route.ts";
import {
  checkShared,
  hashesOf,
  videoKeyOf,
  viewerOf,
  type Hidden,
  type OpenTimings,
  type Shared,
} from "../stremio/open-timings.ts";
import { decodeRef, encodeRef } from "../stremio/refs.ts";
import {
  bestGroupsOf,
  bestSlotSize,
  searchVideo,
  toCandidateRef,
} from "../stremio/subtitles-route.ts";
import type { RetimeResult } from "../timing/retime.ts";
import { reportReasons, submitReport, TimingsInputError } from "../timings/api.ts";
import type { VideoKey } from "../timings/db.ts";
import { submitterOf } from "../timings/submitter.ts";
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
  playsFirst?: boolean;
  ref?: string;
};

type LimitDeps = {
  allow: (key: string) => Promise<boolean>;
  clientKey: (context: Context) => string;
};

type CheckDeps = RouteDeps & LimitDeps & { secret: string; state: SharedState };
type ReportDeps = CheckDeps & { openTimings: OpenTimings };

type Retimed = Extract<RetimeResult, { kind: "retimed" }>;
type SharedFix = Extract<RetimeResult, { kind: "shared-fix" }>;
type Slot =
  | { status: "taken"; key: string; holder: string }
  | { status: "busy" }
  | { status: "unknown" };
type CatalogType = "movie" | "series";

const budgetMs = 20_000;
const maximumRunning = 2;
const slotSeconds = 30;
const slotRefreshMs = 10_000;
const cinemetaURL = "https://v3-cinemeta.strem.io";
const cinemetaTimeoutMs = 4000;
const maximumTitles = 10;
const maximumQueryLength = 100;
const catalogTypes: CatalogType[] = ["movie", "series"];
const imdbIdPattern = /^tt\d+$/;
const invalidCheckMessage = "Pick a film or episode to check";
const unsupportedVideoMessage = "Unsupported video id";
const unreachableCatalogMessage = "Could not reach Stremio's catalog. Try again.";
const busyMessage = "Busy, try again in a moment";
const tooManySearchesMessage = "Too many searches. Try again in a minute.";
const mismatchReason =
  "Made for another video. Its dialogue does not line up with this file anywhere.";
const unreadableReason = "Could not be read.";
const tooManyReportsMessage = "Too many reports. Try again in a minute.";
const invalidReportMessage = "Pick what is wrong with this subtitle";
const invalidRefMessage = "Invalid subtitle reference";
const unreadableReportMessage = "We could not read this subtitle, so it cannot be reported.";
const unavailableMessage = "Try again in a moment";
const catalogCache = { "cache-control": "public, max-age=3600" };

const checkSchema = v.object({
  installURL: v.optional(v.string()),
  languages: v.optional(languagesSchema),
  type: v.picklist(catalogTypes),
  id: v.pipe(v.string(), v.maxLength(64)),
  videoHash: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{16}$/))),
  videoSize: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  filename: v.optional(v.pipe(v.string(), v.maxLength(512))),
});

const reportBodySchema = v.object({
  ref: v.string(),
  reason: v.picklist(reportReasons),
  installURL: v.optional(v.string()),
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
    ? `speed ×${ratio.toFixed(4)}`
    : `speed ${fpsText(fps)} to ${fpsText(fps * ratio)}`;

const retimedDetail = ({ offsetMs, speedRatio, cuts }: Retimed, fps: number | undefined) =>
  [
    seconds(offsetMs),
    ...(speedRatio === 1 ? [] : [speedText(speedRatio, fps)]),
    ...(cuts > 0 ? [`${cuts} ${cuts === 1 ? "cut" : "cuts"}`] : []),
  ].join(" · ");

const sharedFixDetail = ({ agreeing, fromAudio }: SharedFix) =>
  [`${agreeing} agree`, ...(fromAudio ? ["from audio"] : [])].join(" · ");

const timingOf = ({ result }: Attempt, fps: number | undefined) => {
  switch (result?.kind) {
    case "made-for-file":
      return { label: "Made for this file", detail: "fingerprint match" };
    case "retimed":
      return {
        label: result.byReleaseName ? "Retimed by release name" : "Retimed",
        detail: retimedDetail(result, fps),
      };
    case "shared-fix":
      return { label: "Shared fix, confirmed", detail: sharedFixDetail(result) };
    case "mismatch":
      return { label: "Not retimed", detail: mismatchReason };
    default:
      return { label: "Not retimed" };
  }
};

const madeFor = (candidate: Candidate) => ({
  lang: nameOf(candidate.lang),
  source: candidate.sourceName,
  release: candidate.releaseName,
});

const hiddenReason = ({ reason = "mismatch" }: Hidden) =>
  reason === "mismatch"
    ? "Hidden by Open Timings: made for another video."
    : `Hidden by Open Timings: reported as ${reason.replaceAll("-", " ")}.`;

export const reasonOf = ({ result, hidden }: Attempt) => {
  if (hidden !== undefined) {
    return hiddenReason(hidden);
  }

  return result?.kind === "mismatch" ? mismatchReason : unreadableReason;
};

const referenceText = (config: Config, references: Candidate[]) => {
  const first = references[0];

  if (config.timing === "off" || first === undefined) {
    return undefined;
  }

  return `${nameOf(first.lang)}, ${first.hashMatch ? "made for this exact file" : "same release name"}`;
};

const installOf = (installURL: string | undefined, languages: string[], secret: string) => {
  if (installURL === undefined) {
    return { config: defaultConfig(languages), sealed: "" };
  }

  const sealed = sealedConfigOf(installURL) ?? "";
  const config = unsealSafely(sealed, secret);

  return config === undefined ? undefined : { config, sealed };
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

const runCheck = async (
  config: Config,
  sources: SourceSet,
  query: VideoQuery,
  started: number,
  sharing: Promise<Shared | undefined>,
  refOf: (candidate: Candidate) => string | undefined,
) => {
  const [found, shared] = await Promise.all([searchVideo(sources, query), sharing]);

  const searchedMs = Math.round(performance.now() - started);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs - searchedMs);
  const download = downloader(sources, controller.signal);
  const references = found.references.map(toCandidateRef);
  const bestOf = new Map(
    config.languages.map((lang) => [lang, bestGroupsOf(found, lang)[0] ?? []] as const),
  );
  const entries = config.languages.flatMap((lang) =>
    found
      .ranked(lang)
      .filter((candidate, index) => index < bestSlotSize || bestOf.get(lang)?.includes(candidate))
      .map((candidate) => {
        const attempts: Attempt[] = [];

        return { candidate, attempts };
      }),
  );
  const runs = entries.map(({ candidate, attempts }) =>
    recordAttempts(
      resolveAttempts(
        { c: [toCandidateRef(candidate)], x: references },
        config,
        download,
        controller.signal,
        shared,
        { served: false },
      ),
      attempts,
    ),
  );

  await Promise.race([Promise.all(runs), aborted(controller.signal)]);
  clearTimeout(timer);
  controller.abort();

  const tried = entries.flatMap(({ candidate, attempts }) =>
    attempts.map((attempt) => ({ candidate, attempt })),
  );
  const served = tried.filter(({ attempt }) => servedCues(attempt, config) !== undefined);
  const playsFirst = new Set(
    config.bestOnly
      ? config.languages.flatMap((lang) =>
          served
            .filter(({ candidate }) => bestOf.get(lang)?.includes(candidate) === true)
            .slice(0, 1),
        )
      : [],
  );
  const shown: CheckRow[] = served.map((entry) => {
    const ref = refOf(entry.candidate);

    return {
      ...madeFor(entry.candidate),
      ...timingOf(entry.attempt, entry.candidate.fps),
      ...(playsFirst.has(entry) ? { playsFirst: true } : {}),
      ...(ref === undefined ? {} : { ref }),
    };
  });
  const leftOut: CheckRow[] = tried
    .filter((entry) => !served.includes(entry))
    .map(({ candidate, attempt }) => ({
      ...madeFor(candidate),
      label: "Not retimed",
      reason: reasonOf(attempt),
    }));

  return {
    shown,
    leftOut,
    reference: referenceText(config, found.references),
    searchedMs,
    sources: sources.listed.length + sources.references.length,
  };
};

const takeSlot = async (state: SharedState, holder: string, index = 0): Promise<Slot> => {
  if (index >= maximumRunning) {
    return { status: "busy" };
  }

  const key = `slot:check:${index}`;
  const taken = await orMiss(() => state.setIfAbsent(key, holder, slotSeconds), undefined);

  if (taken === undefined) {
    return { status: "unknown" };
  }

  return taken ? { status: "taken", key, holder } : takeSlot(state, holder, index + 1);
};

const hold = (state: SharedState, slot: Slot) => {
  if (slot.status !== "taken") {
    return async () => {};
  }

  const { key, holder } = slot;

  const refresh = setInterval(
    () => void orMiss(() => state.expireIfEquals(key, holder, slotSeconds), false),
    slotRefreshMs,
  ).unref();

  return async () => {
    clearInterval(refresh);
    await orMiss(() => state.deleteIfEquals(key, holder), false);
  };
};

const reportRefOf =
  (refKey: Buffer, { type, imdbId, season, episode }: VideoQuery, video: VideoKey) =>
  (candidate: Candidate) =>
    encodeRef(
      {
        v: 1,
        q: { t: type, i: imdbId, s: season, e: episode },
        c: [toCandidateRef(candidate)],
        x: [],
        w: { h: video.hash, z: video.size },
      },
      refKey,
    );

export const checkRoute =
  ({ sourcesFor, secret, refKey, allow, clientKey, state, openTimings }: CheckDeps) =>
  async (context: Context) => {
    const started = performance.now();

    context.header("Cache-Control", "no-store");

    if (!(await allow(clientKey(context)))) {
      return context.json({ error: tooManyMessage }, 429);
    }

    const body = v.safeParse(checkSchema, await context.req.json().catch(() => undefined), {
      message: invalidCheckMessage,
    });

    if (!body.success) {
      return context.json({ error: body.issues[0].message }, 400);
    }

    const { installURL, languages = ["eng"], type, id, ...file } = body.output;

    const install = installOf(installURL, languages, secret);
    const video = videoOf(type, id);

    if (install === undefined) {
      return context.json({ error: invalidLinkMessage }, 400);
    }

    if (video === undefined) {
      return context.json({ error: unsupportedVideoMessage }, 400);
    }

    const slot = await takeSlot(state, randomUUID());

    if (slot.status === "busy") {
      return context.json({ error: busyMessage }, 429);
    }

    const release = hold(state, slot);
    const { config, sealed } = install;

    const tokens = tokenCacheFor(state, secret, installKeyOf(sealed));
    const fingerprint = videoKeyOf(file.videoHash, file.videoSize);
    const sharing =
      openTimings === undefined || fingerprint === undefined || !config.useShared
        ? Promise.resolve(undefined)
        : checkShared(openTimings, fingerprint, viewerOf(config, openTimings.installSalt));

    const query = { ...video, ...file, languages: config.languages };
    const refOf =
      openTimings === undefined || fingerprint === undefined
        ? () => undefined
        : reportRefOf(refKey, query, fingerprint);

    try {
      return context.json(
        await runCheck(config, sourcesFor(config, tokens), query, started, sharing, refOf),
      );
    } finally {
      await release();
    }
  };

const reportedOf = (ref: string, refKey: Buffer) => {
  try {
    const { c, w } = decodeRef(ref, refKey);

    const candidate = c[0];

    return candidate === undefined || w === undefined
      ? undefined
      : { candidate, video: { hash: w.h, size: w.z } };
  } catch {
    return undefined;
  }
};

export const checkReportRoute =
  ({ sourcesFor, secret, refKey, allow, clientKey, state, openTimings }: ReportDeps) =>
  async (context: Context) => {
    const client = clientKey(context);

    if (!(await allow(client))) {
      return context.json({ error: tooManyReportsMessage }, 429);
    }

    const body = v.safeParse(reportBodySchema, await context.req.json().catch(() => undefined), {
      message: invalidReportMessage,
    });

    if (!body.success) {
      return context.json({ error: body.issues[0].message }, 400);
    }

    const { ref, reason, installURL } = body.output;

    const reported = reportedOf(ref, refKey);
    const install = installOf(installURL, [], secret);

    if (reported === undefined) {
      return context.json({ error: invalidRefMessage }, 400);
    }

    if (install === undefined) {
      return context.json({ error: invalidLinkMessage }, 400);
    }

    const { config, sealed } = install;

    const { store, installSalt, originOf, summaries } = openTimings;

    const tokens = tokenCacheFor(state, secret, installKeyOf(sealed));
    const subtitleHashes = await downloader(sourcesFor(config, tokens))(reported.candidate)
      .then((track) => hashesOf(track.cues))
      .catch(() => []);

    if (subtitleHashes.length === 0) {
      return context.json({ error: unreadableReportMessage }, 422);
    }

    const origin = await orMiss(() => originOf(client), undefined);

    if (origin === undefined) {
      return context.json({ error: unavailableMessage }, 503);
    }

    try {
      await submitReport(
        store,
        { video: reported.video, subtitleHashes, reason },
        { submitter: submitterOf(config.installId, installSalt), origin, summaries },
      );
    } catch (error) {
      if (error instanceof TimingsInputError) {
        return context.json({ error: error.message }, 400);
      }

      throw error;
    }

    return context.json({ ok: true }, 202);
  };

export const searchCatalog = async (type: CatalogType, query: string) => {
  const response = await fetchWithTimeout(
    `${cinemetaURL}/catalog/${type}/top/search=${encodeURIComponent(query)}.json`,
    { maxBytes: maximumSearchBytes },
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

const matchRank = (name: string, query: string) => {
  const folded = name.toLocaleLowerCase();

  if (folded === query) {
    return 0;
  }

  return folded.startsWith(query) ? 1 : 2;
};

const limited =
  ({ allow, clientKey }: LimitDeps, route: (context: Context) => Promise<Response>) =>
  async (context: Context) =>
    (await allow(clientKey(context)))
      ? route(context)
      : context.json({ error: tooManySearchesMessage }, 429);

const searchTitles = async (context: Context) => {
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

  const folded = query.toLocaleLowerCase();
  const ranked = interleaved.toSorted(
    (a, b) => matchRank(a.name, folded) - matchRank(b.name, folded),
  );

  return context.json(ranked.slice(0, maximumTitles), 200, catalogCache);
};

const listEpisodes = async (context: Context) => {
  const id = context.req.param("id") ?? "";

  if (!imdbIdPattern.test(id)) {
    return context.json({ error: unsupportedVideoMessage }, 400);
  }

  const meta = await fetchWithTimeout(
    `${cinemetaURL}/meta/series/${id}.json`,
    { maxBytes: maximumSearchBytes },
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

export const titlesRoute = (deps: LimitDeps) => limited(deps, searchTitles);

export const episodesRoute = (deps: LimitDeps) => limited(deps, listEpisodes);
