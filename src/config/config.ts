import * as v from "valibot";
import { isPublicURL } from "../http.ts";

export class ConfigError extends Error {}

const manifestURL = v.pipe(
  v.string(),
  v.check(
    (url) =>
      !/[?#]/.test(url) &&
      isPublicURL(url, process.env["ALLOW_LOCAL_ADDONS"] === "1") &&
      new URL(url).pathname.endsWith("/manifest.json"),
    "Must be an https manifest.json URL",
  ),
);

const credential = v.pipe(
  v.string(),
  v.minLength(1, "Fill in every username, password and API key"),
);

export const sourceSchema = v.variant("kind", [
  v.object({ kind: v.literal("stremio-addon"), url: manifestURL }),
  v.object({ kind: v.literal("opensubtitles"), username: credential, password: credential }),
  v.object({ kind: v.literal("titlovi"), username: credential, password: credential }),
  v.object({ kind: v.literal("subdl"), apiKey: credential }),
  v.object({ kind: v.literal("subsource"), apiKey: credential }),
]);

const languageCode = v.pipe(v.string(), v.regex(/^[a-z]{3}$/));

export const languagesSchema = v.pipe(
  v.array(languageCode),
  v.minLength(1, "Choose at least one language"),
  v.maxLength(10, "Choose at most 10 languages"),
  v.check((languages) => new Set(languages).size === languages.length, "Choose each language once"),
);

const configObject = v.object({
  version: v.literal(1),
  installId: v.pipe(v.string(), v.minLength(1)),
  languages: languagesSchema,
  bestOnly: v.boolean(),
  timing: v.picklist(["auto", "off"]),
  sources: v.pipe(v.array(sourceSchema), v.maxLength(20, "Add at most 20 sources")),
  extras: v.object({
    hideMismatches: v.boolean(),
    dialogueOnly: v.optional(v.boolean(), false),
    foreignParts: v.optional(v.boolean(), false),
    dualLanguage: v.optional(languageCode),
  }),
  useShared: v.optional(v.boolean(), true),
  share: v.optional(v.boolean(), true),
});

type LanguageChoice = Pick<v.InferOutput<typeof configObject>, "languages" | "extras">;

const withDualLanguageCheck = <TSchema extends v.GenericSchema<unknown, LanguageChoice>>(
  schema: TSchema,
) =>
  v.pipe(
    schema,
    v.check(
      ({ languages, extras }) => extras.dualLanguage !== languages[0],
      "Choose a second language other than the first",
    ),
  );

export const configSchema = withDualLanguageCheck(configObject);
export const formSchema = withDualLanguageCheck(v.omit(configObject, ["version", "installId"]));

export type Config = v.InferOutput<typeof configSchema>;
export type SourceSettings = v.InferOutput<typeof sourceSchema>;
export type ConfigForm = Omit<Config, "version" | "installId">;
