import { handle } from "hono/vercel";
import { createApp } from "../src/app.ts";
import { readSecret } from "../src/config/secret.ts";
import { memoryTokenCache } from "../src/sources/token-cache.ts";

export default handle(
  createApp({
    secret: readSecret(process.env),
    tokens: memoryTokenCache(),
    openSubtitlesAppKey: process.env["OPENSUBTITLES_APP_KEY"] || undefined,
  }),
);
