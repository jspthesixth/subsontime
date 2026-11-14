import { expect, test } from "vitest";
import { createApp } from "./app.ts";

test("GET /health returns 200 and { ok: true }", async () => {
  const response = await createApp({ secret: "test-secret" }).request("/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});
