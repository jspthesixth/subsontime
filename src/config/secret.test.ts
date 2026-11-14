import { expect, test } from "vitest";
import { readSecret } from "./secret.ts";

test("readSecret throws when SECRET is missing", () => {
  expect(() => readSecret({})).toThrow("SECRET must be set to at least 32 characters");
});

test("readSecret throws when SECRET is 31 characters", () => {
  expect(() => readSecret({ SECRET: "a".repeat(31) })).toThrow(
    "SECRET must be set to at least 32 characters",
  );
});

test("readSecret returns SECRET when it is 32 characters", () => {
  const secret = "a".repeat(32);

  expect(readSecret({ SECRET: secret })).toBe(secret);
});
