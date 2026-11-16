import type { Context } from "hono";
import * as v from "valibot";
import { fetchWithTimeout } from "../http.ts";
import { maximumSearchBytes } from "../sources/source.ts";

export type LimitDeps = {
  allow: (key: string) => Promise<boolean>;
  clientKey: (context: Context) => string;
};

type CatalogType = "movie" | "series";

export const catalogTypes: CatalogType[] = ["movie", "series"];
export const unsupportedVideoMessage = "Unsupported video id";

const cinemetaURL = "https://v3-cinemeta.strem.io";
const cinemetaTimeoutMs = 4000;
const maximumTitles = 10;
const maximumQueryLength = 100;
const imdbIdPattern = /^tt\d+$/;
const unreachableCatalogMessage = "Could not reach Stremio's catalog. Try again.";
const tooManySearchesMessage = "Too many searches. Try again in a minute.";
const catalogCache = { "cache-control": "public, max-age=3600" };

const catalogSchema = v.object({
  metas: v.array(
    v.object({ id: v.string(), name: v.string(), releaseInfo: v.optional(v.string()) }),
  ),
});

const seriesSchema = v.object({
  meta: v.object({
    videos: v.optional(
      v.array(
        v.object({
          season: v.number(),
          episode: v.optional(v.number()),
          number: v.optional(v.number()),
          name: v.optional(v.string()),
          title: v.optional(v.string()),
        }),
      ),
      [],
    ),
  }),
});

export const searchCatalog = async (type: CatalogType, query: string) => {
  const response = await fetchWithTimeout(
    `${cinemetaURL}/catalog/${type}/top/search=${encodeURIComponent(query)}.json`,
    { maxBytes: maximumSearchBytes },
    cinemetaTimeoutMs,
  );

  if (!response.ok) {
    throw new Error(`Cinemeta answered ${response.status}`);
  }

  const { metas } = v.parse(catalogSchema, await response.json());

  return metas
    .filter((meta) => imdbIdPattern.test(meta.id))
    .map(({ id, name, releaseInfo }) => ({
      id,
      type,
      name,
      year: releaseInfo?.match(/^\d{4}/)?.[0],
    }));
};

const matchRank = (name: string, query: string) => {
  const folded = name.toLocaleLowerCase();

  if (folded === query) {
    return 0;
  }

  return folded.startsWith(query) ? 1 : 2;
};

const limited =
  ({ allow, clientKey }: LimitDeps, route: (context: Context) => Promise<Response>) =>
  async (context: Context) =>
    (await allow(clientKey(context)))
      ? route(context)
      : context.json({ error: tooManySearchesMessage }, 429);

const searchTitles = async (context: Context) => {
  const query = (context.req.query("q") ?? "").trim().slice(0, maximumQueryLength);
  const type = context.req.query("type");
  const types = catalogTypes.filter((each) => type === undefined || each === type);

  if (query === "") {
    return context.json([], 200, catalogCache);
  }

  const results = await Promise.allSettled(types.map((each) => searchCatalog(each, query)));
  const lists = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));

  if (lists.length === 0) {
    return context.json({ error: unreachableCatalogMessage }, 502);
  }

  const interleaved = Array.from({ length: maximumTitles }, (_, index) =>
    lists.flatMap((list) => list.slice(index, index + 1)),
  ).flat();

  const folded = query.toLocaleLowerCase();
  const ranked = interleaved.toSorted(
    (a, b) => matchRank(a.name, folded) - matchRank(b.name, folded),
  );

  return context.json(ranked.slice(0, maximumTitles), 200, catalogCache);
};

const listEpisodes = async (context: Context) => {
  const id = context.req.param("id") ?? "";

  if (!imdbIdPattern.test(id)) {
    return context.json({ error: unsupportedVideoMessage }, 400);
  }

  const meta = await fetchWithTimeout(
    `${cinemetaURL}/meta/series/${id}.json`,
    { maxBytes: maximumSearchBytes },
    cinemetaTimeoutMs,
  )
    .then(async (response) => v.parse(seriesSchema, await response.json()).meta)
    .catch(() => undefined);

  if (meta === undefined) {
    return context.json({ error: unreachableCatalogMessage }, 502);
  }

  const episodes = meta.videos
    .flatMap(({ season, episode, number, name, title }) => {
      const episodeNumber = episode ?? number;

      return episodeNumber === undefined
        ? []
        : [{ season, episode: episodeNumber, name: name ?? title ?? "" }];
    })
    .toSorted((a, b) => a.season - b.season || a.episode - b.episode);

  return context.json(episodes, 200, catalogCache);
};

export const titlesRoute = (deps: LimitDeps) => limited(deps, searchTitles);

export const episodesRoute = (deps: LimitDeps) => limited(deps, listEpisodes);
