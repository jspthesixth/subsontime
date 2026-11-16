import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { del, get, put } from "@vercel/blob";
import type { Context } from "hono";
import * as v from "valibot";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";
import { lookUp, type Summaries } from "./api.ts";
import type { TimingsStore, VideoKey } from "./db.ts";

type DumpDeps = { groupingKey: Buffer; blobToken: string; state: SharedState };

const pageSize = 500;
const lookUpBatch = 8;
const pointerPath = "open-timings-latest.json";
const pointerKey = "open-timings-dump";
const pointerSeconds = 300;
const notConfiguredMessage = "Data dumps are not configured";
const noDumpMessage = "No data dump yet";
const uncached: Summaries = { read: (_, load) => load(), forget: async () => undefined };
const pointerSchema = v.object({
  url: v.string(),
  date: v.pipe(v.string(), v.isoDate()),
  videos: v.number(),
});

type Pointer = v.InferOutput<typeof pointerSchema>;

const pointerOf = (text: string | undefined) => {
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), pointerSchema), text ?? "");

  return parsed.success ? parsed.output : undefined;
};

const readPointer = async (blobToken: string) => {
  const blob = await get(pointerPath, { access: "public", token: blobToken, useCache: false });

  return pointerOf(blob?.statusCode === 200 ? await new Response(blob.stream).text() : undefined);
};

const remember = (state: SharedState, pointer: Pointer) =>
  orMiss(() => state.set(pointerKey, JSON.stringify(pointer), pointerSeconds), undefined);

const batchesOf = (page: VideoKey[]) =>
  Array.from({ length: Math.ceil(page.length / lookUpBatch) }, (_, index) =>
    page.slice(index * lookUpBatch, (index + 1) * lookUpBatch),
  );

// ponytail: one run must finish within maxDuration (300s on Hobby); resume by page if it outgrows that
async function* dumpLines(store: TimingsStore, groupingKey: Buffer) {
  let page: VideoKey[] = [];

  do {
    page = await store.videoPage(page.at(-1), pageSize);

    for (const batch of batchesOf(page)) {
      const looked = await Promise.all(
        batch.map(async (video) => ({
          video,
          timings: await lookUp(store, video, { groupingKey, summaries: uncached }),
        })),
      );

      yield* looked.flatMap(({ video, timings }) =>
        timings.fixes.length > 0 || timings.hidden.length > 0
          ? [`${JSON.stringify({ video: `${video.hash}:${video.size}`, ...timings })}\n`]
          : [],
      );
    }
  } while (page.length === pageSize);
}

export const writeDump = async (
  store: TimingsStore,
  { groupingKey, blobToken, state }: DumpDeps,
  now: Date,
): Promise<Pointer> => {
  const date = now.toISOString().slice(0, 10);
  const blobOptions = { access: "public", addRandomSuffix: false, allowOverwrite: true } as const;
  const gzip = createGzip();
  let videos = 0;

  const counted = async function* () {
    for await (const line of dumpLines(store, groupingKey)) {
      videos += 1;
      yield line;
    }
  };

  const [, dump] = await Promise.all([
    pipeline(Readable.from(counted()), gzip),
    put(`open-timings-${date}.jsonl.gz`, gzip, {
      ...blobOptions,
      cacheControlMaxAge: 3600,
      contentType: "application/gzip",
      multipart: true,
      token: blobToken,
    }),
  ]);

  const pointer = { url: dump.url, date, videos };
  const previous = await readPointer(blobToken);

  await put(pointerPath, JSON.stringify(pointer), {
    ...blobOptions,
    contentType: "application/json",
    token: blobToken,
  });

  await remember(state, pointer);

  if (previous !== undefined && previous.url !== pointer.url) {
    await del(previous.url, { token: blobToken }).catch((error: unknown) =>
      console.error(`Old dump delete failed: ${error instanceof Error ? error.name : "unknown"}`),
    );
  }

  return pointer;
};

export const latestDump = async (state: SharedState, blobToken?: string) => {
  if (blobToken === undefined) {
    return undefined;
  }

  const cached = pointerOf(await orMiss(() => state.get(pointerKey), undefined));

  if (cached !== undefined) {
    return cached;
  }

  const pointer = await readPointer(blobToken);

  if (pointer !== undefined) {
    await remember(state, pointer);
  }

  return pointer;
};

type CronDeps = {
  store: TimingsStore;
  groupingKey: Buffer;
  state: SharedState;
  blobToken?: string;
};

export const dumpCronRoute =
  ({ store, groupingKey, state, blobToken }: CronDeps) =>
  async (context: Context) => {
    if (blobToken === undefined) {
      return context.json({ error: notConfiguredMessage }, 503);
    }

    return context.json(await writeDump(store, { groupingKey, blobToken, state }, new Date()));
  };

export const latestDumpRoute =
  (state: SharedState, blobToken?: string) => async (context: Context) => {
    const pointer = await latestDump(state, blobToken);

    if (pointer === undefined) {
      return context.json({ error: noDumpMessage }, 404);
    }

    context.header("cache-control", "public, max-age=300, s-maxage=300");
    context.header("last-modified", new Date(pointer.date).toUTCString());

    return context.redirect(pointer.url, 302);
  };
