import { basename } from "node:path";
import { setTimeout } from "node:timers/promises";
import * as v from "valibot";
import { parseStremioId } from "../../src/sources/stremio-addon.ts";
import { hashFile } from "./opensubtitles-v3-hash.ts";

const usage =
  "usage: node --env-file=.env.local --experimental-strip-types scripts/probes/opensubtitles-hash-search.ts <tt id or tt:season:episode> [video file]";
const restURL = "https://api.opensubtitles.com/api/v1/subtitles";
const v3URL = "https://opensubtitles-v3.strem.io/subtitles";
const pagePauseMs = 250;

const RestPage = v.object({
  total_pages: v.number(),
  data: v.array(
    v.object({
      attributes: v.object({
        language: v.nullable(v.string()),
        legacy_subtitle_id: v.nullable(v.number()),
        moviehash_match: v.optional(v.boolean()),
        feature_details: v.object({ title: v.nullable(v.string()) }),
      }),
    }),
  ),
});

type RestEntry = v.InferOutput<typeof RestPage>["data"][number];

const V3Response = v.object({
  subtitles: v.array(v.object({ id: v.string(), m: v.optional(v.string()) })),
});

const appKey = process.env["OPENSUBTITLES_APP_KEY"];

if (appKey === undefined || appKey === "") {
  throw new Error("Set OPENSUBTITLES_APP_KEY");
}

const restSearch = async (params: Record<string, string>, page = 1): Promise<RestEntry[]> => {
  const query = Object.entries({ ...params, ...(page > 1 ? { page: String(page) } : {}) })
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const response = await fetch(`${restURL}?${query}`, {
    headers: { "Api-Key": appKey, "User-Agent": "SubsOnTime probe", Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from the REST search`);
  }

  const { total_pages, data } = v.parse(RestPage, await response.json());

  if (page >= total_pages) {
    return data;
  }

  await setTimeout(pagePauseMs);

  return [...data, ...(await restSearch(params, page + 1))];
};

const v3Search = async (path: string) => {
  const response = await fetch(`${v3URL}/${path}.json`);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from the v3 addon`);
  }

  return v.parse(V3Response, await response.json()).subtitles;
};

const report = (label: string, entries: RestEntry[], v3Ids: Set<string>) => {
  const matched = entries.filter((entry) => entry.attributes.moviehash_match === true);
  const inV3 = (list: RestEntry[]) =>
    list.filter((entry) => v3Ids.has(String(entry.attributes.legacy_subtitle_id))).length;

  console.log(
    label,
    JSON.stringify({
      title: entries[0]?.attributes.feature_details.title,
      results: entries.length,
      inV3: inV3(entries),
      hashMatches: matched.length,
      hashMatchesInV3: inV3(matched),
      hashMatchLanguages: matched.map((entry) => entry.attributes.language),
    }),
  );
};

const main = async () => {
  const [id, file] = process.argv.slice(2);

  if (id === undefined) {
    throw new Error(usage);
  }

  const type = id.includes(":") ? "series" : "movie";
  const { imdbId, season, episode } = parseStremioId(type, id);

  const digits = imdbId.replace(/^tt0*/, "");
  const titleParams: Record<string, string> =
    type === "series"
      ? {
          parent_imdb_id: digits,
          season_number: String(season),
          episode_number: String(episode),
        }
      : { imdb_id: digits };
  const video = file === undefined ? undefined : await hashFile(file);
  const extras =
    video === undefined || file === undefined
      ? ""
      : `/videoHash=${video.hash}&videoSize=${video.size}&filename=${encodeURIComponent(basename(file))}`;
  const v3 = await v3Search(`${type}/${id}${extras}`);
  const v3Ids = new Set(v3.map((entry) => entry.id));

  console.log(
    "v3",
    JSON.stringify({
      entries: v3.length,
      hashMatches: v3.filter((entry) => entry.m === "h").length,
      hash: video?.hash,
    }),
  );
  report("rest by id", await restSearch(titleParams), v3Ids);

  if (video !== undefined) {
    report("rest by id+hash", await restSearch({ ...titleParams, moviehash: video.hash }), v3Ids);
    report("rest by hash only", await restSearch({ moviehash: video.hash }), v3Ids);
  }
};

if (import.meta.main) {
  await main();
}
