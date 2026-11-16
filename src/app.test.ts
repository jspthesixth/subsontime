import { afterEach, expect, test, vi } from "vitest";
import { appDepsOf, createApp } from "./app.ts";
import { defaultConfig } from "./config/default-config.ts";
import { readEnvironment } from "./config/env.ts";
import { seal } from "./config/seal.ts";

const secret = "a-test-secret-that-is-long-enough-1234";
const environment = { SECRET: secret, INSTALL_SALT: "an-install-salt-that-is-long-enough-5678" };

afterEach(() => {
  vi.restoreAllMocks();
});

test("GET /health returns 200 and { ok: true }", async () => {
  const response = await createApp({ secret: "test-secret" }).request("/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});

test("an unexpected error logs only its name and route pattern", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const app = createApp({
    secret,
    sourcesFor: () => {
      throw new Error("a message that may hold a link");
    },
  });
  const sealed = seal(defaultConfig(["eng"]), secret);
  const response = await app.request(`/${sealed}/subtitles/movie/tt0111161.json`);

  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Something went wrong" });
  expect(log.mock.calls).toEqual([["Error on /:config/subtitles/:type/:id"]]);
});

test("passes the OpenSubtitles download budget from the environment", () => {
  expect(
    appDepsOf(readEnvironment({ ...environment, OPENSUBTITLES_DAILY_DOWNLOADS: "2" }))
      .openSubtitlesDailyDownloads,
  ).toBe(2);
});

test.each([
  [{}, false],
  [{ TRUST_PROXY: "1" }, true],
  [{ VERCEL: "1" }, true],
])("trusts forwarded headers with %o: %s", (env, trusted) => {
  expect(appDepsOf(readEnvironment({ ...environment, ...env })).trustProxy).toBe(trusted);
});
