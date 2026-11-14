import { handle } from "hono/vercel";
import { createApp } from "../src/app.ts";

export default handle(createApp({ secret: process.env["SECRET"] ?? "" }));
