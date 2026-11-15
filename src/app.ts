import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { baseURL } from "./base-url.ts";
import { ConfigError, type Config } from "./config/config.ts";
import { invalidLinkMessage, unseal } from "./config/seal.ts";
import { sealedConfigPattern } from "./config/sealed-config.ts";
import { memorySingleFlight, sharedSingleFlight, type SingleFlight } from "./jobs/single-flight.ts";
import { memorySharedState, orMiss, type SharedState } from "./jobs/shared-state.ts";
import { sourcesFromConfig, type SourceSet } from "./sources/from-config.ts";
import { installKeyOf, tokenCacheFor, type TokenCache } from "./sources/token-cache.ts";
import { fileRoute, subtitleCache, type SubtitleCache } from "./stremio/file-route.ts";
import { manifest } from "./stremio/manifest.ts";
import type { OpenTimings } from "./stremio/open-timings.ts";
import { refKey } from "./stremio/refs.ts";
import { subtitlesRoute } from "./stremio/subtitles-route.ts";
import {
  cachedStats,
  sharedSummaries,
  submitFix,
  submitMismatch,
  submitReport,
} from "./timings/api.ts";
import { cuesRoute, lookUpRoute, statsRoute, writeRoute } from "./timings/api-route.ts";
import { memoryStore, type TimingsStore } from "./timings/db.ts";
import { dailyOrigins } from "./timings/origin.ts";
import { groupingKeyOf } from "./timings/submitter.ts";
import { checkPage } from "./web/check-page.ts";
import { checkRoute, episodesRoute, titlesRoute } from "./web/check-route.ts";
import { createConfigRoute, openConfigRoute } from "./web/config-route.ts";
import { homePage } from "./web/home-page.ts";
import { setupPage } from "./web/setup-page.ts";
import { timingsPage } from "./web/timings-page.ts";
import { limitKeyOf, rateLimit } from "./web/rate-limit.ts";
import { sourceCheckRoute } from "./web/source-check-route.ts";

export type AppDeps = {
  secret: string;
  state?: SharedState;
  openSubtitlesAppKey?: string;
  openSubtitlesDailyDownloads?: number;
  publicURL?: string;
  sourcesFor?: (config: Config, tokens: TokenCache) => SourceSet;
  staticFiles?: MiddlewareHandler;
  clientKey?: (context: Context) => string;
  installSalt?: string;
  timings?: TimingsStore;
  defer?: (work: Promise<unknown>) => void;
  analytics?: boolean;
};

export type AppEnv = { Variables: { config: Config; tokens: TokenCache } };

export type RouteDeps = {
  sourcesFor: (config: Config, tokens: TokenCache) => SourceSet;
  refKey: Buffer;
  publicURL?: string;
  state: SharedState;
  singleFlight: SingleFlight;
  subtitles?: SubtitleCache;
  clientKey: (context: Context) => string;
  openTimings?: OpenTimings;
  defer: (work: Promise<unknown>) => void;
};

const newerLinkMessage = "This install link is from a newer version";
const notJSONMessage = "Send the request as JSON";
const tooLargeMessage = "This request is too large";
const failedMessage = "Something went wrong";
const apiBodyLimit = 16 * 1024;
const timingsBodyLimit = 512 * 1024;
const writesPerHour = 60;
const hourMs = 3_600_000;

export const detached = (work: Promise<unknown>) => {
  work.catch((error: unknown) =>
    console.error(`Background work failed: ${error instanceof Error ? error.name : "unknown"}`),
  );
};

const tooLarge = (context: Context) => context.json({ error: tooLargeMessage }, 413);

const failOpen =
  (allow: (key: string) => Promise<boolean>) =>
  (key: string): Promise<boolean> =>
    orMiss(() => allow(key), true);

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const clientKey = deps.clientKey ?? (() => "anonymous");
  const shared = deps.state;
  const state = shared ?? memorySharedState();
  const limitKey = limitKeyOf(deps.secret);
  const titleLimit = {
    allow: failOpen(rateLimit(state, limitKey, "titles", 60, 60_000)),
    clientKey,
  };
  const apiBody = bodyLimit({ maxSize: apiBodyLimit, onError: tooLarge });
  const timingsBody = bodyLimit({ maxSize: timingsBodyLimit, onError: tooLarge });
  const openTimings =
    deps.installSalt === undefined
      ? undefined
      : {
          store: deps.timings ?? memoryStore(),
          installSalt: deps.installSalt,
          groupingKey: groupingKeyOf(deps.installSalt),
          originOf: dailyOrigins(state),
          summaries: shared === undefined ? undefined : sharedSummaries(shared),
        };
  const routeDeps: RouteDeps = {
    sourcesFor:
      deps.sourcesFor ??
      ((config, tokens) =>
        sourcesFromConfig(config, {
          tokens,
          state,
          openSubtitlesAppKey: deps.openSubtitlesAppKey,
          openSubtitlesDailyDownloads: deps.openSubtitlesDailyDownloads,
        })),
    refKey: refKey(deps.secret),
    publicURL: deps.publicURL,
    state,
    singleFlight: shared === undefined ? memorySingleFlight() : sharedSingleFlight(shared),
    subtitles: shared === undefined ? undefined : subtitleCache(shared),
    clientKey,
    openTimings,
    defer: deps.defer ?? detached,
  };

  app.notFound((context) => context.text("Not found", 404));

  app.onError((error, context) => {
    console.error(`${error.name} on ${context.req.routePath}`);

    return error instanceof HTTPException
      ? error.getResponse()
      : context.json({ error: failedMessage }, 500);
  });

  app.get("/health", (context) => context.json({ ok: true }));

  if (deps.staticFiles !== undefined) {
    app.use(deps.staticFiles);
  }

  app.get("/", (context) => context.html(homePage(deps.analytics)));
  app.get("/stremio", (context) => context.html(setupPage(deps.analytics)));
  app.get("/check", (context) => context.html(checkPage(deps.analytics)));
  app.get("/timings", async (context) => {
    const stats =
      openTimings === undefined
        ? undefined
        : await cachedStats(openTimings.store, state, routeDeps.singleFlight).catch(
            () => undefined,
          );

    return context.html(timingsPage(stats, deps.analytics));
  });
  app.use("/api/v1/*", cors());
  app.use(
    "/api/*",
    async (context, next) => {
      const json = context.req.header("content-type")?.toLowerCase().startsWith("application/json");

      if (context.req.method === "POST" && json !== true) {
        return context.json({ error: notJSONMessage }, 415);
      }

      await next();
    },
    (context, next) =>
      (context.req.path.startsWith("/api/v1/") ? timingsBody : apiBody)(context, next),
  );
  app.post("/api/config", createConfigRoute(deps));
  app.post("/api/config/open", openConfigRoute(deps));
  app.post(
    "/api/sources/check",
    sourceCheckRoute({
      allow: failOpen(rateLimit(state, limitKey, "sources", 10, 60_000)),
      clientKey,
    }),
  );
  app.post(
    "/api/check",
    checkRoute({
      ...routeDeps,
      secret: deps.secret,
      allow: failOpen(rateLimit(state, limitKey, "check", 10, 60_000)),
    }),
  );
  app.get("/api/titles", titlesRoute(titleLimit));
  app.get("/api/titles/:id/episodes", episodesRoute(titleLimit));

  if (openTimings !== undefined) {
    const timingsDeps = {
      ...openTimings,
      allow: rateLimit(state, limitKey, "writes", writesPerHour, hourMs),
      clientKey,
    };

    app.get(
      "/api/v1/stats",
      statsRoute({
        store: openTimings.store,
        state,
        singleFlight: routeDeps.singleFlight,
        allow: failOpen(rateLimit(state, limitKey, "stats", 60, 60_000)),
        clientKey,
      }),
    );
    app.get("/api/v1/fixes", lookUpRoute(timingsDeps));
    app.get("/api/v1/fixes/:video/:id/cues", cuesRoute(timingsDeps));
    app.post("/api/v1/fixes", writeRoute(submitFix, timingsDeps));
    app.post("/api/v1/mismatches", writeRoute(submitMismatch, timingsDeps));
    app.post("/api/v1/reports", writeRoute(submitReport, timingsDeps));
  }

  app.get("/:config/configure", (context) => {
    const sealed = context.req.param("config");

    return context.redirect(
      sealedConfigPattern.test(sealed) ? `/stremio#config=${sealed}` : "/stremio",
    );
  });
  app.use("/:config/*", cors(), async (context, next) => {
    const token = context.req.param("config") ?? "";

    if (!sealedConfigPattern.test(token)) {
      return context.notFound();
    }

    try {
      context.set("config", unseal(token, deps.secret));
      context.set("tokens", tokenCacheFor(state, deps.secret, installKeyOf(token)));
    } catch (error) {
      const newer = error instanceof ConfigError && error.message === newerLinkMessage;

      return context.json({ error: newer ? newerLinkMessage : invalidLinkMessage }, 400);
    }

    await next();
  });

  app.get("/:config/manifest.json", (context) =>
    context.json({ ...manifest, logo: `${baseURL(context, deps.publicURL)}/logo.png` }),
  );
  app.get("/:config/subtitles/:type/:id", subtitlesRoute(routeDeps));
  app.get("/:config/subtitles/:type/:id/:extra", subtitlesRoute(routeDeps));
  app.get("/:config/sub/:file", fileRoute(routeDeps));

  return app;
}
