import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context } from "hono";
import { createApp } from "./app.ts";
import { addressKey } from "./client-key.ts";
import { readSecret } from "./config/secret.ts";
import { memoryTokenCache } from "./sources/token-cache.ts";

const port = Number(process.env["PORT"] ?? 7000);
const trustProxy = process.env["TRUST_PROXY"] === "1";

const proxiedClient = (context: Context) =>
  trustProxy ? context.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() : undefined;

const app = createApp({
  secret: readSecret(process.env),
  tokens: memoryTokenCache(),
  openSubtitlesAppKey: process.env["OPENSUBTITLES_APP_KEY"] || undefined,
  publicURL: process.env["PUBLIC_URL"] || undefined,
  staticFiles: serveStatic({ root: "./public" }),
  clientKey: (context) =>
    addressKey(proxiedClient(context) || getConnInfo(context).remote.address || "unknown"),
});

serve({ fetch: app.fetch, port });
