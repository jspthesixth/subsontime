import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

const app = createApp({
  secret: "a-test-secret-that-is-long-enough-1234",
});

describe.each(["/", "/stremio", "/check"])("GET %s", (path) => {
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

describe("GET /check", () => {
  it("marks Check a file as the current page and labels the drop zone file input", async () => {
    const page = await (await app.request("/check")).text();

    expect(page).toMatch(/<a\s+class="nav-link"\s+href="\/check"\s+aria-current="page"/);
    expect(page).toMatch(/<label class="drop"[^>]*>[\s\S]*<input[^>]*type="file"[\s\S]*<\/label>/);
    expect(page).toContain('<script type="module" src="/client/check.js"></script>');
  });
});

describe("unknown paths", () => {
  it("returns 404 for a path that is neither a page nor an install link", async () => {
    expect((await app.request("/nope")).status).toBe(404);
  });
});
