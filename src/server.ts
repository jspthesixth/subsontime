import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { readSecret } from "./config/secret.ts";

const port = Number(process.env["PORT"] ?? 7000);
const app = createApp({ secret: readSecret(process.env) });

serve({ fetch: app.fetch, port });
