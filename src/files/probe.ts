import { createHash } from "node:crypto";
import * as v from "valibot";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";
import type { VideoQuery } from "../sources/source.ts";
import { openSubtitlesHash } from "../video-hash.ts";
import { changeMarkMs } from "../timing/anchor.ts";
import { subtitleTracksOf, type FileSubtitleTrack } from "./matroska.ts";
import { streamFileOf } from "./stream-file.ts";

const readSeconds = 30 * 24 * 60 * 60;
const unreadSeconds = 24 * 60 * 60;
const minimumLines = 100;

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

export type Probe = v.InferOutput<typeof probeSchema>;

type Played = Pick<VideoQuery, "type" | "imdbId" | "season" | "episode" | "filename" | "videoSize">;

export const probeKeyOf = (
  manifestURLs: string[],
  { type, imdbId, season, episode, filename, videoSize }: Played,
) =>
  `probe:${createHash("sha256")
    .update(JSON.stringify([manifestURLs, type, imdbId, season, episode, filename ?? videoSize]))
    .digest("base64url")}`;

const isFull = ({ forced, name = "" }: FileSubtitleTrack) => !forced && !/forced|signs/i.test(name);

const usableOf = (track: FileSubtitleTrack) => {
  const { codec, cues, changes } = track;

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

export const probed = async (state: SharedState, key: string) => {
  const parsed = v.safeParse(
    v.pipe(v.string(), v.parseJson(), probeSchema),
    (await orMiss(() => state.get(key), undefined)) ?? "",
  );

  return parsed.success ? parsed.output : undefined;
};

const read = async (manifestURLs: string[], query: VideoQuery, signal: AbortSignal) => {
  const file = await streamFileOf(manifestURLs, query, signal);

  if (file === undefined) {
    return { tracks: [] };
  }

  const [hash, tracks] = await Promise.all([
    openSubtitlesHash(file.size, file.read),
    subtitleTracksOf(file),
  ]);

  const usable = tracks
    .filter(isFull)
    .flatMap((track) => {
      const found = usableOf(track);

      return found === undefined ? [] : [{ language: track.language, ...found }];
    })
    .toSorted((a, b) => a.rank - b.rank || b.size - a.size);
  const [best] = usable;

  return {
    video: { hash, size: file.size },
    tracks: usable
      .filter(
        (track) =>
          track === best || (track.rank === best?.rank && query.languages.includes(track.language)),
      )
      .map(({ language, cues, changes }) => ({
        language,
        changes,
        cues: cues.map(({ start, end }): [number, number] => [start, end]),
      })),
  };
};

export const probeFile = async (
  manifestURLs: string[],
  query: VideoQuery,
  state: SharedState,
  signal: AbortSignal,
): Promise<Probe> => {
  const key = probeKeyOf(manifestURLs, query);
  const known = await probed(state, key);

  if (known !== undefined) {
    return known;
  }

  const fresh = await read(manifestURLs, query, signal);

  await orMiss(
    () =>
      state.set(
        key,
        JSON.stringify(fresh),
        fresh.video === undefined ? unreadSeconds : readSeconds,
      ),
    undefined,
  );

  return fresh;
};
