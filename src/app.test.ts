import { expect, test } from "vitest";
import { createApp } from "./app.ts";
import { memoryTokenCache } from "./sources/token-cache.ts";

test("GET /health returns 200 and { ok: true }", async () => {
  const response = await createApp({ secret: "test-secret", tokens: memoryTokenCache() }).request(
    "/health",
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});
