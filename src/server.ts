import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

const port = Number(process.env["PORT"] ?? 7000);
const app = createApp({ secret: process.env["SECRET"] ?? "dev-secret" });

serve({ fetch: app.fetch, port });
