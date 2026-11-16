import { setTimeout } from "node:timers/promises";
import type { Config } from "../config/config.ts";
import type { SourceSet } from "../sources/from-config.ts";
import type { Candidate, Source } from "../sources/source.ts";
import type { Cue } from "../subtitles/cue.ts";
import { decodeSubtitle } from "../subtitles/decode.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import { parseRelease } from "../subtitles/release.ts";
import { agreeingWith, atSpeedOfMost, retimeToAnchor } from "../timing/anchor.ts";
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
export type Download = (candidate: CandidateRef, served?: boolean) => Promise<Track>;
export type Share = { kind: "fix" | "mismatch"; input: object };

export const mismatchReason =
  "Made for another video. Its dialogue does not line up with this file anywhere.";

const downloadTimeoutMs = 8000;
const othersBudgetMs = 5000;
const unreadableReason = "Could not be read.";

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
  served: boolean,
): Promise<Track> => {
  const source = sources.get(ref.n);

  if (source === undefined) {
    throw new Error("Unknown source");
  }

  const bytes = await source.download(
    ref.r,
    AbortSignal.any([AbortSignal.timeout(downloadTimeoutMs), ...(signal ? [signal] : [])]),
    served,
  );

  return { candidate: toCandidate(ref), cues: parseSubtitle(decodeSubtitle(bytes, ref.l)) };
};

export const settledTracks = async (tracks: Promise<Track>[]) =>
  (await Promise.allSettled(tracks)).flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );

const inTime = (track: Promise<Track>) =>
  Promise.race([
    track,
    setTimeout(othersBudgetMs, undefined, { ref: false }).then(() =>
      Promise.reject(new Error("Too slow to compare")),
    ),
  ]);

type Timing = {
  references: () => Promise<Track[]>;
  anchor: () => Promise<Anchor | undefined>;
  othersThan: (track: Track, start: number, end?: number) => Promise<Track[]>;
  releaseAnchor: () => Promise<Track | undefined>;
};

const atReleaseAnchorSpeed = async (track: Track, { releaseAnchor, othersThan }: Timing) => {
  const anchor = await releaseAnchor();
  const anchored = anchor === undefined ? undefined : retimeToAnchor(track, anchor);

  return anchored?.kind !== "retimed" || sameSpeed(anchored.speedRatio, 1)
    ? undefined
    : atSpeedOfMost(track, anchored, await othersThan(track, 0));
};

const agreeingFirst = 3;

const agreesWithFew = async (track: Track, othersThan: Timing["othersThan"]) => {
  const first = await othersThan(track, 0, agreeingFirst);
  const agreeing = agreeingWith(track.cues, first);

  if (agreeing >= 2) {
    return false;
  }

  const rest = await othersThan(track, agreeingFirst);

  return (
    first.length + rest.length >= agreeingFirst && agreeing + agreeingWith(track.cues, rest) < 2
  );
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

  const sped = await atReleaseAnchorSpeed(track, timing);

  if (sped !== undefined) {
    return sped;
  }

  return (await agreesWithFew(track, timing.othersThan))
    ? { kind: "mismatch", alone: true }
    : retimed;
};

export type Downloader = Download & { has: (candidate: CandidateRef) => boolean };

export const downloader = (sources: SourceSet, signal?: AbortSignal): Downloader => {
  const byName = new Map(
    [...sources.listed, ...sources.references].map((source) => [source.name, source]),
  );
  const downloads = new Map<string, Promise<Track>>();

  const download = (candidate: CandidateRef, served = false) => {
    const key = candidateKey(candidate.n, candidate.r);
    const track = downloads.get(key) ?? fetchTrack(byName, candidate, signal, served);

    downloads.set(key, track);

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

export async function* resolveAttempts(
  ref: Pick<SubtitleRef, "c" | "x" | "a" | "g">,
  config: Config,
  download: Download,
  signal?: AbortSignal,
  shared?: Shared,
  {
    lazyReferences = false,
    anchorOf,
    cuesOf = servedCues,
    served = true,
  }: {
    lazyReferences?: boolean;
    served?: boolean;
    anchorOf?: () => Promise<Anchor | undefined>;
    cuesOf?: typeof servedCues;
  } = {},
): AsyncGenerator<Attempt> {
  let downloaded: Promise<Track[]> | undefined;
  let anchoring: Promise<Anchor | undefined> | undefined;

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
    othersThan: ({ candidate: { sourceName, ref: own } }, start, end) =>
      settledTracks(
        (ref.a ?? ref.g ?? [])
          .filter(({ n, r }) => candidateKey(n, r) !== candidateKey(sourceName, own))
          .slice(start, end)
          .map((candidate) => inTime(download(candidate))),
      ),
    releaseAnchor: async () => {
      const [first] = ref.a ?? [];

      return first === undefined ? undefined : download(first).catch(() => undefined);
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

  return result?.kind === "mismatch" ? mismatchReason : unreadableReason;
};
