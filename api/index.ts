import { handle } from "hono/vercel";
import { createApp } from "../src/app.ts";
import { readSecret } from "../src/config/secret.ts";

export default handle(createApp({ secret: readSecret(process.env) }));
