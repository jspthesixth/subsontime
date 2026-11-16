import type { Config, SourceSettings } from "../config/config.ts";
import { openSubtitlesAddonURL } from "../config/default-config.ts";
import { defaultDailyDownloads } from "../config/env.ts";
import type { SharedState } from "../jobs/shared-state.ts";
import { openSubtitlesSource } from "./opensubtitles.ts";
import { budgetedDownloads, downloadBudget, openSubtitlesListing } from "./opensubtitles-hash.ts";
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

export const openSubtitlesV3Name = "OpenSubtitles";
export const openSubtitlesAPIName = "OpenSubtitles API";

const renamed = (source: Source, name: string): Source => ({
  name,
  search: async (query, signal) =>
    (await source.search(query, signal)).map((candidate) => ({ ...candidate, sourceName: name })),
  download: (ref, signal) => source.download(ref, signal),
});

type OpenSubtitles = { listed: Source; reference: Source };

const isV3 = (settings: SourceSettings) =>
  settings.kind === "stremio-addon" && settings.url === openSubtitlesAddonURL;

const isLogin = (settings: SourceSettings) => settings.kind === "opensubtitles";

const openSubtitlesFor = (appKey: string, config: Config, deps: SourceDeps): OpenSubtitles => {
  const credentials = config.sources.find((settings) => settings.kind === "opensubtitles");
  const budget = downloadBudget(
    deps.state,
    deps.openSubtitlesDailyDownloads ?? defaultDailyDownloads,
  );
  const rest = budgetedDownloads(
    openSubtitlesSource(undefined, appKey, deps.tokens),
    budget,
    deps.state,
  );

  const listed = openSubtitlesListing({
    manifestURL: openSubtitlesAddonURL,
    name: openSubtitlesV3Name,
    appKey,
    state: deps.state,
    budget,
    rest,
    login:
      credentials === undefined ? undefined : openSubtitlesSource(credentials, appKey, deps.tokens),
  });

  return { listed, reference: renamed(listed, openSubtitlesAPIName) };
};

const toSources = (
  settings: SourceSettings,
  tokens: TokenCache,
  openSubtitles?: Source,
): Source[] => {
  switch (settings.kind) {
    case "stremio-addon":
      return [
        settings.url === openSubtitlesAddonURL
          ? (openSubtitles ?? stremioAddonSource(openSubtitlesAddonURL, openSubtitlesV3Name))
          : stremioAddonSource(settings.url, new URL(settings.url).host),
      ];
    case "opensubtitles":
      return openSubtitles === undefined ? [] : [openSubtitles];
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
    listed: [
      ...new Set(
        config.sources.flatMap((settings) =>
          toSources(settings, deps.tokens, openSubtitles?.listed),
        ),
      ),
    ],
    references: covered || openSubtitles === undefined ? [] : [openSubtitles.reference],
  };
};
