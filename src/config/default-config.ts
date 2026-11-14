import type { Config } from "./config.ts";

export const openSubtitlesAddonURL = "https://opensubtitles-v3.strem.io/manifest.json";

export function defaultConfig(languages: string[]): Config {
  return {
    version: 1,
    installId: crypto.randomUUID(),
    languages,
    bestOnly: true,
    timing: "auto",
    sources: [{ kind: "stremio-addon", url: openSubtitlesAddonURL }],
    extras: { hideMismatches: true },
  };
}
