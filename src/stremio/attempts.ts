import { createHash } from "node:crypto";
import type { Config } from "../config/config.ts";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";
import type { SourceSet } from "../sources/from-config.ts";
import type { Candidate, Source } from "../sources/source.ts";
import type { Cue } from "../subtitles/cue.ts";
import { decodeSubtitle } from "../subtitles/decode.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import { parseRelease } from "../subtitles/release.ts";
import { alignOffset } from "../timing/alass.ts";
import { atSpeedOfMost, retimeToAnchor, sameVideo, type AlignedAt } from "../timing/anchor.ts";
import { retime, sameSpeed, type RetimeResult, type Track } from "../timing/retime.ts";
import type { VideoKey } from "../timings/db.ts";
import { toFixCues } from "../timings/fingerprint.ts";
import type { Anchor } from "./anchors.ts";
import { hashesOf, hiddenMatch, sharedFix, type Hidden, type Shared } from "./open-timings.ts";
import { candidateKey, type CandidateRef, type SubtitleRef } from "./refs.ts";

export type Attempt = {
  candidate: CandidateRef;
  track?: Track;
  result?: RetimeResult;
  hidden?: Hidden;
};
export type Download = (
  candidate: CandidateRef,
  served?: boolean,
  signal?: AbortSignal,
) => Promise<Track>;
export type Share = { kind: "fix" | "mismatch"; input: object };

export const mismatchReason =
  "Made for another video. Its dialogue does not line up with this file anywhere.";
export const aloneReason = "Its timing agrees with no other subtitle of this video.";

const downloadTimeoutMs = 8000;
const othersBudgetMs = 5000;
const fileSeconds = 24 * 60 * 60;
const failedSeconds = 10 * 60;
const verdictSeconds = 24 * 60 * 60;
const failedMark = "-";
const unreadableReason = "Could not be read.";

const toCandidate = (ref: CandidateRef): Candidate => ({
  sourceName: ref.n,
  ref: ref.r,
  lang: ref.l,
  release: parseRelease(""),
  hashMatch: ref.h === 1,
  fps: ref.p,
});

const hashed = (prefix: string, value: unknown) =>
  `${prefix}:${createHash("sha256").update(JSON.stringify(value)).digest("base64url")}`;

const trackOf = (ref: CandidateRef, bytes: Uint8Array): Track => ({
  candidate: toCandidate(ref),
  cues: parseSubtitle(decodeSubtitle(bytes, ref.l)),
});

const storedTrackOf = (ref: CandidateRef, stored: string) => {
  try {
    return trackOf(ref, new Uint8Array(Buffer.from(stored, "base64")));
  } catch {
    return undefined;
  }
};

const cachedTrack = async (
  state: SharedState | undefined,
  ref: CandidateRef,
  signal: AbortSignal | undefined,
  fresh: () => Promise<Uint8Array>,
) => {
  if (state === undefined || ref.m === 1) {
    return trackOf(ref, await fresh());
  }

  const key = hashed("sub:file", [ref.n, ref.r]);
  const stored = await orMiss(() => state.get(key), undefined);

  if (stored === failedMark) {
    throw new Error("Download failed recently");
  }

  const known = stored === undefined ? undefined : storedTrackOf(ref, stored);

  if (known !== undefined) {
    return known;
  }

  try {
    const bytes = await fresh();
    const track = trackOf(ref, bytes);

    await orMiss(
      () => state.set(key, Buffer.from(bytes).toString("base64"), fileSeconds),
      undefined,
    );

    return track;
  } catch (error) {
    if (signal?.aborted !== true) {
      await orMiss(() => state.set(key, failedMark, failedSeconds), undefined);
    }

    throw error;
  }
};

const fetchTrack = async (
  sources: Map<string, Source>,
  ref: CandidateRef,
  signal: AbortSignal | undefined,
  served: boolean,
  state: SharedState | undefined,
): Promise<Track> => {
  const source = sources.get(ref.n);

  if (source === undefined) {
    throw new Error("Unknown source");
  }

  return cachedTrack(state, ref, signal, () =>
    source.download(
      ref.r,
      AbortSignal.any([AbortSignal.timeout(downloadTimeoutMs), ...(signal ? [signal] : [])]),
      served,
    ),
  );
};

export const settledTracks = async (tracks: Promise<Track>[]) =>
  (await Promise.allSettled(tracks)).flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );

type Others = { tracks: Track[]; failed: number };

type Timing = {
  references: () => Promise<Track[]>;
  anchor: () => Promise<Anchor | undefined>;
  othersThan: (track: Track, start: number, end?: number) => Promise<Others>;
  releaseAnchor: () => Promise<Track | undefined>;
  alignedAt: (track: Track) => AlignedAt;
  verdict: (
    track: Track,
    decide: () => Promise<boolean | undefined>,
  ) => Promise<boolean | undefined>;
};

const trackKeyOf = ({ candidate }: Track) => candidateKey(candidate.sourceName, candidate.ref);

const atReleaseAnchorSpeed = async (
  track: Track,
  { releaseAnchor, othersThan, alignedAt }: Timing,
) => {
  const anchor = await releaseAnchor();
  const anchored = anchor === undefined ? undefined : retimeToAnchor(track, anchor);

  if (anchor === undefined || anchored === undefined || sameSpeed(anchored.speedRatio, 1)) {
    return undefined;
  }

  const { tracks } = await othersThan(track, 0);

  const voters = tracks.filter((other) => trackKeyOf(other) !== trackKeyOf(anchor));
  const sped = await atSpeedOfMost(track, anchored, anchor, voters, alignedAt(track));

  return sped === undefined ? undefined : { ...sped, unconfirmed: true as const };
};

const agreeingFirst = 3;

const aloneAmong = async (track: Track, { othersThan, alignedAt }: Timing) => {
  const agrees = (other: Track) => sameVideo(other, alignedAt(track));
  const first = await othersThan(track, 0, agreeingFirst);
  const agreeing = first.tracks.filter(agrees).length;

  if (agreeing >= 2) {
    return false;
  }

  const rest = await othersThan(track, agreeingFirst);
  const downloaded = first.tracks.length + rest.tracks.length;

  if (agreeing + rest.tracks.filter(agrees).length >= 2) {
    return false;
  }

  return downloaded >= agreeingFirst && first.failed + rest.failed <= downloaded ? true : undefined;
};

const timeTrack = async (
  track: Track,
  timing: Timing,
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

  const anchor = anchorable ? await timing.anchor() : undefined;

  if (anchor?.sharing.has(candidateKey(track.candidate.sourceName, track.candidate.ref))) {
    return { kind: "not-retimed", cues: track.cues };
  }

  const anchored = anchor === undefined ? undefined : retimeToAnchor(track, anchor.track);

  if (anchored !== undefined) {
    return anchored;
  }

  const ready = await timing.references();

  signal?.throwIfAborted();

  const retimed = await retime(track, ready);

  if (retimed.kind !== "not-retimed") {
    return retimed;
  }

  const sped = anchorable ? await atReleaseAnchorSpeed(track, timing) : undefined;

  if (sped !== undefined) {
    return sped;
  }

  return (await timing.verdict(track, () => aloneAmong(track, timing))) === true
    ? { kind: "mismatch", alone: true }
    : retimed;
};

export type Downloader = Download & { has: (candidate: CandidateRef) => boolean };

export const downloader = (
  sources: SourceSet,
  signal?: AbortSignal,
  state?: SharedState,
): Downloader => {
  const byName = new Map(
    [...sources.listed, ...sources.references].map((source) => [source.name, source]),
  );
  const downloads = new Map<string, Promise<Track>>();

  const download = (candidate: CandidateRef, served = false, callSignal?: AbortSignal) => {
    const key = candidateKey(candidate.n, candidate.r);
    const known = downloads.get(key);

    if (known !== undefined) {
      return known;
    }

    const signals = [signal, callSignal].filter((each) => each !== undefined);
    const track = fetchTrack(byName, candidate, AbortSignal.any(signals), served, state);

    downloads.set(key, track);
    track.catch(() => {
      if (callSignal?.aborted === true) {
        downloads.delete(key);
      }
    });

    return track;
  };

  return Object.assign(download, {
    has: (candidate: CandidateRef) => downloads.has(candidateKey(candidate.n, candidate.r)),
  });
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

const timedAsIs = (candidate: CandidateRef, config: Config) =>
  config.timing === "off" || candidate.h === 1 || candidate.e === 1;

export const canBeTimed = (
  candidates: CandidateRef[],
  { x, a }: Pick<SubtitleRef, "x" | "a">,
  config: Config,
) =>
  candidates.some(
    (candidate) =>
      timedAsIs(candidate, config) ||
      a !== undefined ||
      x.some(
        (reference) =>
          candidateKey(reference.n, reference.r) !== candidateKey(candidate.n, candidate.r),
      ),
  );

export const timedCues = (attempt: Attempt, config: Config): Cue[] | undefined => {
  const { candidate, result } = attempt;

  const unfit =
    result?.kind === "not-retimed" && result.noFit === true && !timedAsIs(candidate, config);

  return result?.kind === "mismatch" || unfit ? undefined : servedCues(attempt, config);
};

const budgetSignal = () => {
  const controller = new AbortController();

  setTimeout(() => controller.abort(new Error("Too slow to compare")), othersBudgetMs).unref();

  return controller.signal;
};

const abortOf = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
    }

    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

export async function* resolveAttempts(
  ref: Pick<SubtitleRef, "c" | "x" | "a" | "g"> & Partial<Pick<SubtitleRef, "q">>,
  config: Config,
  download: Download,
  signal?: AbortSignal,
  shared?: Shared,
  {
    lazyReferences = false,
    anchorOf,
    cuesOf = servedCues,
    served = true,
    state,
  }: {
    lazyReferences?: boolean;
    served?: boolean;
    anchorOf?: () => Promise<Anchor | undefined>;
    cuesOf?: typeof servedCues;
    state?: SharedState;
  } = {},
): AsyncGenerator<Attempt> {
  let downloaded: Promise<Track[]> | undefined;
  let anchoring: Promise<Anchor | undefined> | undefined;
  let comparing: AbortSignal | undefined;

  const pool = ref.a ?? ref.g ?? [];
  const alignments = new Map<string, ReturnType<typeof alignOffset>>();

  const timing: Timing = {
    references: () => {
      downloaded ??=
        config.timing === "off"
          ? Promise.resolve([])
          : settledTracks(ref.x.map((candidate) => download(candidate)));

      return downloaded;
    },
    anchor: () => {
      anchoring ??= anchorOf?.() ?? Promise.resolve(undefined);

      return anchoring;
    },
    othersThan: async (track, start, end) => {
      comparing ??= AbortSignal.any([budgetSignal(), ...(signal === undefined ? [] : [signal])]);

      const budget = comparing;
      const settled = await Promise.allSettled(
        pool
          .filter(({ n, r }) => candidateKey(n, r) !== trackKeyOf(track))
          .slice(start, end)
          .map((candidate) => Promise.race([download(candidate, false, budget), abortOf(budget)])),
      );

      return {
        tracks: settled.flatMap((each) => (each.status === "fulfilled" ? [each.value] : [])),
        failed: settled.filter(({ status }) => status === "rejected").length,
      };
    },
    releaseAnchor: async () => {
      const [first] = ref.a ?? [];

      return first === undefined ? undefined : download(first).catch(() => undefined);
    },
    alignedAt: (track) => (other, speedRatio) => {
      const key = JSON.stringify([trackKeyOf(other), trackKeyOf(track), speedRatio]);
      const known = alignments.get(key) ?? alignOffset(other.cues, track.cues, { speedRatio });

      alignments.set(key, known);

      return known;
    },
    verdict: async (track, decide) => {
      if (state === undefined) {
        return decide();
      }

      const key = hashed("alone", [ref.q, trackKeyOf(track), pool.map(({ n, r }) => [n, r])]);
      const stored = await orMiss(() => state.get(key), undefined);

      if (stored === "1" || stored === "0") {
        return stored === "1";
      }

      const decided = await decide();

      if (decided !== undefined) {
        await orMiss(() => state.set(key, decided ? "1" : "0", verdictSeconds), undefined);
      }

      return decided;
    },
  };

  if (!lazyReferences && ref.c[0]?.h !== 1 && ref.a === undefined) {
    timing.references();
  }

  for (const candidate of ref.c) {
    const attempt: Attempt = await download(candidate, served)
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

    if (cuesOf(attempt, config) !== undefined) {
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

    if (result?.kind === "retimed" && result.unconfirmed === true) {
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

    return result?.kind === "mismatch" && result.alone !== true
      ? [{ kind: "mismatch", input: { video, subtitleHashes: hashesOf(track.cues) } }]
      : [];
  });

const hiddenReason = ({ reason = "mismatch" }: Hidden) =>
  reason === "mismatch"
    ? "Hidden by Open Timings: made for another video."
    : `Hidden by Open Timings: reported as ${reason.replaceAll("-", " ")}.`;

export const reasonOf = ({ result, hidden }: Attempt) => {
  if (hidden !== undefined) {
    return hiddenReason(hidden);
  }

  if (result?.kind !== "mismatch") {
    return unreadableReason;
  }

  return result.alone === true ? aloneReason : mismatchReason;
};
