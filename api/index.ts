import { waitUntil } from "@vercel/functions";
import { createApp } from "../src/app.ts";
import { addressKey } from "../src/client-key.ts";
import { readSecret } from "../src/config/secret.ts";
import { sharedStateFrom } from "../src/jobs/shared-state.ts";
import { memoryStore, postgresStore } from "../src/timings/db.ts";
import { readInstallSalt } from "../src/timings/submitter.ts";

const databaseURL = process.env["DATABASE_URL"];

export default createApp({
  secret: readSecret(process.env),
  state: sharedStateFrom(process.env),
  openSubtitlesAppKey: process.env["OPENSUBTITLES_APP_KEY"] || undefined,
  publicURL: process.env["PUBLIC_URL"] || undefined,
  clientKey: (context) => addressKey(context.req.header("x-real-ip") ?? "unknown"),
  installSalt: readInstallSalt(process.env),
  timings: databaseURL ? postgresStore(databaseURL) : memoryStore(),
  defer: waitUntil,
});
