import type { Context } from "hono";
import { baseURL } from "../base-url.ts";
import { englishNameOf, nativeNameOf } from "../languages.ts";
import type { AppEnv, RouteDeps } from "../app.ts";
import type { Candidate } from "../sources/source.ts";
import { parseStremioId } from "../sources/stremio-addon.ts";
import { errorName } from "../error-name.ts";
import { hiddenKeyFor, videoKeyOf, viewerOf } from "./open-timings.ts";
import { canBeTimed, downloader } from "./attempts.ts";
import { fileKeyOf, recalledFileHash, recordFileHash } from "./file-hashes.ts";
import { warmAnchor } from "./file-route.ts";
import { encodeRef, type CandidateRef, type SubtitleRef } from "./refs.ts";
import { clientOf, countListing, fileSentOf } from "./request-counts.ts";
import { recalledPick, releaseChoices, type TimingChoice } from "./timing-choices.ts";
import {
  recalledReleaseFamily,
  recordReleaseFamily,
  releaseFamilyKeyOf,
} from "./release-families.ts";
import {
  bestGroupsOf,
  bestSlotSize,
  bySource,
  labelOf,
  searchVideo,
  type Arranged,
  toCandidateRef,
  withFree,
} from "./search.ts";

const perLanguageLimit = 10;

const bestIdOf = (lang: string, index: number) =>
  index === 0 ? `${lang}-best` : `${lang}-best-${index + 1}`;

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
    trustProxy,
    state,
    singleFlight,
    openTimings,
    defer,
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
    const { dualLanguage } = config.extras;

    const query = {
      ...video,
      videoHash: fingerprint?.hash ?? extras.get("videoHash") ?? undefined,
      videoSize: fingerprint?.size ?? (Number.isFinite(videoSize) ? videoSize : undefined),
      filename,
      languages:
        dualLanguage === undefined
          ? config.languages
          : [...new Set([...config.languages, dualLanguage])],
    };
    const sent = fileSentOf(fingerprint !== undefined, filename !== undefined);
    const offerChoices = sent === "neither" && config.timing !== "off";
    const pick =
      offerChoices && video.season !== undefined
        ? recalledPick(state, config.installId, video.imdbId, video.season)
        : undefined;
    const sources = sourcesFor(config, context.get("tokens"));
    const [found, hiddenKey, picked] = await Promise.all([
      searchVideo(sources, query, family),
      openTimings === undefined || listed === undefined || !config.useShared
        ? undefined
        : hiddenKeyFor(openTimings, state, listed, viewerOf(config, openTimings.installSalt)),
      pick,
    ]);

    const unflagged = (ref: CandidateRef) =>
      recalled === undefined ? ref : { ...ref, h: undefined };
    const references = found.references.map(toCandidateRef);
    const anchors = found.anchors.map(toCandidateRef);

    const recording = [
      countListing(state, clientOf(context.req.header("user-agent")), sent),
      ...(listed === undefined || fileKey === undefined
        ? []
        : [
            recordFileHash(state, fileKey, {
              w: { h: listed.hash, z: listed.size },
              x: references,
              a: anchors.length === 0 ? undefined : anchors,
              m: query.languages.flatMap((lang) =>
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

    const warming =
      listed === undefined || anchors.length === 0
        ? []
        : [
            warmAnchor(
              { state, singleFlight, openTimings },
              config,
              { q, a: anchors, x: references, w: { h: listed.hash, z: listed.size }, d: hiddenKey },
              downloader(sources, undefined, state),
            ).catch((error: unknown) =>
              console.error(`Anchor warm-up failed: ${errorName(error)}`),
            ),
          ];

    try {
      defer(Promise.all([...recording, ...warming]));
    } catch (error) {
      console.error(`Listing record failed: ${errorName(error)}`);
    }

    const candidateRefsOf = (candidates: Candidate[], arranged: Arranged = found) =>
      candidates.map((candidate) => ({
        ...unflagged(toCandidateRef(candidate)),
        e: arranged.asGoodAsAnchor(candidate) ? (1 as const) : undefined,
      }));
    const refOf = (
      candidates: Candidate[],
      {
        t,
        second,
        arranged = found,
        f,
      }: {
        t?: SubtitleRef["t"];
        second?: Candidate[];
        arranged?: Arranged;
        f?: TimingChoice;
      } = {},
    ): SubtitleRef => ({
      v: 1,
      q,
      c: candidateRefsOf(candidates, arranged),
      x: (
        [candidates, second ?? []].map(arranged.referencesFor).find((each) => each.length > 0) ?? []
      )
        .map(toCandidateRef)
        .map(unflagged),
      a: arranged.anchors.length === 0 ? undefined : arranged.anchors.map(toCandidateRef),
      w: listed === undefined ? undefined : { h: listed.hash, z: listed.size },
      k: listed === undefined ? fileKey : undefined,
      d: hiddenKey,
      t,
      s: second === undefined ? undefined : candidateRefsOf(second),
      g:
        arranged.anchors.length > 0 || arranged.pool.length === 0
          ? undefined
          : arranged.pool.map(toCandidateRef),
      f,
    });
    const urlOf = (ref: SubtitleRef) =>
      `${baseURL(context, publicURL, trustProxy)}/${context.req.param("config")}/sub/${encodeRef(ref, refKey)}.srt`;
    const subURL = (...args: Parameters<typeof refOf>) => urlOf(refOf(...args));
    const dualEntriesOf = (lang: string, best: Candidate[]) => {
      if (dualLanguage === undefined) {
        return [];
      }

      const ranked = found.ranked(dualLanguage);
      const second = withFree(found.passing(ranked).slice(0, bestSlotSize), ranked);
      const ref = refOf(best, { second });

      return second.length === 0 ||
        ![ref.c, ref.s ?? []].every((group) => canBeTimed(group, ref, config))
        ? []
        : [
            {
              id: `${lang}+${dualLanguage}-dual`,
              lang,
              label: labelOf(best, `with ${englishNameOf(dualLanguage)}`),
              url: urlOf(ref),
            },
          ];
    };
    const choiceEntriesOf = (lang: string, best: Candidate[]) => {
      if (!offerChoices || best.length === 0) {
        return [];
      }

      const bestKey = JSON.stringify([refOf(best).c[0], anchors[0]]);
      const offered = releaseChoices.map(({ choice, label, release }) => {
        const arranged = found.arrangedFor(release);
        const [group = []] = bestGroupsOf(arranged, lang);

        const ref = refOf(group, { arranged, f: choice });

        return { choice, label, group, ref, key: JSON.stringify([ref.c[0], ref.a?.[0]]) };
      });

      return offered
        .filter(
          ({ group, key }, index) =>
            group.length > 0 &&
            key !== bestKey &&
            offered.findIndex((other) => other.key === key) === index,
        )
        .map(({ choice, label, group, ref }) => ({
          id: `${lang}-${choice}`,
          lang,
          label: labelOf(group, label),
          url: urlOf(ref),
        }));
    };
    const byPick = <T extends { id: string }>(entries: T[]) =>
      picked === undefined || picked === "best"
        ? entries
        : entries.toSorted(
            (a, b) => Number(b.id.endsWith(`-${picked}`)) - Number(a.id.endsWith(`-${picked}`)),
          );
    const entriesOf = (lang: string) => {
      const candidates = found.ranked(lang);

      if (candidates.length === 0) {
        return [];
      }

      const groups = bestGroupsOf(found, lang);
      const [best = []] = groups;

      const entries = config.bestOnly
        ? groups.map((group, index) => ({
            id: bestIdOf(lang, index),
            lang,
            label: labelOf(group),
            url: subURL(group, { f: offerChoices ? "best" : undefined }),
          }))
        : candidates.slice(0, perLanguageLimit).map((candidate, index) => ({
            id: `${lang}-${index + 1}`,
            lang,
            label: labelOf([candidate]),
            url: subURL([candidate], { f: offerChoices ? "best" : undefined }),
          }));

      const extraEntries = [
        ...(config.extras.dialogueOnly
          ? [
              {
                id: `${lang}-dialogue`,
                lang,
                label: labelOf(best, "dialogue only"),
                url: subURL(best, { t: "dialogue" }),
              },
            ]
          : []),
        ...(lang === config.languages[0] ? dualEntriesOf(lang, best) : []),
      ];

      return byPick(entries.toSpliced(1, 0, ...choiceEntriesOf(lang, best), ...extraEntries));
    };
    const foreignPartsEntriesOf = (lang: string) => {
      const flagged = config.extras.foreignParts ? found.foreignPartsOnly(lang) : [];
      const [best = []] = bySource(found.passing(flagged), flagged);

      return best.length === 0
        ? []
        : [
            {
              id: `${lang}-forced`,
              lang,
              label: labelOf(best, "foreign parts only"),
              url: subURL(best),
            },
          ];
    };
    const subtitles = config.languages.flatMap((lang) => [
      ...entriesOf(lang),
      ...foreignPartsEntriesOf(lang),
    ]);

    const named = config.extras.sourceInLanguage
      ? subtitles.map((entry) => ({
          ...entry,
          lang: `${nativeNameOf(entry.lang)} - ${entry.label}`,
        }))
      : subtitles;

    return context.json({ subtitles: named }, 200, { "cache-control": "public, max-age=3600" });
  };
