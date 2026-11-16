import { waitUntil } from "@vercel/functions";
import { appDepsOf, createApp } from "../src/app.ts";
import { addressKey } from "../src/client-key.ts";
import { readEnvironment } from "../src/config/env.ts";

export default createApp({
  ...appDepsOf(readEnvironment(process.env)),
  clientKey: (context) => addressKey(context.req.header("x-real-ip") ?? "unknown"),
  defer: waitUntil,
});
