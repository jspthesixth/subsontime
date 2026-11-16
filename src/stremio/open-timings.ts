import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import * as v from "valibot";
import type { Config } from "../config/config.ts";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";
import { parseJSON } from "../json.ts";
import type { Cue } from "../subtitles/cue.ts";
import type { RetimeResult } from "../timing/retime.ts";
import { lookUp, type Summaries } from "../timings/api.ts";
import { applyFix } from "../timings/apply-fix.ts";
import type { FixWithCues, HiddenView, VideoTimings } from "../timings/confirm.ts";
import type { TimingsStore, VideoKey } from "../timings/db.ts";
import { cueHashes, sketchSimilarity, type CueHash } from "../timings/fingerprint.ts";
import { submitterOf } from "../timings/submitter.ts";

export type OpenTimings = {
  store: TimingsStore;
  installSalt: string;
  groupingKey: Buffer;
  originOf: (clientKey: string) => Promise<string>;
  summaries?: Summaries;
};

export type Hidden = { subtitleSketch: CueHash[]; reason?: HiddenView["reason"] };

export type Shared = { hidden: Hidden[]; confirmed: () => Promise<FixWithCues[]> };

const readBudgetMs = 300;
const sameSubtitleShare = 0.9;
const maximumHidden = 10;
const hiddenSeconds = 3700;
const videoHashPattern = /^[0-9a-f]{16}$/;
const sketchesSchema = v.array(v.array(v.string()));

export const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

export const withinBudget = async <T>(work: Promise<T>): Promise<T | undefined> => {
  const timer = new AbortController();
  const settled = work.catch((error: unknown) => {
    console.error(`Open Timings read failed: ${errorName(error)}`);

    return undefined;
  });

  try {
    return await Promise.race([
      settled,
      sleep(readBudgetMs, undefined, { signal: timer.signal, ref: false }),
    ]);
  } finally {
    timer.abort();
  }
};

export const viewerOf = (config: Config, installSalt: string) => {
  try {
    return submitterOf(config.installId, installSalt);
  } catch {
    return undefined;
  }
};

export const videoKeyOf = (hash?: string, size?: number): VideoKey | undefined =>
  hash !== undefined &&
  videoHashPattern.test(hash) &&
  size !== undefined &&
  Number.isSafeInteger(size) &&
  size >= 1
    ? { hash, size }
    : undefined;

export const hashesOf = (cues: Cue[]) => cueHashes(cues).filter((hash) => hash !== undefined);

const sameSubtitle = (hashes: CueHash[], sketch: CueHash[]) =>
  sketchSimilarity(hashes, sketch) >= sameSubtitleShare;

const timingsOf = (
  { store, groupingKey, summaries }: OpenTimings,
  video: VideoKey,
  viewer: string | undefined,
) => withinBudget(lookUp(store, video, { groupingKey, viewer, summaries, withCues: true }));

const confirmedOf = (timings: VideoTimings<FixWithCues> | undefined) =>
  (timings?.fixes ?? []).filter((view) => view.status === "confirmed");

const storeHidden = async (
  { store, groupingKey, summaries }: OpenTimings,
  state: SharedState,
  video: VideoKey,
  viewer: string | undefined,
) => {
  const { hidden } = await lookUp(store, video, { groupingKey, viewer, summaries });

  const sketches = hidden.slice(0, maximumHidden).map((entry) => entry.subtitleSketch);

  if (sketches.length === 0) {
    return undefined;
  }

  const text = JSON.stringify(sketches);
  const key = `hid:${video.hash}:${video.size}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;

  await orMiss(() => state.set(key, text, hiddenSeconds), undefined);

  return key;
};

export const hiddenKeyFor = (
  openTimings: OpenTimings,
  state: SharedState,
  video: VideoKey,
  viewer: string | undefined,
) => withinBudget(storeHidden(openTimings, state, video, viewer));

export const fileShared = async (
  openTimings: OpenTimings,
  state: SharedState,
  video: VideoKey,
  viewer: string | undefined,
  hiddenKey: string | undefined,
): Promise<Shared> => {
  const stored =
    hiddenKey === undefined
      ? undefined
      : await withinBudget(orMiss(() => state.get(hiddenKey), undefined));
  const sketches = v.safeParse(sketchesSchema, parseJSON(stored ?? "[]"));
  let confirmed: Promise<FixWithCues[]> | undefined;

  return {
    hidden: sketches.success ? sketches.output.map((subtitleSketch) => ({ subtitleSketch })) : [],
    confirmed: () => {
      confirmed ??= timingsOf(openTimings, video, viewer).then(confirmedOf);

      return confirmed;
    },
  };
};

export const checkShared = async (
  openTimings: OpenTimings,
  video: VideoKey,
  viewer: string | undefined,
): Promise<Shared> => {
  const timings = await timingsOf(openTimings, video, viewer);
  const confirmed = confirmedOf(timings);

  return { hidden: timings?.hidden ?? [], confirmed: async () => confirmed };
};

export const hiddenMatch = (cues: Cue[], shared: Shared | undefined) => {
  const hidden = shared?.hidden ?? [];

  if (hidden.length === 0) {
    return undefined;
  }

  const hashes = hashesOf(cues);

  return hidden.find((entry) => sameSubtitle(hashes, entry.subtitleSketch));
};

export const sharedFix = async (
  cues: Cue[],
  shared: Shared | undefined,
): Promise<RetimeResult | undefined> => {
  if (shared === undefined) {
    return undefined;
  }

  const hashes = hashesOf(cues);
  const view = (await shared.confirmed()).find((each) => sameSubtitle(hashes, each.subtitleSketch));
  const fixed = view === undefined ? undefined : applyFix(cues, view.cues);

  if (view === undefined || fixed === undefined) {
    return undefined;
  }

  return {
    kind: "shared-fix",
    cues: fixed.cues,
    agreeing: view.agreeing,
    fromAudio: view.fromAudio,
  };
};
