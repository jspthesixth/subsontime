import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.ts";
import { readSecret } from "./config/secret.ts";
import { memoryTokenCache } from "./sources/token-cache.ts";

const port = Number(process.env["PORT"] ?? 7000);
const app = createApp({
  secret: readSecret(process.env),
  tokens: memoryTokenCache(),
  openSubtitlesAppKey: process.env["OPENSUBTITLES_APP_KEY"] || undefined,
  publicURL: process.env["PUBLIC_URL"] || undefined,
  staticFiles: serveStatic({ root: "./public" }),
});

serve({ fetch: app.fetch, port });
