import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";

const newApp = (openSubtitlesAppKey?: string) =>
  createApp({
    secret: "a-test-secret-that-is-long-enough-1234",
    clientKey: (context) => context.req.header("x-test-client") ?? "none",
    openSubtitlesAppKey,
  });

const check = (app: ReturnType<typeof newApp>, body: unknown, ip = "203.0.113.7") =>
  app.request("/api/sources/check", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-client": ip },
    body: JSON.stringify(body),
  });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const stubFetch = (response: Response | Error) => {
  const fetchMock = vi.fn<typeof fetch>();

  if (response instanceof Error) {
    fetchMock.mockRejectedValue(response);
  } else {
    fetchMock.mockResolvedValue(response);
  }

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
};

const titlovi = { kind: "titlovi", username: "someone-secret", password: "hunter2-secret" };
const openSubtitles = {
  kind: "opensubtitles",
  username: "someone-secret",
  password: "hunter2-secret",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/sources/check", () => {
  it("accepts a Titlovi.com account the login takes", async () => {
    const fetchMock = stubFetch(
      json({ ExpirationDate: "2030-01-01T00:00:00", Token: "token", UserId: 7 }),
    );
    const response = await check(newApp(), titlovi);

    expect(await response.json()).toEqual({ ok: true });
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
      /^https:\/\/kodi\.titlovi\.com\/api\/subtitles\/gettoken\?/,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a Titlovi.com account the login refuses, without echoing it", async () => {
    stubFetch(json({ message: "Unauthorized" }, 401));

    const body = await (await check(newApp(), titlovi)).text();

    expect(JSON.parse(body)).toEqual({
      ok: false,
      error: "Titlovi.com did not accept this username and password.",
    });
    expect(body).not.toContain("someone-secret");
    expect(body).not.toContain("hunter2-secret");
  });

  it("signs in to OpenSubtitles with the app key", async () => {
    const fetchMock = stubFetch(json({ token: "token", base_url: "api.opensubtitles.com" }));
    const response = await check(newApp("app-key"), openSubtitles);
    const [url, init] = fetchMock.mock.calls[0] ?? [];

    expect(await response.json()).toEqual({ ok: true });
    expect(String(url)).toBe("https://api.opensubtitles.com/api/v1/login");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("api-key")).toBe("app-key");
    expect(JSON.parse(String(init?.body))).toEqual({
      username: "someone-secret",
      password: "hunter2-secret",
    });
  });

  it("signs in with a pasted username trimmed and the password as typed", async () => {
    const fetchMock = stubFetch(json({ token: "token" }));

    await check(newApp("app-key"), { ...openSubtitles, username: "someone-secret\t" });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      username: "someone-secret",
      password: "hunter2-secret",
    });
  });

  it("says OpenSubtitles refused the sign-in, without echoing it", async () => {
    stubFetch(json({ message: "Error, invalid username/password  ", status: 401 }, 401));

    const body = await (await check(newApp("app-key"), openSubtitles)).text();

    expect(JSON.parse(body)).toEqual({
      ok: false,
      error: "OpenSubtitles did not accept this username and password.",
    });
    expect(body).not.toContain("someone-secret");
    expect(body).not.toContain("hunter2-secret");
  });

  it("cannot check an OpenSubtitles account without an app key", async () => {
    const fetchMock = stubFetch(json({}));
    const response = await check(newApp(), openSubtitles);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "This source cannot be checked" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks a SubDL key with one English search for one film", async () => {
    const fetchMock = stubFetch(json({ status: false, error: "Invalid API key" }));
    const response = await check(newApp(), { kind: "subdl", apiKey: "subdl-key" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.subdl.com/api/v1/subtitles?api_key=subdl-key&imdb_id=tt0111161&languages=en&type=movie&subs_per_page=1",
    );
    expect(await response.json()).toEqual({
      ok: false,
      error: "SubDL did not accept this API key.",
    });
  });

  it("checks a SubSource key with one film search", async () => {
    const fetchMock = stubFetch(json({ success: true, data: [{ movieId: 1 }] }));
    const response = await check(newApp(), { kind: "subsource", apiKey: "subsource-key" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.subsource.net/api/v1/movies/search?searchType=imdb&imdb=tt0111161&type=movie",
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-api-key")).toBe(
      "subsource-key",
    );
    expect(await response.json()).toEqual({ ok: true });
  });

  it("says when the source cannot be reached", async () => {
    stubFetch(new Error("connect ECONNREFUSED"));

    const response = await check(newApp(), { kind: "subdl", apiKey: "subdl-key" });

    expect(await response.json()).toEqual({
      ok: false,
      error: "Could not reach SubDL right now. Try again.",
    });
  });

  it.each([
    ["SubDL", 503, "subdl"],
    ["SubDL", 429, "subdl"],
    ["SubSource", 500, "subsource"],
  ])("treats a %s answer of %i as an outage", async (name, status, kind) => {
    stubFetch(json({}, status));

    const response = await check(newApp(), { kind, apiKey: "some-key" });

    expect(await response.json()).toEqual({
      ok: false,
      error: `Could not reach ${name} right now. Try again.`,
    });
  });

  it.each([
    ["a 401", () => json({ success: false }, 401)],
    ["a 403", () => json({ success: false }, 403)],
    ["a body that is not a search result", () => json({ success: false })],
  ])("rejects a SubSource key on %s", async (_, response) => {
    stubFetch(response());

    const answer = await check(newApp(), { kind: "subsource", apiKey: "some-key" });

    expect(await answer.json()).toEqual({
      ok: false,
      error: "SubSource did not accept this API key.",
    });
  });

  it("refuses a source without credentials to check", async () => {
    const response = await check(newApp(), {
      kind: "stremio-addon",
      url: "https://opensubtitles-v3.strem.io/manifest.json",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "This source cannot be checked" });
  });

  it("refuses an empty key without calling the source", async () => {
    const fetchMock = stubFetch(json({}));
    const response = await check(newApp(), { kind: "subsource", apiKey: "" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Fill in every username, password and API key",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows ten checks a minute from one address and refuses the eleventh", async () => {
    const app = newApp();
    const statuses = [];

    for (const _ of Array.from({ length: 11 })) {
      statuses.push((await check(app, {})).status);
    }

    expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 400));
    expect(statuses[10]).toBe(429);
    expect((await check(app, {}, "198.51.100.9")).status).toBe(400);
  });
});
