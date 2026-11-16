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
  isHearingImpaired,
  sourceKindOf,
  looksLikeRip,
  parseRelease,
  releaseFamilyOf,
  type ReleaseFamily,
} from "../subtitles/release.ts";
import { minimumScoreOf, rankingOf, scoreOf } from "../subtitles/score.ts";
import { freeFirst, pickReferences } from "../timing/references.ts";
import { errorName, listingTimingsFor, videoKeyOf, viewerOf } from "./open-timings.ts";
import { fileKeyOf, recalledFileHash, recordFileHash } from "./file-hashes.ts";
import { downloader } from "./file-route.ts";
import { encodeRef, type CandidateRef, type SubtitleRef } from "./refs.ts";
import {
  familyKindOf,
  timingFamiliesFor,
  timingFamilyKeyOf,
  timingNamesOf,
} from "./timing-families.ts";
import {
  recalledReleaseFamily,
  recordReleaseFamily,
  releaseFamilyKeyOf,
} from "./release-families.ts";

export const bestSlotSize = 4;
const perLanguageLimit = 10;
const familyCandidatesPerLanguage = 4;
const pendingCacheSeconds = 60;
const listingCacheSeconds = 3600;
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
  const all = [...listed, ...referenceOnly];
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
    evidence: learned.length > 0 || family !== undefined,
    ranking,
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

const hearingImpaired = (candidate: Candidate) => isHearingImpaired(candidate.releaseName ?? "");

type Entry = { candidates: Candidate[]; references?: Candidate[]; name?: string };

const labelled = ({ candidates, name }: Entry, dialogueOnly = false) =>
  name === undefined
    ? labelOf(candidates, dialogueOnly)
    : `${labelOf(candidates, dialogueOnly)}, ${name}`;

const readExtras = (context: Context<AppEnv>) => {
  const extra = context.req.param("extra");
  const raw = new URL(context.req.url).pathname.split("/").at(-1) ?? "";
  const text = raw.includes("=") ? raw : (extra ?? "");

  return new URLSearchParams(extra === undefined ? "" : text.replace(/\.json$/, ""));
};

export const subtitlesRoute =
  ({
    sourcesFor,
    refKey,
    publicURL,
    state,
    openTimings,
    defer,
    timingFamilyTimeBoxMs,
  }: RouteDeps) =>
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
    const releaseFamily =
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
    const sources = sourcesFor(config, context.get("tokens"));
    const viewer =
      openTimings === undefined ? undefined : viewerOf(config, openTimings.installSalt);
    const withoutShared = openTimings === undefined || listed === undefined || !config.useShared;
    const [found, timings] = await Promise.all([
      searchVideo(sources, query, releaseFamily),
      withoutShared ? undefined : listingTimingsFor(openTimings, state, listed, viewer),
    ]);

    const hiddenKey = timings?.hiddenKey;

    const unflagged = (ref: CandidateRef) =>
      recalled === undefined ? ref : { ...ref, h: undefined };
    const references = found.references.map(toCandidateRef);

    const hashMatches = config.languages.flatMap((lang) =>
      found
        .ranked(lang)
        .filter(({ hashMatch }) => hashMatch)
        .map(({ sourceName, ref }): [string, string] => [sourceName, ref]),
    );
    const recording = [
      ...(listed === undefined || fileKey === undefined
        ? []
        : [
            recordFileHash(state, fileKey, {
              w: { h: listed.hash, z: listed.size },
              x: hashMatches.length > 0 ? references : [],
              m: hashMatches,
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

    const clustering = !found.evidence && timings?.fixed !== true && config.bestOnly;
    const download = downloader(sources);
    const clustered = await Promise.all(
      config.languages.map(async (lang) => {
        const candidates = found
          .passing(found.ranked(lang))
          .slice(0, familyCandidatesPerLanguage)
          .filter(({ metered }) => metered !== true);

        return clustering && candidates.length >= 2
          ? timingFamiliesFor({
              state,
              key: timingFamilyKeyOf(q, lang, candidates),
              candidates,
              download: (candidate) => download(toCandidateRef(candidate)),
              defer,
              timeBoxMs: timingFamilyTimeBoxMs,
            })
          : { families: [], pending: false };
      }),
    );
    const pending = clustered.some((result) => result.pending);
    const listedOrder = (candidate: Candidate) => found.ranked(candidate.lang).indexOf(candidate);
    const inFamilyOrder = (members: Candidate[]) =>
      members.toSorted(
        (a, b) =>
          Number(hearingImpaired(a)) - Number(hearingImpaired(b)) ||
          listedOrder(a) - listedOrder(b),
      );
    const families = clustered
      .flatMap((result) => result.families)
      .map(inFamilyOrder)
      .toSorted((a, b) => (a[0] && b[0] ? found.ranking(a[0], b[0]) : 0));
    const fileKind = sourceKindOf(parseRelease(filename ?? ""));
    const discFallback =
      fileKind === "disc"
        ? config.languages
            .flatMap((lang) => found.passing(found.ranked(lang)))
            .filter(({ release }) => sourceKindOf(release) === "disc")
            .slice(0, 1)
        : [];
    const namedFamilies = families.filter((family) => familyKindOf(family) === fileKind);
    const settled = clustering && !pending;

    const subURL = (
      candidates: Candidate[],
      t?: SubtitleRef["t"],
      entryReferences = found.referencesFor(candidates),
    ) => {
      const ref = encodeRef(
        {
          v: 1,
          q,
          c: candidates.map(toCandidateRef).map(unflagged),
          x: entryReferences.map(toCandidateRef).map(unflagged),
          w: listed === undefined ? undefined : { h: listed.hash, z: listed.size },
          k: listed === undefined ? fileKey : undefined,
          d: hiddenKey,
          t,
        },
        refKey,
      );

      return `${baseURL(context, publicURL)}/${context.req.param("config")}/sub/${ref}.srt`;
    };

    const bestEntriesOf = (lang: string, best: Candidate[]): Entry[] => {
      if (!settled) {
        return [{ candidates: best }];
      }

      const own = families.filter((family) => family[0]?.lang === lang);
      const withFallbacks = (family: Candidate[]) =>
        [...family, ...best.filter((candidate) => !family.includes(candidate))].slice(
          0,
          bestSlotSize,
        );
      const named =
        namedFamilies.find((family) => family[0]?.lang === lang) ??
        namedFamilies[0] ??
        (discFallback.length > 0 ? discFallback : undefined);

      if (fileKind !== undefined && named !== undefined) {
        return named[0]?.lang === lang
          ? [{ candidates: withFallbacks(named), references: named.slice(0, 1) }]
          : [{ candidates: best, references: named.slice(0, 3) }];
      }

      if (fileKind === undefined && own.length > 1) {
        const names = timingNamesOf(own);

        return own.map((family, index) => ({
          candidates: withFallbacks(family),
          references: family.slice(0, 1),
          name: names[index],
        }));
      }

      const worthy = found
        .referencesFor(best)
        .filter((reference) => families.some((family) => family.includes(reference)));

      return [{ candidates: best, references: worthy }];
    };
    const subtitles = config.languages.flatMap((lang) => {
      const candidates = found.ranked(lang);

      if (candidates.length === 0) {
        return [];
      }

      const best = found.passing(candidates).slice(0, bestSlotSize);
      const chosenEntries = bestEntriesOf(lang, best);
      const bestEntries = chosenEntries.map((entry, index) => ({
        id: index === 0 ? `${lang}-best` : `${lang}-best-${index + 1}`,
        lang,
        label: labelled(entry),
        url: subURL(entry.candidates, undefined, entry.references),
      }));
      const entries = config.bestOnly
        ? bestEntries
        : candidates.slice(0, perLanguageLimit).map((candidate, index) => ({
            id: `${lang}-${index + 1}`,
            lang,
            label: labelOf([candidate]),
            url: subURL([candidate]),
          }));
      const dialogue = chosenEntries[0] ?? { candidates: best };

      return config.extras.dialogueOnly
        ? entries.toSpliced(1, 0, {
            id: `${lang}-dialogue`,
            lang,
            label: labelled(dialogue, true),
            url: subURL(dialogue.candidates, "dialogue", dialogue.references),
          })
        : entries;
    });

    return context.json({ subtitles }, 200, {
      "cache-control": `public, max-age=${pending ? pendingCacheSeconds : listingCacheSeconds}`,
    });
  };
