import type { Context } from "hono";
import { baseURL } from "../base-url.ts";
import type { AppEnv, RouteDeps } from "../app.ts";
import { searchAll } from "../sources/search-all.ts";
import type { SourceSet } from "../sources/from-config.ts";
import type { Candidate, VideoQuery } from "../sources/source.ts";
import { parseStremioId } from "../sources/stremio-addon.ts";
import { parseRelease, releaseSimilarity } from "../subtitles/release.ts";
import { pickReferences } from "../timing/references.ts";
import { hiddenKeyFor, videoKeyOf, viewerOf } from "./open-timings.ts";
import { fileKeyOf, recalledFileHash, recordFileHash } from "./file-hashes.ts";
import { encodeRef, type CandidateRef, type SubtitleRef } from "./refs.ts";

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

export const searchVideo = async (sources: SourceSet, query: VideoQuery) => {
  const [listed, referenceOnly] = await Promise.all([
    searchAll(sources.listed, query),
    searchAll(sources.references, query),
  ]);
  const fileRelease = parseRelease(query.filename ?? "");

  return {
    references: pickReferences([...listed, ...referenceOnly], fileRelease),
    ranked: (lang: string) =>
      listed
        .filter((candidate) => candidate.lang === lang)
        .toSorted(
          (a, b) =>
            Number(b.hashMatch) - Number(a.hashMatch) ||
            releaseSimilarity(b.release, fileRelease) - releaseSimilarity(a.release, fileRelease),
        ),
  };
};

const readExtras = (context: Context<AppEnv>) => {
  const extra = context.req.param("extra");
  const raw = new URL(context.req.url).pathname.split("/").at(-1) ?? "";
  const text = raw.includes("=") ? raw : (extra ?? "");

  return new URLSearchParams(extra === undefined ? "" : text.replace(/\.json$/, ""));
};

export const subtitlesRoute =
  ({ sourcesFor, refKey, publicURL, state, openTimings }: RouteDeps) =>
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
    const recalled =
      listed !== undefined || fileKey === undefined
        ? undefined
        : await recalledFileHash(state, fileKey);
    const query = {
      ...video,
      videoHash: extras.get("videoHash") ?? recalled?.w.h,
      videoSize: Number.isFinite(videoSize) ? videoSize : recalled?.w.z,
      filename,
      languages: config.languages,
    };
    const fingerprint = videoKeyOf(query.videoHash, query.videoSize);
    const [found, hiddenKey] = await Promise.all([
      searchVideo(sourcesFor(config, context.get("tokens")), query),
      openTimings === undefined || fingerprint === undefined || !config.useShared
        ? undefined
        : hiddenKeyFor(openTimings, state, fingerprint, viewerOf(config, openTimings.installSalt)),
    ]);
    const references = found.references.map(toCandidateRef);

    if (listed !== undefined && fileKey !== undefined) {
      await recordFileHash(state, fileKey, {
        w: { h: listed.hash, z: listed.size },
        x: references,
        m: config.languages.flatMap((lang) =>
          found
            .ranked(lang)
            .filter(({ hashMatch }) => hashMatch)
            .map(({ ref }) => ref),
        ),
      });
    }

    const subURL = (candidates: Candidate[], t?: SubtitleRef["t"]) => {
      const ref = encodeRef(
        {
          v: 1,
          q,
          c: candidates.map(toCandidateRef),
          x: references,
          w: fingerprint === undefined ? undefined : { h: fingerprint.hash, z: fingerprint.size },
          k: fingerprint === undefined ? fileKey : undefined,
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

      const best = candidates.slice(0, bestSlotSize);
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
