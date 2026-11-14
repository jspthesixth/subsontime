import * as v from "valibot";
import {
  digest,
  present,
  publicTimings,
  type Digest,
  type FixWithCues,
  type VideoTimings,
} from "./confirm.ts";
import type { TimingsStore, VideoKey } from "./db.ts";

export class TimingsInputError extends Error {
  override name = "TimingsInputError";
}

export type WriteContext = { submitter: string; origin: string };

const bodyMessage = "Send a JSON object";
const videoMessage = "Send video as a 16-character hex hash and a size in bytes";
const messages: Record<string, string> = {
  video: videoMessage,
  subtitle:
    "Send subtitle as 1 to 5000 cues, each a 16-character hex hash with start and end times in order",
  subtitleHashes: "Send subtitleHashes as 1 to 5000 16-character hex hashes",
  method: "Send method as audio, reference or release-name",
  referenceKey: "Send referenceKey as 1 to 8 comma-separated 16-character hex hashes",
  reason:
    "Send reason as machine-translated, wrong-language, lines-missing, timing-off or broken-characters",
};
const maxCues = 5000;
const dayMs = 86_400_000;

const cueHashSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{16}$/));
const timeSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(dayMs));
const videoSchema = v.object({
  hash: cueHashSchema,
  size: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER)),
});
const cueSchema = v.pipe(
  v.object({ h: cueHashSchema, s: timeSchema, e: timeSchema }),
  v.check((cue) => cue.s <= cue.e),
);
const hashListSchema = v.pipe(v.array(cueHashSchema), v.minLength(1), v.maxLength(maxCues));
const fixSchema = v.object({
  video: videoSchema,
  subtitle: v.pipe(
    v.array(cueSchema),
    v.minLength(1),
    v.maxLength(maxCues),
    v.check((cues) => cues.slice(1).every((cue, index) => (cues[index]?.s ?? 0) <= cue.s)),
  ),
  method: v.picklist(["audio", "reference", "release-name"]),
  referenceKey: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{16}(,[0-9a-f]{16}){0,7}$/))),
});
const mismatchSchema = v.object({ video: videoSchema, subtitleHashes: hashListSchema });
const reportSchema = v.object({
  ...mismatchSchema.entries,
  reason: v.picklist([
    "machine-translated",
    "wrong-language",
    "lines-missing",
    "timing-off",
    "broken-characters",
  ]),
});

const parse = <Schema extends v.GenericSchema>(
  schema: Schema,
  input: unknown,
  fallback = bodyMessage,
): v.InferOutput<Schema> => {
  const result = v.safeParse(schema, input, { abortEarly: true });

  if (!result.success) {
    const field = String(result.issues[0].path?.[0]?.key ?? "");

    throw new TimingsInputError(messages[field] ?? fallback);
  }

  return result.output;
};

const cacheMs = 300_000;
const maxCachedVideos = 1000;
const maxCachedCues = 2_000_000;

type CacheEntry = { at: number; digest: Promise<Digest>; cues: number };

const caches = new WeakMap<TimingsStore, Map<string, CacheEntry>>();

const cacheOf = (store: TimingsStore) => {
  const cache = caches.get(store) ?? new Map<string, CacheEntry>();

  caches.set(store, cache);

  return cache;
};

const cacheKey = (video: VideoKey) => `${video.hash}:${video.size}`;

const forget = (store: TimingsStore, video: VideoKey) => cacheOf(store).delete(cacheKey(video));

const cuesIn = (sections: Digest) =>
  sections.reduce((total, section) => total + (section.fixView?.view.cues.length ?? 0), 0);

const dropExpired = (cache: Map<string, CacheEntry>, now: number) =>
  [...cache].filter(([, entry]) => now - entry.at >= cacheMs).forEach(([key]) => cache.delete(key));

const keepWithinBudget = (cache: Map<string, CacheEntry>) => {
  let held = 0;

  [...cache].toReversed().forEach(([key, entry], index) => {
    held += entry.cues;

    if (index >= maxCachedVideos || held > maxCachedCues) {
      cache.delete(key);
    }
  });
};

const read = async (store: TimingsStore, video: VideoKey, groupingKey: Buffer) => {
  const [fixes, mismatches, reports] = await Promise.all([
    store.fixesFor(video),
    store.mismatchesFor(video),
    store.reportsFor(video),
  ]);

  return digest(fixes, mismatches, reports, groupingKey);
};

const cachedDigest = (store: TimingsStore, video: VideoKey, groupingKey: Buffer) => {
  const cache = cacheOf(store);
  const key = cacheKey(video);
  const now = Date.now();

  dropExpired(cache, now);

  const cached = cache.get(key);

  if (cached !== undefined) {
    return cached.digest;
  }

  const entry: CacheEntry = { at: now, digest: read(store, video, groupingKey), cues: 0 };

  cache.set(key, entry);
  keepWithinBudget(cache);
  entry.digest.then(
    (sections) => {
      entry.cues = cuesIn(sections);
      keepWithinBudget(cache);
    },
    () => {
      if (cache.get(key) === entry) {
        cache.delete(key);
      }
    },
  );

  return entry.digest;
};

export const submitFix = async (
  store: TimingsStore,
  input: unknown,
  { submitter, origin }: WriteContext,
) => {
  const { video, subtitle, method, referenceKey } = parse(fixSchema, input);

  await store.putFix({
    video,
    subtitleHashes: subtitle.map((cue) => cue.h),
    cues: subtitle,
    method,
    referenceKey,
    submitter,
    origin,
  });
  forget(store, video);
};

export const submitMismatch = async (
  store: TimingsStore,
  input: unknown,
  { submitter, origin }: WriteContext,
) => {
  const { video, subtitleHashes } = parse(mismatchSchema, input);

  await store.putMismatch({ video, subtitleHashes, submitter, origin });
  forget(store, video);
};

export const submitReport = async (
  store: TimingsStore,
  input: unknown,
  { submitter, origin }: WriteContext,
) => {
  const { video, subtitleHashes, reason } = parse(reportSchema, input);

  await store.putReport({ video, subtitleHashes, reason, submitter, origin });
  forget(store, video);
};

type LookUpOptions = { groupingKey: Buffer; viewer?: string; withCues?: boolean };

export async function lookUp(
  store: TimingsStore,
  video: unknown,
  options: LookUpOptions & { withCues?: false },
): Promise<VideoTimings>;
export async function lookUp(
  store: TimingsStore,
  video: unknown,
  options: LookUpOptions & { withCues: true },
): Promise<VideoTimings<FixWithCues>>;
export async function lookUp(
  store: TimingsStore,
  video: unknown,
  { groupingKey, viewer, withCues = false }: LookUpOptions,
): Promise<VideoTimings | VideoTimings<FixWithCues>> {
  const timings = present(
    await cachedDigest(store, parse(videoSchema, video, videoMessage), groupingKey),
    viewer,
  );

  return withCues ? timings : publicTimings(timings);
}
