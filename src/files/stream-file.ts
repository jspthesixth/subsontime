import * as v from "valibot";
import { fetchWithTimeout } from "../http.ts";
import { maximumSearchBytes, type VideoQuery } from "../sources/source.ts";
import type { RangeReader } from "./matroska.ts";

const lookupTimeoutMs = 4000;
const readTimeoutMs = 5000;
const firstReadBytes = 64 * 1024;

const streamsSchema = v.object({
  streams: v.array(
    v.object({
      url: v.optional(v.string()),
      behaviorHints: v.optional(
        v.object({ filename: v.optional(v.string()), videoSize: v.optional(v.number()) }),
      ),
    }),
  ),
});

const streamsURL = (manifestURL: string, { type, imdbId, season, episode }: VideoQuery) =>
  `${manifestURL.replace(/\/manifest\.json$/, "")}/stream/${type}/${
    season === undefined ? imdbId : `${imdbId}:${season}:${episode}`
  }.json`;

const streamURLOf = async (manifestURL: string, query: VideoQuery, signal: AbortSignal) => {
  const response = await fetchWithTimeout(
    streamsURL(manifestURL, query),
    { signal, maxBytes: maximumSearchBytes },
    lookupTimeoutMs,
  );

  if (!response.ok) {
    throw new Error(`Stream lookup failed with status ${response.status}`);
  }

  const parsed = v.safeParse(streamsSchema, await response.json().catch(() => undefined));

  const isPlayed = ({ filename, videoSize }: { filename?: string; videoSize?: number } = {}) =>
    query.filename === undefined
      ? query.videoSize !== undefined && videoSize === query.videoSize
      : filename === query.filename;

  return parsed.success
    ? parsed.output.streams.find(
        ({ url, behaviorHints }) => url !== undefined && isPlayed(behaviorHints),
      )?.url
    : undefined;
};

const contentRangeOf = (response: Response) => {
  const [, from, to, size] =
    /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "") ?? [];

  return { from: Number(from), to: Number(to), size: Number(size) };
};

const rangeOf = async (url: string, start: number, length: number, signal: AbortSignal) => {
  const response = await fetchWithTimeout(
    url,
    { signal, headers: { range: `bytes=${start}-${start + length - 1}` } },
    readTimeoutMs,
  );
  const range = contentRangeOf(response);

  if (response.status !== 206 || range.from !== start || range.to - range.from >= length) {
    await response.body?.cancel();

    throw new Error(`Range read failed with status ${response.status}`);
  }

  return { range, url: response.url, bytes: new Uint8Array(await response.arrayBuffer()) };
};

export const streamFileOf = async (
  manifestURLs: string[],
  query: VideoQuery,
  signal: AbortSignal,
): Promise<RangeReader | undefined> => {
  const lookups = await Promise.allSettled(
    manifestURLs.map((manifestURL) => streamURLOf(manifestURL, query, signal)),
  );
  const url = lookups
    .map((lookup) => (lookup.status === "fulfilled" ? lookup.value : undefined))
    .find((each) => each !== undefined);
  const failed = lookups.find((lookup) => lookup.status === "rejected");

  if (url === undefined && failed !== undefined) {
    throw failed.reason;
  }

  if (url === undefined) {
    return undefined;
  }

  const first = await rangeOf(url, 0, firstReadBytes, signal);
  const { size } = first.range;

  const head = first.bytes;
  const fileURL = first.url === "" ? url : first.url;

  return Number.isSafeInteger(size)
    ? {
        size,
        read: async (start, length) => {
          const end = Math.min(start + length, size);

          return end <= head.length
            ? head.subarray(start, end)
            : (await rangeOf(fileURL, start, end - start, signal)).bytes;
        },
      }
    : undefined;
};
