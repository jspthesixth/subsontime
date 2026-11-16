import type { Context } from "hono";
import { baseURL } from "../base-url.ts";
import type { AppEnv, RouteDeps } from "../app.ts";
import { searchAll } from "../sources/search-all.ts";
import {
  openSubtitlesAPIName,
  openSubtitlesV3Name,
  type SourceSet,
} from "../sources/from-config.ts";
import type { Candidate, VideoQuery } from "../sources/source.ts";
import { parseStremioId } from "../sources/stremio-addon.ts";
import {
  inReleaseFamily,
  isDiscOrWeb,
  looksLikeRip,
  parseRelease,
  releaseFamilyOf,
  type ReleaseFamily,
} from "../subtitles/release.ts";
import { minimumScoreOf, rankingOf, scoreOf } from "../subtitles/score.ts";
import { anchorWithGuardsOf } from "../timing/anchor.ts";
import { freeFirst, pickReferences } from "../timing/references.ts";
import { errorName, hiddenKeyFor, videoKeyOf, viewerOf } from "./open-timings.ts";
import { fileKeyOf, recalledFileHash, recordFileHash } from "./file-hashes.ts";
import { encodeRef, type CandidateRef, type SubtitleRef } from "./refs.ts";
import {
  recalledReleaseFamily,
  recordReleaseFamily,
  releaseFamilyKeyOf,
} from "./release-families.ts";

export const bestSlotSize = 4;
const perLanguageLimit = 10;
const displayNames = new Map([["OpenSubtitles API", "OpenSubtitles"]]);

export const labelOf = (candidates: Candidate[], dialogueOnly = false) => {
  const sources = new Set(
    candidates.map(({ sourceName }) => displayNames.get(sourceName) ?? sourceName),
  );
  const notes = [
    candidates.every(({ hashMatch }) => hashMatch) ? ["made for this file"] : [],
    dialogueOnly ? ["dialogue only"] : [],
  ].flat();
  const name = [...sources].join(", ");

  return notes.length === 0 ? name : `${name} (${notes.join(", ")})`;
};

export const toCandidateRef = (candidate: Candidate): CandidateRef => ({
  n: candidate.sourceName,
  r: candidate.ref,
  l: candidate.lang,
  h: candidate.hashMatch ? 1 : undefined,
  p: candidate.fps,
});

const familySources = new Set([openSubtitlesV3Name, openSubtitlesAPIName]);

export const searchVideo = async (
  sources: SourceSet,
  query: VideoQuery,
  learnedFamily: Promise<ReleaseFamily | undefined> = Promise.resolve(undefined),
) => {
  const [listed, referenceOnly, family] = await Promise.all([
    searchAll(sources.listed, query),
    searchAll(sources.references, query),
    learnedFamily,
  ]);

  const fileRelease = parseRelease(query.filename ?? "");
  const everything = [...listed, ...referenceOnly];
  const all = everything.filter(({ lang }) => query.languages.includes(lang));
  const inFamily = ({ release }: Candidate) =>
    family !== undefined && inReleaseFamily(release, family);
  const learned = pickReferences(all, fileRelease, family);
  const ripGuess = family === undefined && looksLikeRip(query.filename ?? "");
  const guessed = ({ release }: Candidate) => ripGuess && isDiscOrWeb(release);
  const fromGuess = learned.length === 0 && ripGuess;
  const references = fromGuess ? freeFirst(all.filter(guessed)) : learned;
  const scoreContext = { video: query, fileRelease, family, ripGuess };
  const ranking = rankingOf(scoreContext);

  return {
    references,
    anchors: anchorWithGuardsOf(
      everything.filter(({ metered }) => metered !== true).toSorted(ranking),
      scoreContext,
    ),
    referencesFor: (candidates: Candidate[]) => {
      const first = candidates[0];
      const allInFamily = candidates.every(
        (candidate) => !candidate.hashMatch && inFamily(candidate),
      );
      const guessedFirst = fromGuess && first !== undefined && isDiscOrWeb(first.release);

      return allInFamily || guessedFirst ? [] : references;
    },
    observedFamily: all
      .filter(
        ({ hashMatch, sourceName, release }) =>
          hashMatch && familySources.has(sourceName) && release.source !== undefined,
      )
      .map(({ release }) => releaseFamilyOf(release))
      .find((observed) => observed !== undefined),
    ranked: (lang: string) =>
      listed.filter((candidate) => candidate.lang === lang).toSorted(ranking),
    passing: (candidates: Candidate[]) => {
      const minimum = minimumScoreOf(query.type);
      const kept = candidates.filter((candidate) => scoreOf(candidate, scoreContext) >= minimum);

      return kept.length > 0 ? kept : candidates;
    },
  };
};

const readExtras = (context: Context<AppEnv>) => {
  const extra = context.req.param("extra");
  const raw = new URL(context.req.url).pathname.split("/").at(-1) ?? "";
  const text = raw.includes("=") ? raw : (extra ?? "");

  return new URLSearchParams(extra === undefined ? "" : text.replace(/\.json$/, ""));
};

export const subtitlesRoute =
  ({ sourcesFor, refKey, publicURL, state, openTimings, defer }: RouteDeps) =>
  async (context: Context<AppEnv>) => {
    const config = context.get("config");
    const extra = context.req.param("extra");
    const id = context.req.param("id") ?? "";
    const video = (() => {
      try {
        return parseStremioId(
          context.req.param("type") ?? "",
          extra === undefined ? id.replace(/\.json$/, "") : id,
        );
      } catch {
        return undefined;
      }
    })();

    if (video === undefined) {
      return context.json({ error: "Unsupported video id" }, 400);
    }

    const extras = readExtras(context);
    const filename = extras.get("filename") ?? undefined;
    const videoSize = Number(extras.get("videoSize") ?? Number.NaN);
    const q = { t: video.type, i: video.imdbId, s: video.season, e: video.episode };
    const fileKey =
      filename === undefined
        ? undefined
        : fileKeyOf(context.req.param("config") ?? "", q, filename);
    const listed = videoKeyOf(
      extras.get("videoHash") ?? undefined,
      Number.isFinite(videoSize) ? videoSize : undefined,
    );
    const familyKey =
      video.season === undefined || filename === undefined
        ? undefined
        : releaseFamilyKeyOf(video.imdbId, video.season, filename);
    const family =
      familyKey === undefined || !config.useShared
        ? Promise.resolve(undefined)
        : recalledReleaseFamily(state, familyKey);
    const recalled =
      listed !== undefined || fileKey === undefined
        ? undefined
        : await recalledFileHash(state, fileKey);
    const fingerprint =
      listed ?? (recalled === undefined ? undefined : { hash: recalled.w.h, size: recalled.w.z });
    const query = {
      ...video,
      videoHash: fingerprint?.hash ?? extras.get("videoHash") ?? undefined,
      videoSize: fingerprint?.size ?? (Number.isFinite(videoSize) ? videoSize : undefined),
      filename,
      languages: config.languages,
    };
    const [found, hiddenKey] = await Promise.all([
      searchVideo(sourcesFor(config, context.get("tokens")), query, family),
      openTimings === undefined || listed === undefined || !config.useShared
        ? undefined
        : hiddenKeyFor(openTimings, state, listed, viewerOf(config, openTimings.installSalt)),
    ]);

    const unflagged = (ref: CandidateRef) =>
      recalled === undefined ? ref : { ...ref, h: undefined };
    const references = found.references.map(toCandidateRef);
    const anchors = found.anchors.map(toCandidateRef).map(unflagged);

    const recording = [
      ...(listed === undefined || fileKey === undefined
        ? []
        : [
            recordFileHash(state, fileKey, {
              w: { h: listed.hash, z: listed.size },
              x: references,
              m: config.languages.flatMap((lang) =>
                found
                  .ranked(lang)
                  .filter(({ hashMatch }) => hashMatch)
                  .map(({ sourceName, ref }): [string, string] => [sourceName, ref]),
              ),
              d: hiddenKey,
            }),
          ]),
      ...(listed === undefined ||
      familyKey === undefined ||
      found.observedFamily === undefined ||
      !config.share
        ? []
        : [recordReleaseFamily(state, familyKey, found.observedFamily)]),
    ];

    if (recording.length > 0) {
      try {
        defer(Promise.all(recording));
      } catch (error) {
        console.error(`Listing record failed: ${errorName(error)}`);
      }
    }

    const subURL = (candidates: Candidate[], t?: SubtitleRef["t"]) => {
      const ref = encodeRef(
        {
          v: 1,
          q,
          c: candidates.map(toCandidateRef).map(unflagged),
          x: found.referencesFor(candidates).map(toCandidateRef).map(unflagged),
          a: anchors.length === 0 ? undefined : anchors,
          w: listed === undefined ? undefined : { h: listed.hash, z: listed.size },
          k: listed === undefined ? fileKey : undefined,
          d: hiddenKey,
          t,
        },
        refKey,
      );

      return `${baseURL(context, publicURL)}/${context.req.param("config")}/sub/${ref}.srt`;
    };
    const subtitles = config.languages.flatMap((lang) => {
      const candidates = found.ranked(lang);

      if (candidates.length === 0) {
        return [];
      }

      const best = found.passing(candidates).slice(0, bestSlotSize);
      const entries = config.bestOnly
        ? [{ id: `${lang}-best`, lang, label: labelOf(best), url: subURL(best) }]
        : candidates.slice(0, perLanguageLimit).map((candidate, index) => ({
            id: `${lang}-${index + 1}`,
            lang,
            label: labelOf([candidate]),
            url: subURL([candidate]),
          }));

      return config.extras.dialogueOnly
        ? entries.toSpliced(1, 0, {
            id: `${lang}-dialogue`,
            lang,
            label: labelOf(best, true),
            url: subURL(best, "dialogue"),
          })
        : entries;
    });

    return context.json({ subtitles }, 200, { "cache-control": "public, max-age=3600" });
  };
