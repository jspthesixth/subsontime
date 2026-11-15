import type { Config, SourceSettings } from "../config/config.ts";
import { defaultDailyDownloads } from "../config/env.ts";
import type { SharedState } from "../jobs/shared-state.ts";
import { openSubtitlesSource } from "./opensubtitles.ts";
import {
  budgetedDownloads,
  downloadBudget,
  openSubtitlesHashSource,
} from "./opensubtitles-hash.ts";
import type { Source } from "./source.ts";
import { stremioAddonSource } from "./stremio-addon.ts";
import { subdlSource } from "./subdl.ts";
import { subSourceSource } from "./subsource.ts";
import { titloviSource } from "./titlovi.ts";
import type { TokenCache } from "./token-cache.ts";

export type SourceSet = { listed: Source[]; references: Source[] };

type SourceDeps = {
  tokens: TokenCache;
  state: SharedState;
  openSubtitlesAppKey?: string;
  openSubtitlesDailyDownloads?: number;
};

const openSubtitlesV3URL = "https://opensubtitles-v3.strem.io/manifest.json";
const openSubtitlesAPIName = "OpenSubtitles API";

const renamed = (source: Source, name: string): Source => ({
  name,
  search: async (query, signal) =>
    (await source.search(query, signal)).map((candidate) => ({ ...candidate, sourceName: name })),
  download: (ref, signal) => source.download(ref, signal),
});

const budgetOf = (deps: SourceDeps) =>
  downloadBudget(deps.state, deps.openSubtitlesDailyDownloads ?? defaultDailyDownloads);

const anonymousREST = (appKey: string, deps: SourceDeps, budget = budgetOf(deps)) =>
  budgetedDownloads(openSubtitlesSource(undefined, appKey, deps.tokens), budget, deps.state);

const openSubtitlesAPI = (
  credentials: { username: string; password: string } | undefined,
  deps: SourceDeps,
) => {
  const appKey = deps.openSubtitlesAppKey;

  if (appKey === undefined) {
    return [];
  }

  return [
    renamed(
      credentials === undefined
        ? anonymousREST(appKey, deps)
        : openSubtitlesSource(credentials, appKey, deps.tokens),
      openSubtitlesAPIName,
    ),
  ];
};

const openSubtitlesV3 = (deps: SourceDeps) => {
  const appKey = deps.openSubtitlesAppKey;

  if (appKey === undefined) {
    return stremioAddonSource(openSubtitlesV3URL, "OpenSubtitles");
  }

  const budget = budgetOf(deps);
  const rest = anonymousREST(appKey, deps, budget);

  return openSubtitlesHashSource({
    manifestURL: openSubtitlesV3URL,
    name: "OpenSubtitles",
    appKey,
    state: deps.state,
    budget,
    restDownload: (ref, signal) => rest.download(ref, signal),
  });
};

const coversOpenSubtitles = (settings: SourceSettings) =>
  settings.kind === "opensubtitles" ||
  (settings.kind === "stremio-addon" && settings.url === openSubtitlesV3URL);

const toSources = (settings: SourceSettings, deps: SourceDeps): Source[] => {
  switch (settings.kind) {
    case "stremio-addon":
      return [
        settings.url === openSubtitlesV3URL
          ? openSubtitlesV3(deps)
          : stremioAddonSource(settings.url, new URL(settings.url).host),
      ];
    case "opensubtitles":
      return openSubtitlesAPI(settings, deps);
    case "titlovi":
      return [titloviSource(settings, deps.tokens)];
    case "subdl":
      return [subdlSource(settings.apiKey)];
    case "subsource":
      return [subSourceSource(settings.apiKey)];
  }
};

export const sourcesFromConfig = (config: Config, deps: SourceDeps): SourceSet => {
  const withLogin = config.sources.some(({ kind }) => kind === "opensubtitles");
  const sourceDeps = withLogin ? { ...deps, openSubtitlesDailyDownloads: 0 } : deps;

  return {
    listed: config.sources.flatMap((settings) => toSources(settings, sourceDeps)),
    references: config.sources.some(coversOpenSubtitles)
      ? []
      : openSubtitlesAPI(undefined, sourceDeps),
  };
};
