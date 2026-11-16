import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { Context } from "hono";
import * as v from "valibot";
import type { AppEnv, RouteDeps } from "../app.ts";
import type { Config } from "../config/config.ts";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";
import { parseJSON } from "../json.ts";
import type { SourceSet } from "../sources/from-config.ts";
import type { Candidate, Source } from "../sources/source.ts";
import type { Cue } from "../subtitles/cue.ts";
import { decodeSubtitle } from "../subtitles/decode.ts";
import { stripHearingImpaired } from "../subtitles/hearing-impaired.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import { parseRelease } from "../subtitles/release.ts";
import { writeSRT } from "../subtitles/write.ts";
import { retimeToAnchor } from "../timing/anchor.ts";
import { retime, type RetimeResult, type Track } from "../timing/retime.ts";
import { submitFix, submitMismatch } from "../timings/api.ts";
import type { VideoKey } from "../timings/db.ts";
import { toFixCues } from "../timings/fingerprint.ts";
import {
  errorName,
  fileShared,
  hashesOf,
  hiddenMatch,
  sharedFix,
  viewerOf,
  type Hidden,
  type OpenTimings,
  type Shared,
} from "./open-timings.ts";
import { anchorFor, type Anchor } from "./anchors.ts";
import { recalledFileHash, withFileHash } from "./file-hashes.ts";
import { candidateKey, decodeRef, type CandidateRef, type SubtitleRef } from "./refs.ts";

export type Attempt = {
  candidate: CandidateRef;
  track?: Track;
  result?: RetimeResult;
  hidden?: Hidden;
};
export type Download = (candidate: CandidateRef) => Promise<Track>;
export type SubtitleCache = {
  get(id: string): Promise<string | undefined>;
  set(id: string, srt: string): Promise<void>;
};

type Served = { found: boolean; srt: string };
export type Share = { kind: "fix" | "mismatch"; input: object };

const submitters = { fix: submitFix, mismatch: submitMismatch };
const downloadTimeoutMs = 8000;
const srtType = "application/x-subrip; charset=utf-8";
const srtSeconds = 24 * 60 * 60;

const toCandidate = (ref: CandidateRef): Candidate => ({
  sourceName: ref.n,
  ref: ref.r,
  lang: ref.l,
  release: parseRelease(""),
  hashMatch: ref.h === 1,
  fps: ref.p,
});

const fetchTrack = async (
  sources: Map<string, Source>,
  ref: CandidateRef,
  signal: AbortSignal | undefined,
): Promise<Track> => {
  const source = sources.get(ref.n);

  if (source === undefined) {
    throw new Error("Unknown source");
  }

  const bytes = await source.download(
    ref.r,
    AbortSignal.any([AbortSignal.timeout(downloadTimeoutMs), ...(signal ? [signal] : [])]),
  );

  return { candidate: toCandidate(ref), cues: parseSubtitle(decodeSubtitle(bytes, ref.l)) };
};

const settledTracks = async (tracks: Promise<Track>[]) =>
  (await Promise.allSettled(tracks)).flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );

type Timing = {
  references: () => Promise<Track[]>;
  anchor: () => Promise<Anchor | undefined>;
};

const timeTrack = async (
  track: Track,
  { references, anchor: anchorOf }: Timing,
  config: Config,
  signal: AbortSignal | undefined,
  shared: Shared | undefined,
  anchorable: boolean,
): Promise<RetimeResult> => {
  if (track.candidate.hashMatch) {
    return { kind: "made-for-file", cues: track.cues };
  }

  if (config.timing === "off") {
    return { kind: "not-retimed", cues: track.cues };
  }

  const fixed = await sharedFix(track.cues, shared);

  if (fixed !== undefined) {
    return fixed;
  }

  const anchor = anchorable ? await anchorOf() : undefined;

  if (anchor?.sharing.has(candidateKey(track.candidate.sourceName, track.candidate.ref))) {
    return { kind: "not-retimed", cues: track.cues };
  }

  const anchored = anchor === undefined ? undefined : retimeToAnchor(track, anchor.track);

  if (anchored !== undefined) {
    return anchored;
  }

  const ready = await references();

  signal?.throwIfAborted();

  return retime(track, ready);
};

const preparedAnchor = (shared: Shared | undefined) => async (track: Track) => {
  if (hiddenMatch(track.cues, shared) !== undefined) {
    return undefined;
  }

  const fixed = await sharedFix(track.cues, shared);

  return fixed?.kind === "shared-fix" ? { ...track, cues: fixed.cues } : track;
};

export const downloader = (sources: SourceSet, signal?: AbortSignal): Download => {
  const byName = new Map(
    [...sources.listed, ...sources.references].map((source) => [source.name, source]),
  );
  const downloads = new Map<string, Promise<Track>>();

  return (candidate) => {
    const key = candidateKey(candidate.n, candidate.r);
    const track = downloads.get(key) ?? fetchTrack(byName, candidate, signal);

    downloads.set(key, track);

    return track;
  };
};

export const servedCues = ({ track, result }: Attempt, config: Config): Cue[] | undefined => {
  if (track === undefined || result === undefined) {
    return undefined;
  }

  if (result.kind !== "mismatch") {
    return result.cues;
  }

  return config.extras.hideMismatches ? undefined : track.cues;
};

export async function* resolveAttempts(
  ref: Pick<SubtitleRef, "c" | "x">,
  config: Config,
  download: Download,
  signal?: AbortSignal,
  shared?: Shared,
  {
    lazyReferences = false,
    anchorOf,
  }: { lazyReferences?: boolean; anchorOf?: () => Promise<Anchor | undefined> } = {},
): AsyncGenerator<Attempt> {
  let downloaded: Promise<Track[]> | undefined;
  let anchoring: Promise<Anchor | undefined> | undefined;

  const timing: Timing = {
    references: () => {
      downloaded ??=
        config.timing === "off" ? Promise.resolve([]) : settledTracks(ref.x.map(download));

      return downloaded;
    },
    anchor: () => {
      anchoring ??= anchorOf?.() ?? Promise.resolve(undefined);

      return anchoring;
    },
  };

  if (!lazyReferences && ref.c[0]?.h !== 1) {
    timing.references();
  }

  for (const candidate of ref.c) {
    const attempt: Attempt = await download(candidate)
      .then(async (track): Promise<Attempt> => {
        const hidden = hiddenMatch(track.cues, shared);

        return hidden === undefined
          ? {
              candidate,
              track,
              result: await timeTrack(track, timing, config, signal, shared, candidate.e !== 1),
            }
          : { candidate, track, hidden, result: { kind: "mismatch" } };
      })
      .catch(() => ({ candidate }));

    if (signal?.aborted === true) {
      return;
    }

    yield attempt;

    if (servedCues(attempt, config) !== undefined) {
      return;
    }
  }
}

export const recordAttempts = async (attempts: AsyncIterable<Attempt>, into: Attempt[] = []) => {
  for await (const attempt of attempts) {
    into.push(attempt);
  }

  return into;
};

export const subtitleCache = (state: SharedState): SubtitleCache => ({
  get: (id) => orMiss(() => state.get(`srt:${id}`), undefined),
  set: (id, srt) => orMiss(() => state.set(`srt:${id}`, srt, srtSeconds), undefined),
});

const encodeServed = ({ found, srt }: Served) =>
  JSON.stringify({ found, srt: Buffer.from(srt).toString("base64") });

const servedSchema = v.object({ found: v.boolean(), srt: v.string() });

const decodeServed = (text: string): Served | undefined => {
  const parsed = v.safeParse(servedSchema, parseJSON(text));

  return parsed.success
    ? { found: parsed.output.found, srt: Buffer.from(parsed.output.srt, "base64").toString("utf8") }
    : undefined;
};

export const fixCuesOf = (cues: Cue[]) =>
  toFixCues(cues)
    .map((cue) => ({
      h: cue.h,
      s: Math.max(Math.round(cue.s), 0),
      e: Math.max(Math.round(cue.e), 0),
    }))
    .toSorted((a, b) => a.s - b.s);

const referenceKeyOf = (reference: Track) => {
  const key = hashesOf(reference.cues).slice(0, 8).join(",");

  return key === "" ? undefined : key;
};

export const sharesOf = (attempts: Attempt[], video: VideoKey): Share[] =>
  attempts.flatMap(({ track, result, hidden }): Share[] => {
    if (track === undefined || hidden !== undefined) {
      return [];
    }

    if (result?.kind === "retimed") {
      const { cues, references, reference } = result;

      const byHash = references.every((used) => used.candidate.hashMatch);

      return [
        {
          kind: "fix",
          input: {
            video,
            subtitle: fixCuesOf(cues),
            method: byHash ? "reference" : "release-name",
            referenceKey: referenceKeyOf(reference),
          },
        },
      ];
    }

    return result?.kind === "mismatch"
      ? [{ kind: "mismatch", input: { video, subtitleHashes: hashesOf(track.cues) } }]
      : [];
  });

const logWrite = (error: unknown) =>
  console.error(`Open Timings write failed: ${errorName(error)}`);

const shareAfterResponse = (
  { store, originOf, summaries }: OpenTimings,
  shares: Share[],
  submitter: string,
  client: string,
) =>
  setImmediate()
    .then(async () => {
      const origin = await originOf(client);

      await Promise.all(
        shares.map(({ kind, input }) =>
          submitters[kind](store, input, { submitter, origin, summaries }),
        ),
      );
    })
    .catch(logWrite);

const servedOf = (attempts: Attempt[], config: Config, dialogueOnly: boolean): Served => {
  const cues = attempts
    .map((attempt) => servedCues(attempt, config))
    .find((each) => each !== undefined);
  const shown = dialogueOnly && cues !== undefined ? stripHearingImpaired(cues) : cues;

  if (shown !== undefined && shown.length > 0) {
    return { found: true, srt: writeSRT(shown) };
  }

  return {
    found:
      attempts.some((attempt) => attempt.result?.kind === "mismatch") &&
      !config.bestOnly &&
      !dialogueOnly,
    srt: "",
  };
};

const srtResponse = (context: Context<AppEnv>, srt: string) =>
  context.body(srt, 200, { "content-type": srtType, "cache-control": "public, max-age=86400" });

export const fileRoute =
  ({
    sourcesFor,
    refKey,
    singleFlight,
    subtitles,
    state,
    clientKey,
    openTimings,
    defer,
  }: RouteDeps) =>
  async (context: Context<AppEnv>) => {
    const config = context.get("config");
    const decoded = (() => {
      try {
        return decodeRef((context.req.param("file") ?? "").replace(/\.srt$/, ""), refKey);
      } catch {
        return undefined;
      }
    })();

    if (decoded === undefined) {
      return context.text("Invalid subtitle reference", 400);
    }

    const recalled =
      decoded.w === undefined && decoded.k !== undefined
        ? await recalledFileHash(state, decoded.k)
        : undefined;
    const ref = recalled === undefined ? decoded : withFileHash(decoded, recalled);
    const id = createHash("sha256")
      .update(`${context.req.param("config") ?? ""}/${context.req.param("file") ?? ""}`)
      .update(recalled === undefined ? "" : `#${recalled.w.h}`)
      .digest("hex");
    const cached = await subtitles?.get(id);

    if (cached !== undefined) {
      return srtResponse(context, cached);
    }

    const video = ref.w === undefined ? undefined : { hash: ref.w.h, size: ref.w.z };
    const viewer =
      openTimings === undefined ? undefined : viewerOf(config, openTimings.installSalt);
    const shares: Share[] = [];
    const produce = async () => {
      const shared =
        openTimings === undefined || video === undefined || !config.useShared
          ? undefined
          : await fileShared(openTimings, state, video, viewer, ref.d);
      const download = downloader(sourcesFor(config, context.get("tokens")));
      const attempts = await recordAttempts(
        resolveAttempts(ref, config, download, undefined, shared, {
          anchorOf: () =>
            anchorFor(
              {
                state,
                singleFlight,
                prepared: preparedAnchor(shared),
              },
              ref,
              download,
            ),
        }),
      );
      const fresh = servedOf(attempts, config, ref.t === "dialogue");

      if (config.share && video !== undefined) {
        shares.push(...sharesOf(attempts, video));
      }

      if (fresh.srt !== "") {
        await subtitles?.set(id, fresh.srt);
      }

      return fresh;
    };
    const flown = await singleFlight(id, async () => encodeServed(await produce()));
    const served = decodeServed(flown) ?? (await produce());

    if (openTimings !== undefined && viewer !== undefined && shares.length > 0) {
      try {
        defer(shareAfterResponse(openTimings, shares, viewer, clientKey(context)));
      } catch (error) {
        logWrite(error);
      }
    }

    if (!served.found) {
      return context.text("No subtitle fits this file", 404);
    }

    return served.srt === ""
      ? context.body("", 200, { "content-type": srtType })
      : srtResponse(context, served.srt);
  };
