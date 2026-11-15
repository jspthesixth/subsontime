import { waitUntil } from "@vercel/functions";
import { createApp } from "../src/app.ts";
import { addressKey } from "../src/client-key.ts";
import { readEnvironment } from "../src/config/env.ts";
import { sharedStateFrom } from "../src/jobs/shared-state.ts";
import { memoryStore, postgresStore } from "../src/timings/db.ts";

const { server, secrets, sources, database, sharedState } = readEnvironment(process.env);

export default createApp({
  secret: secrets.secret,
  state: sharedStateFrom(sharedState),
  openSubtitlesAppKey: sources.openSubtitlesAppKey,
  publicURL: server.publicURL,
  clientKey: (context) => addressKey(context.req.header("x-real-ip") ?? "unknown"),
  installSalt: secrets.installSalt,
  timings: database.url ? postgresStore(database.url) : memoryStore(),
  defer: waitUntil,
  analytics: server.onVercel,
});
