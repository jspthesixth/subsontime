import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { Context } from "hono";
import { endTime, startTime } from "hono/timing";
import * as v from "valibot";
import type { AppEnv, RouteDeps } from "../app.ts";
import type { Config } from "../config/config.ts";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";
import { isCapitals, isMostlyCapitals, recase } from "../subtitles/capitals.ts";
import type { Cue } from "../subtitles/cue.ts";
import { mergeDual } from "../subtitles/dual.ts";
import { stripHearingImpaired } from "../subtitles/hearing-impaired.ts";
import { writeSRT } from "../subtitles/write.ts";
import { errorName } from "../error-name.ts";
import type { Track } from "../timing/retime.ts";
import { submitFix, submitMismatch } from "../timings/api.ts";
import {
  fileShared,
  hiddenMatch,
  sharedFix,
  viewerOf,
  type OpenTimings,
  type Shared,
} from "./open-timings.ts";
import { anchorDecided, anchorFor, type Anchor } from "./anchors.ts";
import {
  downloader,
  offSpeed,
  recordAttempts,
  resolveAttempts,
  servedCues,
  settledTracks,
  sharesOf,
  timedCues,
  type Attempt,
  type Download,
  type Downloader,
  type Share,
} from "./attempts.ts";
import { recalledFileHash, withFileHash } from "./file-hashes.ts";
import { recordPick } from "./timing-choices.ts";
import { candidateKey, decodeRef, type CandidateRef, type SubtitleRef } from "./refs.ts";

export type SubtitleCache = {
  get(id: string): Promise<string | undefined>;
  set(id: string, srt: string): Promise<void>;
};

type Served = { found: boolean; srt: string };
const submitters = { fix: submitFix, mismatch: submitMismatch };
const srtType = "application/x-subrip; charset=utf-8";
const srtSeconds = 24 * 60 * 60;
const unservedSeconds = 10 * 60;

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

export const subtitleCache = (state: SharedState): SubtitleCache => ({
  get: (id) => orMiss(() => state.get(`srt:${id}`), undefined),
  set: (id, srt) => orMiss(() => state.set(`srt:${id}`, srt, srtSeconds), undefined),
});

const encodeServed = ({ found, srt }: Served) => JSON.stringify([found, srt]);

const servedSchema = v.tuple([v.boolean(), v.string()]);

const decodeServed = (text: string): Served | undefined => {
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), servedSchema), text);

  return parsed.success ? { found: parsed.output[0], srt: parsed.output[1] } : undefined;
};

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
  attempts
    .toSorted((a, b) => Number(offSpeed(a)) - Number(offSpeed(b)))
    .flatMap((attempt) => {
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

    if (ref.f !== undefined && ref.q.s !== undefined) {
      defer(recordPick(state, config.installId, ref.q.i, ref.q.s, ref.f));
    }

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
      const download = downloader(sourcesFor(config, context.get("tokens")), undefined, state);
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
              state,
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

      if (fresh.srt === "") {
        await orMiss(
          () => state.set(`unserved:${id}`, encodeServed(fresh), unservedSeconds),
          undefined,
        );
      } else {
        await subtitles?.set(id, fresh.srt);
      }

      return fresh;
    };
    const unserved = decodeServed(
      (await orMiss(() => state.get(`unserved:${id}`), undefined)) ?? "",
    );
    const served =
      unserved ??
      decodeServed(
        await timed("flight", () =>
          singleFlight(id, async () => encodeServed(await timed("produce", produce))),
        ),
      ) ??
      (await produce());

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
