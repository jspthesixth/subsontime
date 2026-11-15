import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context } from "hono";
import { createApp, detached } from "./app.ts";
import { addressKey } from "./client-key.ts";
import { readEnvironment } from "./config/env.ts";
import { sharedStateFrom } from "./jobs/shared-state.ts";
import { memoryStore, postgresStore } from "./timings/db.ts";

const { server, secrets, sources, database, sharedState } = readEnvironment(process.env);

const proxiedClient = (context: Context) =>
  server.trustProxy ? context.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() : undefined;

const app = createApp({
  secret: secrets.secret,
  state: sharedStateFrom(sharedState),
  openSubtitlesAppKey: sources.openSubtitlesAppKey,
  openSubtitlesDailyDownloads: sources.openSubtitlesDailyDownloads,
  publicURL: server.publicURL,
  staticFiles: serveStatic({ root: "./public" }),
  installSalt: secrets.installSalt,
  timings: database.url ? postgresStore(database.url) : memoryStore(),
  defer: detached,
  clientKey: (context) =>
    addressKey(proxiedClient(context) || getConnInfo(context).remote.address || "unknown"),
});

serve({ fetch: app.fetch, port: server.port });
