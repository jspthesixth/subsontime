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

type Stream = v.InferOutput<typeof streamsSchema>["streams"][number];

export type PlayedStream = { url: string; torrent?: string };

const infoHashPattern = /(?<![A-Za-z0-9])[a-f0-9]{40}(?![A-Za-z0-9])/;
const sharedHosts = new Set(["torrentio.strem.fun"]);

const torrentOf = ({ url = "" }: Stream) => {
  const { hostname, pathname } = URL.canParse(url) ? new URL(url) : { hostname: "", pathname: "" };

  const at = pathname.search(infoHashPattern);

  return sharedHosts.has(hostname) && at !== -1 ? pathname.slice(at) : undefined;
};

const streamsURL = (manifestURL: string, { type, imdbId, season, episode }: VideoQuery) =>
  `${manifestURL.replace(/\/manifest\.json$/, "")}/stream/${type}/${
    season === undefined ? imdbId : `${imdbId}:${season}:${episode}`
  }.json`;

const playedOf = (query: VideoQuery) => (stream: Stream) => {
  const { filename, videoSize } = stream.behaviorHints ?? {};

  return query.filename === undefined
    ? query.videoSize !== undefined && videoSize === query.videoSize
    : filename === query.filename;
};

const playedIn = async (manifestURL: string, query: VideoQuery, signal: AbortSignal) => {
  const response = await fetchWithTimeout(
    streamsURL(manifestURL, query),
    { signal, maxBytes: maximumSearchBytes },
    lookupTimeoutMs,
  );

  if (!response.ok) {
    throw new Error(`Stream lookup failed with status ${response.status}`);
  }

  const parsed = v.safeParse(streamsSchema, await response.json().catch(() => undefined));
  const stream = parsed.success
    ? parsed.output.streams.find((each) => each.url !== undefined && playedOf(query)(each))
    : undefined;

  return stream?.url === undefined ? undefined : { url: stream.url, torrent: torrentOf(stream) };
};

export const playedStreamOf = async (
  manifestURLs: string[],
  query: VideoQuery,
  signal: AbortSignal,
): Promise<PlayedStream | undefined> => {
  const lookups = await Promise.allSettled(
    manifestURLs.map((manifestURL) => playedIn(manifestURL, query, signal)),
  );
  const played = lookups
    .map((lookup) => (lookup.status === "fulfilled" ? lookup.value : undefined))
    .find((each) => each !== undefined);
  const failed = lookups.find((lookup) => lookup.status === "rejected");

  if (played === undefined && failed !== undefined) {
    throw failed.reason;
  }

  return played;
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

export const remoteFileOf = async (
  url: string,
  signal: AbortSignal,
): Promise<(RangeReader & { url: string }) | undefined> => {
  const first = await rangeOf(url, 0, firstReadBytes, signal);
  const { size } = first.range;

  const head = first.bytes;
  const fileURL = first.url === "" ? url : first.url;

  return Number.isSafeInteger(size)
    ? {
        size,
        url: fileURL,
        read: async (start: number, length: number) => {
          const end = Math.min(start + length, size);

          return end <= head.length
            ? head.subarray(start, end)
            : (await rangeOf(fileURL, start, end - start, signal)).bytes;
        },
      }
    : undefined;
};
