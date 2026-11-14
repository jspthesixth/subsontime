import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { ConfigError, type Config } from "./config/config.ts";
import { invalidLinkMessage, sealedConfigPattern, unseal } from "./config/seal.ts";
import { sourcesFromConfig, type SourceSet } from "./sources/from-config.ts";
import type { TokenCache } from "./sources/token-cache.ts";
import { fileRoute } from "./stremio/file-route.ts";
import { manifest } from "./stremio/manifest.ts";
import { refKey } from "./stremio/refs.ts";
import { subtitlesRoute } from "./stremio/subtitles-route.ts";
import { createConfigRoute, openConfigRoute } from "./web/config-route.ts";
import { homePage } from "./web/home-page.ts";
import { setupPage } from "./web/setup-page.ts";

export type AppDeps = {
  secret: string;
  tokens: TokenCache;
  openSubtitlesAppKey?: string;
  publicURL?: string;
  sourcesFor?: (config: Config) => SourceSet;
  staticFiles?: MiddlewareHandler;
};

export type AppEnv = { Variables: { config: Config } };

export type RouteDeps = {
  sourcesFor: (config: Config) => SourceSet;
  refKey: Buffer;
  publicURL?: string;
};

const newerLinkMessage = "This install link is from a newer version";

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const routeDeps: RouteDeps = {
    sourcesFor:
      deps.sourcesFor ??
      ((config: Config) =>
        sourcesFromConfig(config, {
          tokens: deps.tokens,
          openSubtitlesAppKey: deps.openSubtitlesAppKey,
        })),
    refKey: refKey(deps.secret),
    publicURL: deps.publicURL,
  };

  app.notFound((context) => context.text("Not found", 404));

  app.get("/health", (context) => context.json({ ok: true }));

  if (deps.staticFiles !== undefined) {
    app.use(deps.staticFiles);
  }

  app.get("/", (context) => context.html(homePage()));
  app.get("/stremio", (context) => context.html(setupPage()));
  app.post("/api/config", createConfigRoute(deps));
  app.post("/api/config/open", openConfigRoute(deps));

  app.use("/:config/*", cors(), async (context, next) => {
    const token = context.req.param("config") ?? "";

    if (!sealedConfigPattern.test(token)) {
      return context.notFound();
    }

    try {
      context.set("config", unseal(token, deps.secret));
    } catch (error) {
      const newer = error instanceof ConfigError && error.message === newerLinkMessage;

      return context.json({ error: newer ? newerLinkMessage : invalidLinkMessage }, 400);
    }

    await next();
  });

  app.get("/:config/manifest.json", (context) => context.json(manifest));
  app.get("/:config/subtitles/:type/:id", subtitlesRoute(routeDeps));
  app.get("/:config/subtitles/:type/:id/:extra", subtitlesRoute(routeDeps));
  app.get("/:config/sub/:file", fileRoute(routeDeps));

  return app;
}
