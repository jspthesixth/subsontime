import type { Config, SourceSettings } from "../config/config.ts";
import { openSubtitlesSource } from "./opensubtitles.ts";
import type { Source } from "./source.ts";
import { stremioAddonSource } from "./stremio-addon.ts";
import { subdlSource } from "./subdl.ts";
import { subSourceSource } from "./subsource.ts";
import { titloviSource } from "./titlovi.ts";
import type { TokenCache } from "./token-cache.ts";

export type SourceSet = { listed: Source[]; references: Source[] };

type SourceDeps = { tokens: TokenCache; openSubtitlesAppKey?: string };

const openSubtitlesV3URL = "https://opensubtitles-v3.strem.io/manifest.json";
const openSubtitlesAPIName = "OpenSubtitles API";

const renamed = (source: Source, name: string): Source => ({
  name,
  search: async (query, signal) =>
    (await source.search(query, signal)).map((candidate) => ({ ...candidate, sourceName: name })),
  download: (ref, signal) => source.download(ref, signal),
});

const openSubtitlesAPI = (
  credentials: { username: string; password: string } | undefined,
  deps: SourceDeps,
) =>
  deps.openSubtitlesAppKey === undefined
    ? []
    : [
        renamed(
          openSubtitlesSource(credentials, deps.openSubtitlesAppKey, deps.tokens),
          openSubtitlesAPIName,
        ),
      ];

const toSources = (settings: SourceSettings, deps: SourceDeps): Source[] => {
  switch (settings.kind) {
    case "stremio-addon":
      return [
        stremioAddonSource(
          settings.url,
          settings.url === openSubtitlesV3URL ? "OpenSubtitles" : new URL(settings.url).host,
        ),
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

export const sourcesFromConfig = (config: Config, deps: SourceDeps): SourceSet => ({
  listed: config.sources.flatMap((settings) => toSources(settings, deps)),
  references: config.sources.some((settings) => settings.kind === "opensubtitles")
    ? []
    : openSubtitlesAPI(undefined, deps),
});
