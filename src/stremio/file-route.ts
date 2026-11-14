import { createHash } from "node:crypto";
import type { Context } from "hono";
import type { AppEnv, RouteDeps } from "../app.ts";
import type { Config } from "../config/config.ts";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";
import type { SourceSet } from "../sources/from-config.ts";
import type { Candidate, Source } from "../sources/source.ts";
import type { Cue } from "../subtitles/cue.ts";
import { decodeSubtitle } from "../subtitles/decode.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import { parseRelease } from "../subtitles/release.ts";
import { writeSRT } from "../subtitles/write.ts";
import { retime, type RetimeResult } from "../timing/retime.ts";
import { decodeRef, type CandidateRef, type SubtitleRef } from "./refs.ts";

export type Track = { candidate: Candidate; cues: Cue[] };
export type Attempt = { candidate: CandidateRef; track?: Track; result?: RetimeResult };
export type Download = (candidate: CandidateRef) => Promise<Track>;
export type SubtitleCache = {
  get(id: string): Promise<string | undefined>;
  set(id: string, srt: string): Promise<void>;
};

type Served = { found: boolean; srt: string };

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

const timeTrack = async (
  track: Track,
  references: Promise<Track[]>,
  config: Config,
  signal: AbortSignal | undefined,
): Promise<RetimeResult> => {
  if (track.candidate.hashMatch) {
    return { kind: "made-for-file", cues: track.cues };
  }

  if (config.timing === "off") {
    return { kind: "not-retimed", cues: track.cues };
  }

  const ready = await references;

  signal?.throwIfAborted();

  return retime(track, ready);
};

export const downloader = (sources: SourceSet, signal?: AbortSignal): Download => {
  const byName = new Map(
    [...sources.listed, ...sources.references].map((source) => [source.name, source]),
  );
  const downloads = new Map<string, Promise<Track>>();

  return (candidate) => {
    const key = JSON.stringify([candidate.n, candidate.r]);
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
): AsyncGenerator<Attempt> {
  const references =
    config.timing === "off" ? Promise.resolve([]) : settledTracks(ref.x.map(download));

  for (const candidate of ref.c) {
    const attempt: Attempt = await download(candidate)
      .then(async (track) => ({
        candidate,
        track,
        result: await timeTrack(track, references, config, signal),
      }))
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

const decodeServed = (text: string): Served => {
  const { found, srt } = JSON.parse(text) as Served;

  return { found, srt: Buffer.from(srt, "base64").toString("utf8") };
};

const serve = async (ref: SubtitleRef, config: Config, sources: SourceSet): Promise<Served> => {
  const attempts = await recordAttempts(resolveAttempts(ref, config, downloader(sources)));
  const cues = attempts
    .map((attempt) => servedCues(attempt, config))
    .find((each) => each !== undefined);

  if (cues !== undefined) {
    return { found: true, srt: writeSRT(cues) };
  }

  return {
    found: attempts.some((attempt) => attempt.result?.kind === "mismatch") && !config.bestOnly,
    srt: "",
  };
};

const srtResponse = (context: Context<AppEnv>, srt: string) =>
  context.body(srt, 200, { "content-type": srtType, "cache-control": "public, max-age=86400" });

export const fileRoute =
  ({ sourcesFor, refKey, singleFlight, subtitles }: RouteDeps) =>
  async (context: Context<AppEnv>) => {
    const config = context.get("config");
    const ref = (() => {
      try {
        return decodeRef((context.req.param("file") ?? "").replace(/\.srt$/, ""), refKey);
      } catch {
        return undefined;
      }
    })();

    if (ref === undefined) {
      return context.text("Invalid subtitle reference", 400);
    }

    const id = createHash("sha256").update(new URL(context.req.url).pathname).digest("hex");
    const cached = await subtitles?.get(id);

    if (cached !== undefined) {
      return srtResponse(context, cached);
    }

    const served = decodeServed(
      await singleFlight(id, async () => {
        const fresh = await serve(ref, config, sourcesFor(config, context.get("tokens")));

        if (fresh.srt !== "") {
          await subtitles?.set(id, fresh.srt);
        }

        return encodeServed(fresh);
      }),
    );

    if (!served.found) {
      return context.text("No subtitle fits this file", 404);
    }

    return served.srt === ""
      ? context.body("", 200, { "content-type": srtType })
      : srtResponse(context, served.srt);
  };
