import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { Context } from "hono";
import { endTime, startTime } from "hono/timing";
import * as v from "valibot";
import type { AppEnv, RouteDeps } from "../app.ts";
import type { Config } from "../config/config.ts";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";
import { parseJSON } from "../json.ts";
import type { SourceSet } from "../sources/from-config.ts";
import type { Candidate, Source } from "../sources/source.ts";
import { isCapitals, isMostlyCapitals, recase } from "../subtitles/capitals.ts";
import type { Cue } from "../subtitles/cue.ts";
import { decodeSubtitle } from "../subtitles/decode.ts";
import { mergeDual } from "../subtitles/dual.ts";
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
import { anchorDecided, anchorFor, type Anchor } from "./anchors.ts";
import { recalledFileHash, withFileHash } from "./file-hashes.ts";
import { candidateKey, decodeRef, type CandidateRef, type SubtitleRef } from "./refs.ts";

export type Attempt = {
  candidate: CandidateRef;
  track?: Track;
  result?: RetimeResult;
  hidden?: Hidden;
};
export type Download = (candidate: CandidateRef, served?: boolean) => Promise<Track>;
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

type AnchorDeps = Pick<RouteDeps, "state" | "singleFlight" | "openTimings">;
type FileRef = Pick<SubtitleRef, "q" | "a" | "x" | "w" | "d">;

const sharedFor = ({ openTimings, state }: AnchorDeps, config: Config, { w, d }: FileRef) =>
  openTimings === undefined || w === undefined || !config.useShared
    ? Promise.resolve(undefined)
    : fileShared(
        openTimings,
        state,
        { hash: w.h, size: w.z },
        viewerOf(config, openTimings.installSalt),
        d,
      );

const fileAnchor = (
  { state, singleFlight }: AnchorDeps,
  ref: FileRef,
  download: Download,
  shared: Shared | undefined,
) => anchorFor({ state, singleFlight, prepared: preparedAnchor(shared) }, ref, download);

export const warmAnchor = async (
  deps: AnchorDeps,
  config: Config,
  ref: FileRef,
  download: Download,
) => {
  if (config.timing === "off" || (await anchorDecided(deps.state, ref))) {
    return;
  }

  await fileAnchor(deps, ref, download, await sharedFor(deps, config, ref));
};

export type Downloader = Download & { has: (candidate: CandidateRef) => boolean };

export const downloader = (sources: SourceSet, signal?: AbortSignal): Downloader => {
  const byName = new Map(
    [...sources.listed, ...sources.references].map((source) => [source.name, source]),
  );
  const downloads = new Map<string, Promise<Track>>();

  const download = (candidate: CandidateRef, served = false) => {
    const key = candidateKey(candidate.n, candidate.r);
    const known = downloads.get(key);
    const fresh = () => fetchTrack(byName, candidate, signal, served);
    const track = (served && known !== undefined ? known.catch(fresh) : known) ?? fresh();

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

const timedCues = (attempt: Attempt, config: Config): Cue[] | undefined => {
  const { candidate, result } = attempt;

  const unfit =
    result?.kind === "not-retimed" && result.noFit === true && !timedAsIs(candidate, config);

  return result?.kind === "mismatch" || unfit ? undefined : servedCues(attempt, config);
};

export async function* resolveAttempts(
  ref: Pick<SubtitleRef, "c" | "x" | "a">,
  config: Config,
  download: Download,
  signal?: AbortSignal,
  shared?: Shared,
  {
    lazyReferences = false,
    anchorOf,
    cuesOf = servedCues,
  }: {
    lazyReferences?: boolean;
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
  };

  if (!lazyReferences && ref.c[0]?.h !== 1 && ref.a === undefined) {
    timing.references();
  }

  for (const candidate of ref.c) {
    const attempt: Attempt = await download(candidate, true)
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

type Cased = (cues: Cue[], served: CandidateRef) => Promise<Cue[]>;

const keyOf = ({ n, r }: CandidateRef) => candidateKey(n, r);

const mixedCaseOf = async (candidates: CandidateRef[], download: Download) =>
  (await settledTracks(candidates.map((candidate) => download(candidate))))
    .map((track) => track.cues)
    .filter((cues) => !isMostlyCapitals(cues));

const vocabularyOf = async (pool: CandidateRef[], download: Downloader) => {
  const free = pool.filter(({ m }) => m !== 1);
  const [fresh] = free.filter((candidate) => !download.has(candidate));

  const known = await mixedCaseOf(
    free.filter((candidate) => download.has(candidate)),
    download,
  );

  return known.length > 0 || fresh === undefined ? known : mixedCaseOf([fresh], download);
};

const casedFor =
  (ref: SubtitleRef, download: Downloader): Cased =>
  async (cues, served) => {
    if (!isCapitals(cues)) {
      return cues;
    }

    const pool = [...(ref.a ?? []), ...ref.c, ...(ref.s ?? []), ...ref.x].filter(
      (candidate) => candidate.l === served.l && keyOf(candidate) !== keyOf(served),
    );
    const others = [...new Map(pool.map((candidate) => [keyOf(candidate), candidate])).values()];

    return recase(cues, await vocabularyOf(others, download), served.l);
  };

const firstServed = (attempts: Attempt[], config: Config, cuesOf = servedCues) =>
  attempts.flatMap((attempt) => {
    const cues = cuesOf(attempt, config);

    return cues === undefined ? [] : [{ candidate: attempt.candidate, cues }];
  })[0];

const servedOf = async (
  attempts: Attempt[],
  config: Config,
  dialogueOnly: boolean,
  cased: Cased,
): Promise<Served> => {
  const served = firstServed(attempts, config);
  const shown =
    served === undefined
      ? undefined
      : await cased(
          dialogueOnly ? stripHearingImpaired(served.cues) : served.cues,
          served.candidate,
        );

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

const dualServedOf = async (
  attempts: Attempt[][],
  config: Config,
  cased: Cased,
): Promise<Served> => {
  const [primary = [], secondary = []] = await Promise.all(
    attempts.map(async (each) => {
      const served = firstServed(each, config, timedCues);

      return served === undefined ? [] : cased(served.cues, served.candidate);
    }),
  );

  return primary.length === 0 || secondary.length === 0
    ? { found: false, srt: "" }
    : { found: true, srt: writeSRT(mergeDual(primary, secondary)) };
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
    const timed = async <T>(name: string, work: () => Promise<T>) => {
      startTime(context, name);

      try {
        return await work();
      } finally {
        endTime(context, name);
      }
    };
    const produce = async () => {
      const shared = await timed("shared", () =>
        sharedFor({ state, singleFlight, openTimings }, config, ref),
      );
      const download = downloader(sourcesFor(config, context.get("tokens")));
      let anchoring: Promise<Anchor | undefined> | undefined;
      const anchorOf = () => {
        anchoring ??= timed("anchor", () =>
          fileAnchor({ state, singleFlight, openTimings }, ref, download, shared),
        );

        return anchoring;
      };
      const cuesOf = ref.s === undefined ? servedCues : timedCues;
      const attempts = await Promise.all(
        [ref.c, ...(ref.s === undefined ? [] : [ref.s])].map((c) =>
          recordAttempts(
            resolveAttempts({ ...ref, c }, config, download, undefined, shared, {
              anchorOf,
              cuesOf,
            }),
          ),
        ),
      );
      const cased = casedFor(ref, download);
      const fresh =
        ref.s === undefined
          ? await servedOf(attempts.flat(), config, ref.t === "dialogue", cased)
          : await dualServedOf(attempts, config, cased);

      if (config.share && video !== undefined) {
        shares.push(...sharesOf(attempts.flat(), video));
      }

      if (fresh.srt !== "") {
        await subtitles?.set(id, fresh.srt);
      }

      return fresh;
    };
    const flown = await timed("flight", () =>
      singleFlight(id, async () => encodeServed(await timed("produce", produce))),
    );
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
