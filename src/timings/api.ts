import * as v from "valibot";
import { summarize, type VideoTimings } from "./confirm.ts";
import type { TimingsStore } from "./db.ts";

export class TimingsInputError extends Error {
  override name = "TimingsInputError";
}

type WriteContext = { submitter: string };

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

export const submitFix = async (
  store: TimingsStore,
  input: unknown,
  { submitter }: WriteContext,
) => {
  const { video, subtitle, method, referenceKey } = parse(fixSchema, input);

  await store.putFix({
    video,
    subtitleHashes: subtitle.map((cue) => cue.h),
    cues: subtitle,
    method,
    referenceKey,
    submitter,
  });
};

export const submitMismatch = async (
  store: TimingsStore,
  input: unknown,
  { submitter }: WriteContext,
) => {
  const { video, subtitleHashes } = parse(mismatchSchema, input);

  await store.putMismatch({ video, subtitleHashes, submitter });
};

export const submitReport = async (
  store: TimingsStore,
  input: unknown,
  { submitter }: WriteContext,
) => {
  const { video, subtitleHashes, reason } = parse(reportSchema, input);

  await store.putReport({ video, subtitleHashes, reason, submitter });
};

export const lookUp = async (
  store: TimingsStore,
  video: unknown,
  viewer?: string,
): Promise<VideoTimings> => {
  const key = parse(videoSchema, video, videoMessage);
  const [fixes, mismatches, reports] = await Promise.all([
    store.fixesFor(key),
    store.mismatchesFor(key),
    store.reportsFor(key),
  ]);

  return summarize(fixes, mismatches, reports, viewer);
};
