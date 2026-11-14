import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { memoryTokenCache } from "../sources/token-cache.ts";

const app = createApp({
  secret: "a-test-secret-that-is-long-enough-1234",
  tokens: memoryTokenCache(),
});

describe.each(["/", "/stremio"])("GET %s", (path) => {
  it("returns an English HTML page with one h1 and the stylesheet", async () => {
    const response = await app.request(path);
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(page).toContain('<html lang="en">');
    expect(page.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(page).toMatch(/<link rel="stylesheet" href="\/styles\.css"/);
  });

  it("links only to pages that exist", async () => {
    const page = await (await app.request(path)).text();

    expect(page).not.toMatch(/href="\/(timings|integrations)/);
  });
});

describe("GET /stremio", () => {
  it("lists languages by their native names", async () => {
    const page = await (await app.request("/stremio")).text();

    expect(page).toMatch(/<li[^>]*data-code="hrv"[^>]*>\s*Hrvatski\s*<\/li>/);
    expect(page).toMatch(/<li[^>]*data-code="pob"[^>]*>\s*Português \(Brasil\)\s*<\/li>/);
    expect(page).not.toContain('data-code="ger"');
  });
});

describe("unknown paths", () => {
  it("returns 404 for a path that is neither a page nor an install link", async () => {
    expect((await app.request("/nope")).status).toBe(404);
  });
});
