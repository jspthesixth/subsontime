import { Hono } from "hono";
import { cors } from "hono/cors";
import { ConfigError, type Config } from "./config/config.ts";
import { unseal } from "./config/seal.ts";
import { sourcesFromConfig, type SourceSet } from "./sources/from-config.ts";
import type { TokenCache } from "./sources/token-cache.ts";
import { fileRoute } from "./stremio/file-route.ts";
import { manifest } from "./stremio/manifest.ts";
import { subtitlesRoute } from "./stremio/subtitles-route.ts";

export type AppDeps = {
  secret: string;
  tokens: TokenCache;
  openSubtitlesAppKey?: string;
  sourcesFor?: (config: Config) => SourceSet;
};

export type AppEnv = { Variables: { config: Config } };

const invalidLinkMessage = "This install link is not valid. Set up again.";
const newerLinkMessage = "This install link is from a newer version";

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const sourcesFor =
    deps.sourcesFor ??
    ((config: Config) =>
      sourcesFromConfig(config, {
        tokens: deps.tokens,
        openSubtitlesAppKey: deps.openSubtitlesAppKey,
      }));

  app.get("/health", (context) => context.json({ ok: true }));

  app.use("/:config/*", cors(), async (context, next) => {
    try {
      context.set("config", unseal(context.req.param("config") ?? "", deps.secret));
    } catch (error) {
      const newer = error instanceof ConfigError && error.message === newerLinkMessage;

      return context.json({ error: newer ? newerLinkMessage : invalidLinkMessage }, 400);
    }

    await next();
  });

  app.get("/:config/manifest.json", (context) => context.json(manifest));
  app.get("/:config/subtitles/:type/:id", subtitlesRoute(sourcesFor));
  app.get("/:config/subtitles/:type/:id/:extra", subtitlesRoute(sourcesFor));
  app.get("/:config/sub/:file", fileRoute(sourcesFor));

  return app;
}
