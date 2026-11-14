import * as v from "valibot";

const openSubtitlesAddonURL = "https://opensubtitles-v3.strem.io/manifest.json";
const localManifestPattern = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/.*manifest\.json$/;

export class ConfigError extends Error {}

const manifestURL = v.pipe(
  v.string(),
  v.check(
    (url) =>
      localManifestPattern.test(url) ||
      (URL.canParse(url) &&
        new URL(url).protocol === "https:" &&
        new URL(url).pathname.endsWith("/manifest.json")),
    "Must be an https manifest.json URL",
  ),
);

const credential = v.pipe(v.string(), v.minLength(1));

const sourceSchema = v.variant("kind", [
  v.object({ kind: v.literal("stremio-addon"), url: manifestURL }),
  v.object({ kind: v.literal("opensubtitles"), username: credential, password: credential }),
  v.object({ kind: v.literal("titlovi"), username: credential, password: credential }),
  v.object({ kind: v.literal("subdl"), apiKey: credential }),
  v.object({ kind: v.literal("subsource"), apiKey: credential }),
]);

export const configSchema = v.object({
  version: v.literal(1),
  installId: v.pipe(v.string(), v.minLength(1)),
  languages: v.pipe(v.array(v.pipe(v.string(), v.regex(/^[a-z]{3}$/))), v.minLength(1)),
  bestOnly: v.boolean(),
  timing: v.picklist(["auto", "off"]),
  sources: v.array(sourceSchema),
  extras: v.object({ hideMismatches: v.boolean() }),
});

export type Config = v.InferOutput<typeof configSchema>;
export type SourceSettings = v.InferOutput<typeof sourceSchema>;

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
