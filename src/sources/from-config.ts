import type { Config, SourceSettings } from "../config/config.ts";
import { defaultDailyDownloads } from "../config/env.ts";
import type { SharedState } from "../jobs/shared-state.ts";
import { openSubtitlesSource } from "./opensubtitles.ts";
import {
  budgetedDownloads,
  downloadBudget,
  openSubtitlesHashSource,
  sharedListing,
  withoutListed,
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

export const openSubtitlesV3Name = "OpenSubtitles";
export const openSubtitlesAPIName = "OpenSubtitles API";

const renamed = (source: Source, name: string): Source => ({
  name,
  search: async (query, signal) =>
    (await source.search(query, signal)).map((candidate) => ({ ...candidate, sourceName: name })),
  download: (ref, signal) => source.download(ref, signal),
});

type OpenSubtitles = {
  v3: Source;
  login: (credentials: { username: string; password: string }) => Source;
  reference: Source;
};

const isV3 = (settings: SourceSettings) =>
  settings.kind === "stremio-addon" && settings.url === openSubtitlesV3URL;

const isLogin = (settings: SourceSettings) => settings.kind === "opensubtitles";

const openSubtitlesFor = (appKey: string, config: Config, deps: SourceDeps): OpenSubtitles => {
  const withLogin = config.sources.some(isLogin);
  const withV3 = config.sources.some(isV3);
  const budget = downloadBudget(
    deps.state,
    withLogin ? 0 : (deps.openSubtitlesDailyDownloads ?? defaultDailyDownloads),
  );
  const rest = budgetedDownloads(
    openSubtitlesSource(undefined, appKey, deps.tokens),
    budget,
    deps.state,
  );
  const listing = sharedListing(openSubtitlesV3URL, openSubtitlesV3Name);

  return {
    v3: openSubtitlesHashSource({
      manifestURL: openSubtitlesV3URL,
      name: openSubtitlesV3Name,
      appKey,
      state: deps.state,
      budget,
      rest,
      listing,
    }),
    login: (credentials) => {
      const login = openSubtitlesSource(credentials, appKey, deps.tokens);

      return renamed(withV3 ? withoutListed(login, appKey, listing) : login, openSubtitlesAPIName);
    },
    reference: renamed(rest, openSubtitlesAPIName),
  };
};

const toSources = (
  settings: SourceSettings,
  tokens: TokenCache,
  openSubtitles?: OpenSubtitles,
): Source[] => {
  switch (settings.kind) {
    case "stremio-addon":
      return [
        settings.url === openSubtitlesV3URL
          ? (openSubtitles?.v3 ?? stremioAddonSource(openSubtitlesV3URL, openSubtitlesV3Name))
          : stremioAddonSource(settings.url, new URL(settings.url).host),
      ];
    case "opensubtitles":
      return openSubtitles === undefined ? [] : [openSubtitles.login(settings)];
    case "titlovi":
      return [titloviSource(settings, tokens)];
    case "subdl":
      return [subdlSource(settings.apiKey)];
    case "subsource":
      return [subSourceSource(settings.apiKey)];
  }
};

export const sourcesFromConfig = (config: Config, deps: SourceDeps): SourceSet => {
  const appKey = deps.openSubtitlesAppKey;
  const openSubtitles = appKey === undefined ? undefined : openSubtitlesFor(appKey, config, deps);
  const covered = config.sources.some((settings) => isV3(settings) || isLogin(settings));

  return {
    listed: config.sources.flatMap((settings) => toSources(settings, deps.tokens, openSubtitles)),
    references: covered || openSubtitles === undefined ? [] : [openSubtitles.reference],
  };
};
