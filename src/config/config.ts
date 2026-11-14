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

export const configSchema = v.object({
  version: v.literal(1),
  installId: v.pipe(v.string(), v.minLength(1)),
  languages: v.pipe(
    v.array(v.pipe(v.string(), v.regex(/^[a-z]{3}$/))),
    v.minLength(1, "Choose at least one language"),
  ),
  bestOnly: v.boolean(),
  timing: v.picklist(["auto", "off"]),
  sources: v.array(sourceSchema),
  extras: v.object({ hideMismatches: v.boolean() }),
});

export type Config = v.InferOutput<typeof configSchema>;
export type SourceSettings = v.InferOutput<typeof sourceSchema>;
