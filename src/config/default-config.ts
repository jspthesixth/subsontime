import type { Config, ConfigForm } from "./config.ts";

export const openSubtitlesAddonURL = "https://opensubtitles-v3.strem.io/manifest.json";

export const defaultForm = (languages: string[]): ConfigForm => ({
  languages,
  bestOnly: true,
  timing: "auto",
  sources: [{ kind: "stremio-addon", url: openSubtitlesAddonURL }],
  extras: { hideMismatches: true, dialogueOnly: false, foreignParts: false },
  useShared: true,
  share: true,
});

export const formOf = ({
  languages,
  bestOnly,
  timing,
  sources,
  extras,
  useShared,
  share,
}: ConfigForm): ConfigForm => ({
  languages,
  bestOnly,
  timing,
  sources,
  extras,
  useShared,
  share,
});

export function defaultConfig(languages: string[]): Config {
  return { version: 1, installId: crypto.randomUUID(), ...defaultForm(languages) };
}
