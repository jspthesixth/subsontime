import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import * as v from "valibot";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";
import { parseJSON } from "../json.ts";
import { rateLimit } from "../web/rate-limit.ts";
import {
  movieHashOf,
  restCandidate,
  restEntrySchema,
  restQueryString,
  searchRESTEntries,
  type RESTEntry,
} from "./opensubtitles.ts";
import type { Candidate, Source, VideoQuery } from "./source.ts";
import { addonEntries, stremioAddonSource, type AddonEntry } from "./stremio-addon.ts";

export type DownloadBudget = { left(): Promise<boolean>; spend(): Promise<boolean> };

const counterSeconds = 26 * 60 * 60;
const cacheSeconds = 24 * 60 * 60;
const restTimeoutMs = 3000;
const searchesPerSecond = 5;
const cachedEntriesSchema = v.array(restEntrySchema);

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

export const budgetedDownloads = (
  source: Source,
  budget: DownloadBudget,
  state: SharedState,
): Source => ({
  name: source.name,
  search: async (query, signal) =>
    (await source.search(query, signal)).map((candidate) => ({ ...candidate, metered: true })),
  async download(ref, signal) {
    const key = `os:file:${ref}`;
    const cached = await orMiss(() => state.get(key), undefined);

    if (cached !== undefined) {
      return new Uint8Array(Buffer.from(cached, "base64"));
    }

    if (!(await budget.spend())) {
      throw new Error("The OpenSubtitles download budget is spent");
    }

    const bytes = await source.download(ref, signal);

    await orMiss(
      () => state.set(key, Buffer.from(bytes).toString("base64"), cacheSeconds),
      undefined,
    );

    return bytes;
  },
});

const firstPerLanguage = (candidates: Candidate[]) =>
  candidates.filter(
    (candidate, index) => candidates.findIndex(({ lang }) => lang === candidate.lang) === index,
  );

const isTrustedMatch = ({ hashMatch, foreignPartsOnly }: Candidate) =>
  hashMatch && foreignPartsOnly !== true;

const legacyIdOf = (entry: RESTEntry) => {
  const id = entry.attributes.legacy_subtitle_id ?? undefined;

  return id === undefined ? undefined : String(id);
};

const addonIds = (entries: AddonEntry[]) =>
  new Set(entries.flatMap(({ id }) => (id === undefined ? [] : [String(id)])));

export type Listing = (query: VideoQuery, signal: AbortSignal) => Promise<AddonEntry[]>;

export const sharedListing = (manifestURL: string, name: string): Listing => {
  const listings = new Map<string, Promise<AddonEntry[]>>();

  return (query, signal) => {
    const key = JSON.stringify(query);
    const listing = listings.get(key) ?? addonEntries(manifestURL, name, query, signal);

    listings.set(key, listing);

    return listing;
  };
};

export const withoutListed = (login: Source, appKey: string, listing: Listing): Source => ({
  ...login,
  async search(query, signal) {
    const [entries, listed] = await Promise.all([
      searchRESTEntries(appKey, query, signal),
      listing(query, signal).catch((): AddonEntry[] => []),
    ]);

    const ids = addonIds(listed);

    return (entries ?? [])
      .filter((entry) => !ids.has(legacyIdOf(entry) ?? ""))
      .flatMap(restCandidate);
  },
});

export const openSubtitlesHashSource = ({
  manifestURL,
  name,
  appKey,
  state,
  budget,
  rest,
  listing,
}: {
  manifestURL: string;
  name: string;
  appKey: string;
  state: SharedState;
  budget: DownloadBudget;
  rest: Source;
  listing: Listing;
}): Source => {
  const addon = stremioAddonSource(manifestURL, name);
  const allowSearch = rateLimit(state, (key) => key, "opensubtitles", searchesPerSecond, 1000);

  const searchMatches = async (query: VideoQuery, signal: AbortSignal) => {
    const key = `os:search:${createHash("sha256")
      .update(restQueryString(query) ?? "")
      .digest("hex")}`;
    const cached = v.safeParse(
      cachedEntriesSchema,
      parseJSON((await orMiss(() => state.get(key), undefined)) ?? ""),
    );

    if (cached.success) {
      return cached.output;
    }

    if (!(await orMiss(() => allowSearch("search"), true))) {
      return [];
    }

    const entries = await searchRESTEntries(appKey, query, signal, restTimeoutMs);

    if (entries === undefined) {
      return [];
    }

    const matches = entries.filter(
      ({ attributes }) =>
        attributes.moviehash_match === true || attributes.foreign_parts_only === true,
    );

    await orMiss(() => state.set(key, JSON.stringify(matches), cacheSeconds), undefined);

    return matches;
  };

  const hashMatches = (query: VideoQuery, signal: AbortSignal) =>
    Promise.race([
      searchMatches(query, signal).catch((): RESTEntry[] => []),
      setTimeout(restTimeoutMs, [], { ref: false }),
    ]);

  return {
    name,
    async search(query, signal) {
      if (movieHashOf(query) === undefined) {
        return (await listing(query, signal)).map(({ candidate }) => candidate);
      }

      const [entries, matches] = await Promise.all([
        listing(query, signal),
        hashMatches(query, signal),
      ]);

      const listedIds = addonIds(entries);
      const idsWhere = (flag: "moviehash_match" | "foreign_parts_only") =>
        new Set(
          matches.flatMap((entry) =>
            entry.attributes[flag] === true ? (legacyIdOf(entry) ?? []) : [],
          ),
        );
      const matchedIds = idsWhere("moviehash_match");
      const flaggedIds = idsWhere("foreign_parts_only");
      const listed = entries.map(({ id, candidate }) => ({
        ...candidate,
        hashMatch: candidate.hashMatch || (id !== undefined && matchedIds.has(String(id))),
        foreignPartsOnly: (id !== undefined && flaggedIds.has(String(id))) || undefined,
      }));
      const covered = new Set(listed.filter(isTrustedMatch).map(({ lang }) => lang));
      const missing = firstPerLanguage(
        matches
          .filter((entry) => !listedIds.has(legacyIdOf(entry) ?? ""))
          .flatMap(restCandidate)
          .filter(
            (candidate) =>
              isTrustedMatch(candidate) &&
              query.languages.includes(candidate.lang) &&
              !covered.has(candidate.lang),
          )
          .map((candidate) => ({ ...candidate, sourceName: name, metered: true })),
      );

      if (missing.length === 0 || !(await budget.left())) {
        return listed;
      }

      return [...listed, ...missing];
    },
    download: (ref, signal) =>
      /^\d+$/.test(ref) ? rest.download(ref, signal) : addon.download(ref, signal),
  };
};
