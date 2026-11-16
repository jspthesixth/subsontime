import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { get, put } from "@vercel/blob";
import type { Context } from "hono";
import * as v from "valibot";
import { parseJSON } from "../json.ts";
import { lookUp, type Summaries } from "./api.ts";
import type { TimingsStore, VideoKey } from "./db.ts";

type DumpDeps = { groupingKey: Buffer; blobToken: string };

const pageSize = 500;
const pointerPath = "open-timings-latest.json";
const notConfiguredMessage = "Data dumps are not configured";
const noDumpMessage = "No data dump yet";
const uncached: Summaries = { read: (_, load) => load(), forget: async () => undefined };
const pointerSchema = v.object({ url: v.string(), date: v.string(), videos: v.number() });

async function* dumpLines(store: TimingsStore, groupingKey: Buffer) {
  let page: VideoKey[] = [];

  do {
    page = await store.videoPage(page.at(-1), pageSize);

    for (const video of page) {
      const timings = await lookUp(store, video, { groupingKey, summaries: uncached });

      if (timings.fixes.length > 0 || timings.hidden.length > 0) {
        yield `${JSON.stringify({ video: `${video.hash}:${video.size}`, ...timings })}\n`;
      }
    }
  } while (page.length === pageSize);
}

export const writeDump = async (
  store: TimingsStore,
  { groupingKey, blobToken }: DumpDeps,
  now: Date,
) => {
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
      contentType: "application/gzip",
      multipart: true,
      token: blobToken,
    }),
  ]);

  const pointer = { url: dump.url, date, videos };

  await put(pointerPath, JSON.stringify(pointer), {
    ...blobOptions,
    contentType: "application/json",
    token: blobToken,
  });

  return pointer;
};

type CronDeps = { store: TimingsStore; groupingKey: Buffer; blobToken?: string };

export const dumpCronRoute =
  ({ store, groupingKey, blobToken }: CronDeps) =>
  async (context: Context) => {
    if (blobToken === undefined) {
      return context.json({ error: notConfiguredMessage }, 503);
    }

    return context.json(await writeDump(store, { groupingKey, blobToken }, new Date()));
  };

export const latestDumpRoute = (blobToken?: string) => async (context: Context) => {
  const pointer =
    blobToken === undefined
      ? null
      : await get(pointerPath, { access: "public", token: blobToken, useCache: false });
  const parsed = v.safeParse(
    pointerSchema,
    pointer?.statusCode === 200 ? parseJSON(await new Response(pointer.stream).text()) : undefined,
  );

  if (!parsed.success) {
    return context.json({ error: noDumpMessage }, 404);
  }

  context.header("cache-control", "public, max-age=3600, s-maxage=3600");

  return context.redirect(parsed.output.url, 302);
};
