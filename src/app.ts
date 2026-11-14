import { Hono } from "hono";

export type AppDeps = {
  secret: string;
};

export function createApp(_deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (context) => context.json({ ok: true }));

  return app;
}
