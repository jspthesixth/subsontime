import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { readSecret } from "./config/secret.ts";
import { memoryTokenCache } from "./sources/token-cache.ts";

const port = Number(process.env["PORT"] ?? 7000);
const app = createApp({
  secret: readSecret(process.env),
  tokens: memoryTokenCache(),
  openSubtitlesAppKey: process.env["OPENSUBTITLES_APP_KEY"] || undefined,
});

serve({ fetch: app.fetch, port });
