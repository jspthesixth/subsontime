import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context } from "hono";
import { appDepsOf, createApp, detached } from "./app.ts";
import { addressKey } from "./client-key.ts";
import { readEnvironment } from "./config/env.ts";

const environment = readEnvironment(process.env);

const proxiedClient = (context: Context) =>
  environment.server.trustProxy
    ? context.req.header("x-forwarded-for")?.split(",").at(-1)?.trim()
    : undefined;

const app = createApp({
  ...appDepsOf(environment),
  staticFiles: serveStatic({ root: "./public" }),
  defer: detached,
  clientKey: (context) =>
    addressKey(proxiedClient(context) || getConnInfo(context).remote.address || "unknown"),
});

serve({ fetch: app.fetch, port: environment.server.port });
