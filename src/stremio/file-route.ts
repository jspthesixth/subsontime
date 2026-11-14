import type { Context } from "hono";
import type { AppEnv } from "../app.ts";
import type { Config } from "../config/config.ts";
import { singleFlight } from "../jobs/single-flight.ts";
import type { SourceSet } from "../sources/from-config.ts";
import type { Candidate, Source } from "../sources/source.ts";
import type { Cue } from "../subtitles/cue.ts";
import { decodeSubtitle } from "../subtitles/decode.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import { parseRelease } from "../subtitles/release.ts";
import { writeSRT } from "../subtitles/write.ts";
import { retime } from "../timing/retime.ts";
import { decodeRef, type CandidateRef, type SubtitleRef } from "./refs.ts";

type Track = { candidate: Candidate; cues: Cue[] };
type Outcome = Cue[] | "mismatch" | undefined;

const downloadTimeoutMs = 8000;
const srtType = "application/x-subrip; charset=utf-8";

const toCandidate = (ref: CandidateRef): Candidate => ({
  sourceName: ref.n,
  ref: ref.r,
  lang: ref.l,
  release: parseRelease(""),
  hashMatch: ref.h === 1,
  fps: ref.p,
});

const fetchTrack = async (sources: Map<string, Source>, ref: CandidateRef): Promise<Track> => {
  const source = sources.get(ref.n);

  if (source === undefined) {
    throw new Error("Unknown source");
  }

  const bytes = await source.download(ref.r, AbortSignal.timeout(downloadTimeoutMs));

  return { candidate: toCandidate(ref), cues: parseSubtitle(decodeSubtitle(bytes, ref.l)) };
};

const fetchReferences = async (sources: Map<string, Source>, refs: CandidateRef[]) =>
  (await Promise.allSettled(refs.map((ref) => fetchTrack(sources, ref)))).flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );

const timedCues = async (track: Track, references: Track[], config: Config): Promise<Outcome> => {
  if (config.timing === "off") {
    return track.cues;
  }

  const result = await retime(track, references);

  if (result.kind !== "mismatch") {
    return result.cues;
  }

  return config.extras.hideMismatches ? "mismatch" : track.cues;
};

const resolveSubtitle = async (
  ref: SubtitleRef,
  config: Config,
  sources: SourceSet,
): Promise<Outcome> => {
  const byName = new Map(
    [...sources.listed, ...sources.references].map((source) => [source.name, source]),
  );
  const references = config.timing === "off" ? Promise.resolve([]) : fetchReferences(byName, ref.x);
  let outcome: Outcome;

  for (const candidate of ref.c) {
    const track = await fetchTrack(byName, candidate).catch(() => undefined);

    if (track !== undefined) {
      outcome = await timedCues(track, await references, config);
    }

    if (Array.isArray(outcome)) {
      return outcome;
    }
  }

  return outcome;
};

export const fileRoute =
  (sourcesFor: (config: Config) => SourceSet) => async (context: Context<AppEnv>) => {
    const config = context.get("config");
    const ref = (() => {
      try {
        return decodeRef((context.req.param("file") ?? "").replace(/\.srt$/, ""));
      } catch {
        return undefined;
      }
    })();

    if (ref === undefined) {
      return context.json({ error: "Invalid subtitle reference" }, 400);
    }

    const outcome = await singleFlight(new URL(context.req.url).pathname, () =>
      resolveSubtitle(ref, config, sourcesFor(config)),
    );

    if (Array.isArray(outcome)) {
      return context.body(writeSRT(outcome), 200, {
        "content-type": srtType,
        "cache-control": "public, max-age=86400",
      });
    }

    if (outcome === "mismatch" && !config.bestOnly) {
      return context.body("", 200, { "content-type": srtType });
    }

    return context.text("No subtitle fits this file", 404);
  };
