import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { memoryTokenCache } from "../sources/token-cache.ts";
import { toStremioURL, toWebURL } from "./config-route.ts";

const app = createApp({
  secret: "a-test-secret-that-is-long-enough-1234",
  tokens: memoryTokenCache(),
});

const form = {
  languages: ["hrv"],
  bestOnly: true,
  timing: "auto",
  sources: [{ kind: "stremio-addon", url: "https://opensubtitles-v3.strem.io/manifest.json" }],
  extras: { hideMismatches: true },
};

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

type Created = { installURL: string; stremioURL: string; webURL: string };

const create = async (body: unknown) => (await (await post("/api/config", body)).json()) as Created;

describe("toStremioURL", () => {
  it("swaps the scheme for stremio", () => {
    expect(toStremioURL("https://subs.example.com/AbC_-12/manifest.json")).toBe(
      "stremio://subs.example.com/AbC_-12/manifest.json",
    );
  });

  it("keeps a port", () => {
    expect(toStremioURL("http://127.0.0.1:7000/AbC/manifest.json")).toBe(
      "stremio://127.0.0.1:7000/AbC/manifest.json",
    );
  });
});

describe("toWebURL", () => {
  it("passes the install link to Stremio Web", () => {
    expect(toWebURL("https://subs.example.com/AbC_-12/manifest.json")).toBe(
      "https://web.stremio.com/#/addons?addon=https%3A%2F%2Fsubs.example.com%2FAbC_-12%2Fmanifest.json",
    );
  });
});

describe("POST /api/config", () => {
  it("returns an install link whose manifest answers", async () => {
    const { installURL, stremioURL, webURL } = await create(form);
    const manifest = await app.request(new URL(installURL).pathname);

    expect(installURL).toMatch(/^http:\/\/localhost\/[A-Za-z0-9_-]{40,}\/manifest\.json$/);
    expect(stremioURL).toBe(toStremioURL(installURL));
    expect(webURL).toBe(toWebURL(installURL));
    expect(manifest.status).toBe(200);
  });

  it("builds the link from the public URL", async () => {
    const publicApp = createApp({
      secret: "a-test-secret-that-is-long-enough-1234",
      tokens: memoryTokenCache(),
      publicURL: "https://subs.example.com/",
    });
    const response = await publicApp.request("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    const { installURL } = (await response.json()) as Created;

    expect(installURL).toMatch(
      /^https:\/\/subs\.example\.com\/[A-Za-z0-9_-]{40,}\/manifest\.json$/,
    );
  });

  it("is never cached", async () => {
    const response = await post("/api/config", form);

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects an empty language list", async () => {
    const response = await post("/api/config", { ...form, languages: [] });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Choose at least one language" });
  });

  it("rejects a Titlovi.com account without a password and leaves the account out", async () => {
    const response = await post("/api/config", {
      ...form,
      sources: [{ kind: "titlovi", username: "secret-user-name", password: "" }],
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).not.toContain("secret-user-name");
    expect(JSON.parse(body)).toEqual({ error: "Fill in every username, password and API key" });
  });

  it("does not echo a password of the wrong type", async () => {
    const response = await post("/api/config", {
      ...form,
      sources: [{ kind: "titlovi", username: "someone", password: 918273645 }],
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).not.toContain("918273645");
    expect(body).not.toContain("someone");
  });

  it("does not echo a source that is not an object", async () => {
    const response = await post("/api/config", { ...form, sources: ["my-api-key-123"] });

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("my-api-key-123");
  });

  it("rejects a body that is not JSON", async () => {
    const response = await app.request("/api/config", { method: "POST", body: "{" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "These settings are not valid" });
  });

  it("ignores an install id sent by the client", async () => {
    const first = await create({ ...form, installId: "chosen" });
    const opened = await post("/api/config/open", { installURL: first.installURL });

    expect(((await opened.json()) as { installId: string }).installId).not.toBe("chosen");
  });
});

describe("POST /api/config/open", () => {
  it("returns the settings inside an install link", async () => {
    const withAccount = {
      ...form,
      languages: ["hrv", "eng"],
      sources: [...form.sources, { kind: "titlovi", username: "someone", password: "hunter2" }],
    };
    const { installURL } = await create(withAccount);
    const response = await post("/api/config/open", { installURL });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ version: 1, ...withAccount });
  });

  it("opens a stremio:// link too", async () => {
    const { stremioURL } = await create(form);
    const response = await post("/api/config/open", { installURL: stremioURL });

    expect(response.status).toBe(200);
  });

  it.each([
    [
      "a tampered link",
      (url: string) => {
        const sealed = new URL(url).pathname.split("/")[1] ?? "";
        const flipped = sealed[30] === "A" ? "B" : "A";

        return url.replace(sealed, `${sealed.slice(0, 30)}${flipped}${sealed.slice(31)}`);
      },
    ],
    ["text that is not a link", () => "not a link"],
    ["a link without a config", () => "https://subs.example.com/manifest.json"],
  ])("rejects %s", async (_, change) => {
    const { installURL } = await create(form);
    const response = await post("/api/config/open", { installURL: change(installURL) });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "This install link is not valid. Set up again.",
    });
  });
});
