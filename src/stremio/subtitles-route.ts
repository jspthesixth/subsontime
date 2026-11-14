import type { Context } from "hono";
import type { AppEnv, RouteDeps } from "../app.ts";
import { searchAll } from "../sources/search-all.ts";
import type { Candidate } from "../sources/source.ts";
import { parseStremioId } from "../sources/stremio-addon.ts";
import { parseRelease, releaseSimilarity } from "../subtitles/release.ts";
import { pickReferences } from "../timing/references.ts";
import { encodeRef, type CandidateRef } from "./refs.ts";

const bestSlotSize = 4;
const perLanguageLimit = 10;

const toCandidateRef = (candidate: Candidate): CandidateRef => ({
  n: candidate.sourceName,
  r: candidate.ref,
  l: candidate.lang,
  h: candidate.hashMatch ? 1 : undefined,
  p: candidate.fps,
});

const readExtras = (context: Context<AppEnv>) => {
  const extra = context.req.param("extra");
  const raw = new URL(context.req.url).pathname.split("/").at(-1) ?? "";
  const text = raw.includes("=") ? raw : (extra ?? "");

  return new URLSearchParams(extra === undefined ? "" : text.replace(/\.json$/, ""));
};

const baseURL = (context: Context<AppEnv>, publicURL: string | undefined) => {
  const [proto] = context.req.header("x-forwarded-proto")?.split(",") ?? [];
  const [host] = context.req.header("x-forwarded-host")?.split(",") ?? [];

  if (publicURL !== undefined) {
    return publicURL.replace(/\/+$/, "");
  }

  return proto !== undefined && host !== undefined
    ? `${proto.trim()}://${host.trim()}`
    : new URL(context.req.url).origin;
};

export const subtitlesRoute =
  ({ sourcesFor, refKey, publicURL }: RouteDeps) =>
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
    const query = {
      ...video,
      videoHash: extras.get("videoHash") ?? undefined,
      videoSize: Number.isFinite(videoSize) ? videoSize : undefined,
      filename,
      languages: config.languages,
    };
    const sources = sourcesFor(config);
    const [listed, referenceOnly] = await Promise.all([
      searchAll(sources.listed, query),
      searchAll(sources.references, query),
    ]);
    const fileRelease = parseRelease(filename ?? "");
    const references = pickReferences([...listed, ...referenceOnly], fileRelease).map(
      toCandidateRef,
    );
    const subURL = (candidates: Candidate[]) => {
      const ref = encodeRef(
        {
          v: 1,
          q: { t: video.type, i: video.imdbId, s: video.season, e: video.episode },
          c: candidates.map(toCandidateRef),
          x: references,
        },
        refKey,
      );

      return `${baseURL(context, publicURL)}/${context.req.param("config")}/sub/${ref}.srt`;
    };
    const ranked = (lang: string) =>
      listed
        .filter((candidate) => candidate.lang === lang)
        .toSorted(
          (a, b) =>
            Number(b.hashMatch) - Number(a.hashMatch) ||
            releaseSimilarity(b.release, fileRelease) - releaseSimilarity(a.release, fileRelease),
        );
    const subtitles = config.languages.flatMap((lang) => {
      const candidates = ranked(lang);

      if (config.bestOnly) {
        return candidates.length === 0
          ? []
          : [{ id: `${lang}-best`, lang, url: subURL(candidates.slice(0, bestSlotSize)) }];
      }

      return candidates.slice(0, perLanguageLimit).map((candidate, index) => ({
        id: `${lang}-${index + 1}`,
        lang,
        url: subURL([candidate]),
      }));
    });

    return context.json({ subtitles }, 200, { "cache-control": "public, max-age=3600" });
  };
