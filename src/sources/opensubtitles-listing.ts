import { createHash } from "node:crypto";
import * as v from "valibot";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";
import { rateLimit } from "../web/rate-limit.ts";
import {
  RefusedDownload,
  movieHashOf,
  restCandidate,
  restEntrySchema,
  restQueryString,
  searchRESTEntries,
  type RESTEntry,
} from "./opensubtitles.ts";
import type { Candidate, Source, VideoQuery } from "./source.ts";
import {
  addonCandidate,
  addonEntrySchema,
  fetchAddonEntries,
  stremioAddonSource,
  type AddonEntryData,
} from "./stremio-addon.ts";

export type DownloadBudget = { left(): Promise<boolean>; spend(): Promise<boolean> };

const counterSeconds = 26 * 60 * 60;
const cacheSeconds = 24 * 60 * 60;
const restTimeoutMs = 3000;
const searchesPerSecond = 5;
const cachedEntriesSchema = v.array(restEntrySchema);
const cachedAddonSchema = v.array(addonEntrySchema);

export const downloadBudget = (
  state: SharedState,
  limit: number,
  now = () => Date.now(),
): DownloadBudget => {
  const key = () => `os:downloads:${new Date(now()).toISOString().slice(0, 10)}`;

  return {
    left: () => orMiss(async () => Number((await state.get(key())) ?? 0) < limit, false),
    spend: () => orMiss(async () => (await state.increment(key(), counterSeconds)) <= limit, false),
  };
};

const cachedFile = async (
  state: SharedState,
  ref: string,
  download: () => Promise<Uint8Array>,
): Promise<Uint8Array> => {
  const key = `os:file:${ref}`;
  const stored = await orMiss(() => state.get(key), undefined);

  if (stored !== undefined) {
    return new Uint8Array(Buffer.from(stored, "base64"));
  }

  const bytes = await download();

  await orMiss(
    () => state.set(key, Buffer.from(bytes).toString("base64"), cacheSeconds),
    undefined,
  );

  return bytes;
};

export const budgetedDownloads = (
  source: Source,
  budget: DownloadBudget,
  state: SharedState,
): Source => ({
  name: source.name,
  search: async (query, signal) =>
    (await source.search(query, signal)).map((candidate) => ({ ...candidate, metered: true })),
  download: (ref, signal) =>
    cachedFile(state, ref, async () => {
      if (!(await budget.spend())) {
        throw new Error("The OpenSubtitles download budget is spent");
      }

      return source.download(ref, signal);
    }),
});

const legacyIdOf = (entry: RESTEntry) => {
  const id = entry.attributes.legacy_subtitle_id ?? undefined;

  return id === undefined ? undefined : String(id);
};

const fileIdOf = (entry: RESTEntry) => entry.attributes.files[0]?.file_id;

const firstPerFile = (entries: RESTEntry[]) =>
  entries.filter(
    (entry, index) => entries.findIndex((other) => fileIdOf(other) === fileIdOf(entry)) === index,
  );

const isMatchOrFlagged = ({ attributes }: RESTEntry) =>
  attributes.moviehash_match === true || attributes.foreign_parts_only === true;

const cacheKeyOf = (prefix: string, text: string) =>
  `${prefix}:${createHash("sha256").update(text).digest("hex")}`;

const cachedFor =
  (state: SharedState) =>
  async <T>(
    key: string,
    schema: v.GenericSchema<unknown, T>,
    fresh: () => Promise<T | undefined>,
  ): Promise<T | undefined> => {
    const stored = v.safeParse(
      v.pipe(v.string(), v.parseJson(), schema),
      (await orMiss(() => state.get(key), undefined)) ?? "",
    );

    if (stored.success) {
      return stored.output;
    }

    const value = await fresh();

    if (value !== undefined) {
      await orMiss(() => state.set(key, JSON.stringify(value), cacheSeconds), undefined);
    }

    return value;
  };

export const openSubtitlesListing = ({
  manifestURL,
  name,
  appKey,
  state,
  budget,
  rest,
  login,
}: {
  manifestURL: string;
  name: string;
  appKey: string;
  state: SharedState;
  budget: DownloadBudget;
  rest: Source;
  login?: Source;
}): Source => {
  const addon = stremioAddonSource(manifestURL, name);
  const allowSearch = rateLimit(state, (key) => key, "opensubtitles", searchesPerSecond, 1000);
  const cached = cachedFor(state);

  const searchREST = async (queryString: string | undefined, signal: AbortSignal) => {
    if (queryString === undefined) {
      return [];
    }

    return (await orMiss(() => allowSearch("search"), true))
      ? searchRESTEntries(appKey, queryString, signal, restTimeoutMs).catch(() => undefined)
      : undefined;
  };

  const restListing = (query: VideoQuery, signal: AbortSignal) => {
    const queryString = restQueryString({ ...query, videoHash: undefined }, true);

    return cached(cacheKeyOf("os:list", queryString ?? ""), cachedEntriesSchema, () =>
      searchREST(queryString, signal),
    );
  };

  const hashMatches = async (query: VideoQuery, signal: AbortSignal) => {
    const queryString = restQueryString(query);

    return (
      (await cached(cacheKeyOf("os:search", queryString ?? ""), cachedEntriesSchema, async () =>
        (await searchREST(queryString, signal))?.filter(isMatchOrFlagged),
      )) ?? []
    );
  };

  const v3Listing = async (query: VideoQuery, signal: AbortSignal) => {
    const file = { ...query, languages: [] };

    return (
      (await cached(cacheKeyOf("os:v3", JSON.stringify(file)), cachedAddonSchema, () =>
        fetchAddonEntries(manifestURL, file, signal).catch(() => undefined),
      )) ?? []
    );
  };

  const restRowsOf = async (rows: RESTEntry[], v3: AddonEntryData[]) => {
    const byLegacyId = new Map(
      v3.flatMap((entry) => (entry.id === undefined ? [] : [[String(entry.id), entry] as const])),
    );
    const meterable =
      login !== undefined ||
      (rows.some((row) => !byLegacyId.has(legacyIdOf(row) ?? "")) && (await budget.left()));

    return rows.flatMap((row): Candidate[] => {
      const listed = byLegacyId.get(legacyIdOf(row) ?? "");

      if (listed === undefined) {
        return meterable
          ? restCandidate(row).map((candidate) => ({
              ...candidate,
              sourceName: name,
              metered: true,
            }))
          : [];
      }

      const candidate = addonCandidate(name, listed);

      return [
        {
          ...candidate,
          hashMatch: candidate.hashMatch || row.attributes.moviehash_match === true,
          foreignPartsOnly: row.attributes.foreign_parts_only === true || undefined,
        },
      ];
    });
  };

  return {
    name,
    async search(query, signal) {
      const [listing, matches, v3] = await Promise.all([
        restListing(query, signal),
        movieHashOf(query) === undefined ? [] : hashMatches(query, signal),
        v3Listing(query, signal),
      ]);

      if (listing === undefined) {
        return v3.map((entry) => addonCandidate(name, entry));
      }

      const rows = firstPerFile([...matches, ...listing]);
      const joined = new Set(rows.flatMap((row) => legacyIdOf(row) ?? []));

      return [
        ...(await restRowsOf(rows, v3)),
        ...v3
          .filter((entry) => !joined.has(String(entry.id)))
          .map((entry) => addonCandidate(name, entry)),
      ];
    },
    download(ref, signal, served) {
      if (!/^\d+$/.test(ref)) {
        return addon.download(ref, signal);
      }

      return served === true && login !== undefined
        ? cachedFile(state, ref, () => login.download(ref, signal)).catch((error: unknown) => {
            if (!(error instanceof RefusedDownload)) {
              throw error;
            }

            return rest.download(ref, signal);
          })
        : rest.download(ref, signal);
    },
  };
};
