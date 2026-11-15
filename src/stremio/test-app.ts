import { createApp, type AppDeps } from "../app.ts";
import type { Config } from "../config/config.ts";
import { defaultConfig } from "../config/default-config.ts";
import { seal } from "../config/seal.ts";
import type { SourceSet } from "../sources/from-config.ts";
import { fakeSource } from "../sources/test-sources.ts";
import { syntheticTrack, transform } from "../timing/test-tracks.ts";
import { memoryStore, type TimingsStore } from "../timings/db.ts";
import { submitterOf } from "../timings/submitter.ts";

export type Listing = { subtitles: { id: string; lang: string; url: string }[] };

export type App = ReturnType<typeof createApp>;

export const secret = "a-test-secret-that-is-long-enough-1234";
export const installSalt = "an-install-salt-that-is-long-enough-5678";
export const video = { hash: "0123456789abcdef", size: 1_234_567 };
export const track = syntheticTrack(1, 200);
export const shifted = transform(track, (time) => time + 2000);
export const budgetMs = 300;
const extras = `videoHash=${video.hash}&videoSize=${video.size}`;

export const hanging = (): Promise<never> => new Promise(() => {});

export const appWith = (
  sources: SourceSet,
  store: TimingsStore = memoryStore(),
  deps: Partial<AppDeps> = {},
) =>
  createApp({
    secret,
    installSalt,
    timings: store,
    sourcesFor: () => sources,
    clientKey: (context) => context.req.header("x-test-client") ?? "client-a",
    ...deps,
  });

export const installed = (overrides: Partial<Config> = {}) => {
  const config = { ...defaultConfig(["eng"]), ...overrides };

  return {
    config,
    token: seal(config, secret),
    submitter: submitterOf(config.installId, installSalt),
  };
};

export const firstURL = async (app: App, token: string, more = "") => {
  const listing = await app.request(`/${token}/subtitles/movie/tt0111161/${extras}${more}.json`);
  const { subtitles } = (await listing.json()) as Listing;

  return subtitles[0]?.url ?? "";
};

export const retimedSources = () => ({
  listed: [fakeSource("Fake", [{ ref: "a", cues: shifted }])],
  references: [fakeSource("Reference", [{ ref: "r", hashMatch: true, cues: track }])],
});
