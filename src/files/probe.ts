import { createHash } from "node:crypto";
import * as v from "valibot";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";
import type { VideoQuery } from "../sources/source.ts";
import { changeMarkMs } from "../timing/anchor.ts";
import { openSubtitlesHash } from "../video-hash.ts";
import { subtitleTracksOf, type FileSubtitleTrack } from "./matroska.ts";
import { playedStreamOf, remoteFileOf, type PlayedStream } from "./stream-file.ts";

const fileSeconds = 30 * 24 * 60 * 60;
const missSeconds = 24 * 60 * 60;
const minimumLines = 100;
const ambiguous = "ambiguous";

const probeSchema = v.object({
  video: v.optional(v.object({ hash: v.string(), size: v.number() })),
  tracks: v.array(
    v.object({
      language: v.string(),
      changes: v.optional(v.literal(true)),
      cues: v.array(v.tuple([v.number(), v.number()])),
    }),
  ),
});

const namedSchema = v.object({ file: v.string(), hash: v.string() });

export type Probe = v.InferOutput<typeof probeSchema>;

export type ProbeOutcome = "read" | "shared" | "known" | "named" | "not-found" | "no-link";

type Played = Pick<VideoQuery, "type" | "imdbId" | "season" | "episode" | "filename" | "videoSize">;

const hashed = (prefix: string, value: unknown) =>
  `${prefix}:${createHash("sha256").update(JSON.stringify(value)).digest("base64url")}`;

const titleOf = ({ type, imdbId, season, episode }: Played) => [type, imdbId, season, episode];

const playedKeyOf = (manifestURLs: string[], played: Played) =>
  hashed("played", [manifestURLs, ...titleOf(played), played.filename ?? played.videoSize]);

const fileKeyOf = (played: Played, { url, torrent }: PlayedStream) =>
  hashed("file", torrent === undefined ? [url] : [torrent, played.filename ?? played.videoSize]);

const namedKeyOf = (played: Played) => hashed("named", [...titleOf(played), played.filename]);

const parsed = async <T extends v.GenericSchema>(state: SharedState, key: string, schema: T) => {
  const result = v.safeParse(
    v.pipe(v.string(), v.parseJson(), schema),
    (await orMiss(() => state.get(key), undefined)) ?? "",
  );

  return result.success ? result.output : undefined;
};

const kept = (state: SharedState, key: string, value: string, seconds: number) =>
  orMiss(() => state.set(key, value, seconds), undefined);

const isFull = ({ forced, name = "" }: FileSubtitleTrack) => !forced && !/forced|signs/i.test(name);

const usableOf = ({ codec, cues, changes }: FileSubtitleTrack) => {
  if (codec.startsWith("S_TEXT/") && cues.length >= minimumLines) {
    return { rank: 0, size: cues.length, cues };
  }

  if (codec === "S_VOBSUB" && cues.length >= minimumLines) {
    return { rank: 1, size: cues.length, cues };
  }

  return codec === "S_HDMV/PGS" && changes.length >= minimumLines * 2
    ? {
        rank: 2,
        size: changes.length,
        cues: changes.map((time) => ({ start: time, end: time + changeMarkMs })),
        changes: true as const,
      }
    : undefined;
};

const read = async (url: string, signal: AbortSignal): Promise<Probe> => {
  const file = await remoteFileOf(url, signal);

  if (file === undefined) {
    return { tracks: [] };
  }

  const [hash, tracks] = await Promise.all([
    openSubtitlesHash(file.size, file.read),
    subtitleTracksOf(file),
  ]);

  const [best] = tracks
    .filter(isFull)
    .flatMap((track) => {
      const usable = usableOf(track);

      return usable === undefined ? [] : [{ language: track.language, ...usable }];
    })
    .toSorted((a, b) => a.rank - b.rank || b.size - a.size);

  return {
    video: { hash, size: file.size },
    tracks:
      best === undefined
        ? []
        : [
            {
              language: best.language,
              changes: best.changes,
              cues: best.cues.map(({ start, end }): [number, number] => [start, end]),
            },
          ],
  };
};

const named = async (state: SharedState, played: Played, file: string, hash: string) => {
  const key = namedKeyOf(played);
  const known = await orMiss(() => state.get(key), undefined);
  const earlier =
    known === undefined
      ? undefined
      : v.safeParse(v.pipe(v.string(), v.parseJson(), namedSchema), known);

  if (known === undefined) {
    await kept(state, key, JSON.stringify({ file, hash }), fileSeconds);
  } else if (earlier?.success !== true || earlier.output.hash !== hash) {
    await kept(state, key, ambiguous, fileSeconds);
  }
};

const byName = async (state: SharedState, played: Played) => {
  const entry =
    played.filename === undefined
      ? undefined
      : await parsed(state, namedKeyOf(played), namedSchema);
  const probe = entry === undefined ? undefined : await parsed(state, entry.file, probeSchema);

  return probe === undefined ? undefined : { probe, outcome: "named" as const };
};

export const knownTiming = async (
  manifestURLs: string[],
  played: Played,
  state: SharedState,
): Promise<{ probe: Probe; outcome: "known" | "named" } | undefined> => {
  if (manifestURLs.length === 0) {
    return byName(state, played);
  }

  const pointed = await orMiss(() => state.get(playedKeyOf(manifestURLs, played)), undefined);
  const probe = pointed ? await parsed(state, pointed, probeSchema) : undefined;

  if (probe !== undefined) {
    return { probe, outcome: "known" };
  }

  return pointed === "" ? byName(state, played) : undefined;
};

const lookedUp = async (
  manifestURLs: string[],
  query: VideoQuery,
  state: SharedState,
  signal: AbortSignal,
): Promise<{ probe?: Probe; outcome: ProbeOutcome }> => {
  const playedKey = playedKeyOf(manifestURLs, query);
  const stream = await playedStreamOf(manifestURLs, query, signal);

  if (stream === undefined) {
    await kept(state, playedKey, "", missSeconds);

    return (await byName(state, query)) ?? { outcome: "not-found" };
  }

  const file = fileKeyOf(query, stream);
  const shared = await parsed(state, file, probeSchema);
  const probe = shared ?? (await read(stream.url, signal));

  if (shared === undefined) {
    await kept(
      state,
      file,
      JSON.stringify(probe),
      probe.video === undefined ? missSeconds : fileSeconds,
    );
  }

  await kept(state, playedKey, file, fileSeconds);

  if (stream.torrent !== undefined && probe.video !== undefined) {
    await named(state, query, file, probe.video.hash);
  }

  return { probe, outcome: shared === undefined ? "read" : "shared" };
};

export const probeFile = async (
  manifestURLs: string[],
  query: VideoQuery,
  state: SharedState,
  signal: AbortSignal,
): Promise<{ probe?: Probe; outcome: ProbeOutcome }> => {
  const known = await knownTiming(manifestURLs, query, state);

  if (known !== undefined) {
    return known;
  }

  if (manifestURLs.length === 0) {
    return { outcome: "no-link" };
  }

  if ((await orMiss(() => state.get(playedKeyOf(manifestURLs, query)), undefined)) === "") {
    return { outcome: "not-found" };
  }

  try {
    return await lookedUp(manifestURLs, query, state, signal);
  } catch (error) {
    const fallback = await byName(state, query);

    if (fallback === undefined) {
      throw error;
    }

    return fallback;
  }
};
